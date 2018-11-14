/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 *
 * Common functions that don't belong anywhere else.
 *
 */

var child_process = require('child_process');
var execFile = child_process.execFile;
var fs = require('fs');
var path = require('path');

var assert = require('assert-plus');
var vasync = require('vasync');

var mockcloudRoot;
try {
    mockcloudRoot = child_process
        .execSync('/usr/sbin/mdata-get mockcloudRoot', {encoding: 'utf8'})
        .trim();
} catch (err) {
    // The old default for backward compatibility.
    mockcloudRoot = '/opt/custom/virtual';
    console.warn('warning: cn-agent dummy backend could not get ' +
        '"mockcloudRoot" dir from mdata, using default %s: %s',
        mockcloudRoot, err);
}
var SERVER_ROOT = mockcloudRoot + '/servers';


// These are used for caching the results of mdata-get so we don't need to
// re-run that for every server when we have multiple servers.
var cachedDatacenterName;
var cachedDNSDomain;


function mdataGet(key, callback) {
    assert.string(key, 'key');
    assert.func(callback, 'callback');

    child_process.execFile('/usr/sbin/mdata-get', [
        key
    ], function _onMdata(err, stdout, stderr) {
        assert.ifError(err, 'mdata-get should always work');

        callback(null, stdout.trim());
    });
}

function getPlatformBuildstamp(callback) {
    child_process.execFile('/usr/bin/uname', [
        '-v'
    ], function _onUname(err, stdout, stderr) {
        assert.ifError(err, 'uname should always work');

        var buildstamp = (stdout.trim().split('_'))[1];

        callback(null, buildstamp);
    });
}

function provisionInProgressFile(uuidOrZonename, callback) {
    var filename = '/var/tmp/machine-provision-' + uuidOrZonename;

    fs.writeFile(filename, '', function (error) {
        return callback(error, filename);
    });
}

function ensureProvisionComplete(uuid, callback) {
    assert.uuid(uuid, 'uuid');
    assert.func(callback, 'callback');

    var filename = '/var/tmp/machine-provision-' + uuid;
    var timeoutMinutes = 10;

    function callbackWhenComplete() {
        fs.stat(filename, function (err, stats) {
            var expiresAt;
            var now;

            if (err) {
                if (err.code === 'ENOENT') {
                    // File is gone, provision is complete.
                    callback();
                    return;
                }
                // We don't know, something is wrong.
                callback(err);
                return;
            }

            expiresAt = timeoutMinutes * 60 * 1000 + stats.ctime;
            now = Date.now();

            if (now > expiresAt) {
                // Expired, so consider provision complete and delete file.
                fs.unlink(filename, function () {
                    callback();
                    return;
                });
            } else {
                // Not expired yet, so try again in 1 second.
                setTimeout(checkIfReady, 1000);
            }
        });
    }

    callbackWhenComplete();
}

function getSdcConfig(callback) {
    var config = {};

    if (cachedDatacenterName !== undefined && cachedDNSDomain !== undefined) {
        callback(null, {
            datacenter_name: cachedDatacenterName,
            dns_domain: cachedDNSDomain
        });
        return;
    }

    mdataGet('sdc:datacenter_name', function _onDC(dcErr, datacenter) {
        if (dcErr) {
            callback(dcErr);
            return;
        }

        config.datacenter_name = datacenter;

        mdataGet('dnsDomain', function _onDomain(domErr, dnsDomain) {
            if (domErr) {
                callback(domErr);
                return;
            }

            config.dns_domain = dnsDomain;

            // Since we succeeded, cache these values.
            cachedDatacenterName = datacenter;
            cachedDNSDomain = dnsDomain;

            callback(null, config);
        });
    });
}

function getAgent(opts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.agentsDir, 'opts.agentsDir');
    assert.string(opts.subDir, 'opts.subDir');
    assert.func(callback, 'callback');

    var agent = {
        name: opts.subDir // might be replaced if we have a package.json
    };
    var agentDir;

    agentDir = path.join(opts.agentsDir, opts.subDir);

    function _getUuidFile(filename, key, cb) {
        var fn = path.join(agentDir, filename);

        fs.readFile(fn, function _readFile(err, data) {
            if (err) {
                if (err.code === 'ENOENT') {
                    cb();
                } else {
                    cb(err);
                }
                return;
            }

            agent[key] = data.toString().trim();
            assert.uuid(agent[key], 'agent.' + key);

            cb();
        });
    }

    vasync.pipeline({funcs: [
        function _getImageUuid(_, cb) {
            _getUuidFile('image_uuid', 'image_uuid', cb);
        },
        function getInstanceUuid(_, cb) {
            _getUuidFile('instance_uuid', 'uuid', cb);
        },
        function getPackageJSON(_, cb) {
            var fn = path.join(agentDir, 'package.json');
            var pkgJSON;

            fs.readFile(fn, function _readFile(err, data) {
                if (err) {
                    if (err.code === 'ENOENT') {
                        cb();
                    } else {
                        cb(err);
                    }
                    return;
                }

                // This might blow up, but that's a programmer error since we
                // wrote these files. They should be valid JSON.
                pkgJSON = JSON.parse(data.toString());

                if (pkgJSON.name) {
                    agent.name = pkgJSON.name;
                }
                if (pkgJSON.version) {
                    agent.version = pkgJSON.version;
                }

                cb();
            });
        }
    ]}, function gotAgent(err) {
        callback(err, agent);
    });
}

//
// getAgents() looks at files in SERVER_ROOT/opts.serverUuid/agents and calls
// callback with:
//
//  callback(err, agents);
//
// where err is an error object or null. And when err is null, agents is an
// array that looks like:
//
//  [
//      {
//          "image_uuid": "<image_uuid>",
//          "name": "net-agent",
//          "uuid": "<instance_uuid>",
//          "version": "2.2.0"
//      },
//      ...
//  ]
//
//
function getAgents(opts, callback) {
    assert.object(opts, 'opts');
    assert.func(callback, 'callback');
    assert.uuid(opts.serverUuid, 'opts.serverUuid');

    var agents = [];
    var agentsDir = path.join(SERVER_ROOT, opts.serverUuid, 'agents');

    // Defined here so opts we need are in scope.
    function _getAgent(dir, cb) {
        getAgent({
            agentsDir: agentsDir,
            subDir: dir,
        }, function _onGetAgent(err, agent) {
            if (!err) {
                agents.push(agent);
            }
            cb(err);
        });
    }

    fs.readdir(agentsDir, function onReaddir(err, dirs) {
        if (err) {
            if (err.code === 'ENOENT') {
                callback(null, agents);
            } else {
                callback(err);
            }
            return;
        }

        vasync.forEachPipeline({
            func: _getAgent,
            inputs: dirs
        }, function gotAgents(err) {
            callback(err, agents);
        });
    });
}


module.exports = {
    ensureProvisionComplete: ensureProvisionComplete,
    getAgents: getAgents,
    getPlatformBuildstamp: getPlatformBuildstamp,
    getSdcConfig: getSdcConfig,
    mdataGet: mdataGet,
    provisionInProgressFile: provisionInProgressFile,
    SERVER_ROOT: SERVER_ROOT
};
