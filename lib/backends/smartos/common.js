/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 *
 * Common functions that don't belong anywhese else.
 *
 */

var assert = require('assert-plus');
var execFile = require('child_process').execFile;
var fs = require('fs');

var verror = require('verror');

var FIELDS = 'zoneid:zonename:state:zonepath:uuid:brand:ip-type'.split(':');

function parseZoneList(data) {
    var zones = {};
    var lines = data.trim().split('\n');
    var i = lines.length;
    var j;
    var zone;
    var fieldsLength = FIELDS.length;

    while (i--) {
        var lineParts = lines[i].split(':');
        var zoneName = lineParts[1];
        j = fieldsLength;
        zones[zoneName] = zone = {};

        while (j--) {
            zone[FIELDS[j]] = lineParts[j];
        }
    }

    return zones;
}

function zoneList(name, callback) {
    var args = [ 'list', '-pc' ];

    if (name) {
        args.push(name);
    }

    execFile('/usr/sbin/zoneadm', args, function (error, stdout, stderr) {
        if (error) {
            return callback(error);
        }
        return callback(null, parseZoneList(stdout));
    });
}

function modifyConfig(configPath, key, value, callback) {
    var newConfig;
    var out = [];
    var found = false;

    fs.readFile(configPath, 'utf8', function (error, data) {
        data.toString().split('\n').forEach(function (l) {
            var idx = l.indexOf('=');
            var lk = l.slice(0, idx);

            if (lk === 'overprovision_ratio') {
                found = true;
                out.push('overprovision_ratio=\''+value+'\'');
            } else {
                out.push(l);
            }
        });

        if (!found) {
            out.push('overprovision_ratio=\''+value+'\'');
        }

        newConfig = out.join('\n') + '\n';

        fs.writeFile(configPath, newConfig, 'utf8', function (writeError) {
            callback(writeError);
        });
    });
}

function zoneadm(zone, addtlArgs, opts, callback) {
    assert.uuid(zone, 'zone');
    assert.arrayOfString(addtlArgs, 'addtlArgs');
    assert.object(opts.log, 'opts.log');
    assert.func(callback, 'callback');

    var args = ['-z', zone];
    args.push.apply(args, addtlArgs);
    execFile('/usr/sbin/zoneadm', args, { encoding: 'utf8' },
        function (error, stderr, stdout) {
            if (error) {
                if (stderr) {
                    opts.log.warn('zoneadm stderr: %s',
                        stderr.toString().trim());
                }

                callback(
                    new verror.WError(
                        error,
                        'Error running zoneadm '
                        + addtlArgs.join(' ')
                        + ' on zone'));
                return;
            }
            callback();
            return;
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

    var expiresAt;
    var filename = '/var/tmp/machine-provision-' + uuid;
    var timeoutMinutes = 10;

    function callbackWhenComplete() {
        fs.stat(filename, function (err, stats) {
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

            // The provisioning file still exists - give it at least 10 minutes
            // from when provisioning was started to complete the provisioning
            // process.
            if (!expiresAt) {
                expiresAt = timeoutMinutes * 60 * 1000 + Number(stats.ctime);
            }

            // Check if we exceeded the timeout duration.
            now = Number(new Date());
            if (now > expiresAt) {
                // Expired, so consider provision complete and delete the file,
                // ignoring any delete error.
                fs.unlink(filename, function () {
                    callback();
                });
                return;
            }

            // Not expired yet, so try again in 1 second.
            setTimeout(callbackWhenComplete, 1 * 1000);
        });
    }

    callbackWhenComplete();
}

function wrapCallbackForTracing(span, name, cb) {
    var self = this;
    var newSpan;

    if (!span || !name) {
        return cb;
    }

    newSpan = span._tracer.startSpan(name, {
        childOf: span._context
    });

    newSpan.log({event: 'local-begin'});

    // TODO: this is needed lots of places, add to the tracer
    return function _traceWrappedCallback() {
        var tags = {};

        if (arguments[0]) {
            // error
            tags.error = true;
            tags.errCode = arguments[0].code;
            tags.errMsg = arguments[0].message;
        }
        newSpan.log({event: 'local-end'});

        newSpan.addTags(tags);
        newSpan.finish();

        cb.apply(self, arguments);
    };
}

module.exports = {
    ensureProvisionComplete: ensureProvisionComplete,
    modifyConfig: modifyConfig,
    provisionInProgressFile: provisionInProgressFile,
    wrapCallbackForTracing: wrapCallbackForTracing,
    zoneList: zoneList,
    zoneadm: zoneadm
};
