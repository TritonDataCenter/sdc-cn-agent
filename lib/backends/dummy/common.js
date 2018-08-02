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

var assert = require('assert-plus');
var async = require('async');

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
    var filename = '/var/tmp/machine-provision-' + uuid;
    var expiresAt;
    var timeoutMinutes = 10;

    function checkIfReady() {
        fs.exists(filename, function (exists) {
            if (!exists) {
                return callback();
            }

            return async.waterfall([
                function (wf$callback) {
                    if (!expiresAt) {
                        fs.stat(filename, function (error, stats) {
                            expiresAt =
                                timeoutMinutes * 60 * 1000 + stats.ctime;
                            return wf$callback(error);
                        });
                    }
                    return wf$callback();
                }
            ],
            function (error) {
                // Check if we exceeded the timeout duration.
                var now = Number(new Date());
                if (now > expiresAt) {
                    fs.unlink(filename, function () {
                        return callback();
                    });
                } else {
                    setTimeout(checkIfReady, 10 * 1000);
                }
            });
        });
    }

    checkIfReady();
}


module.exports = {
    ensureProvisionComplete: ensureProvisionComplete,
    getPlatformBuildstamp: getPlatformBuildstamp,
    mdataGet: mdataGet,
    provisionInProgressFile: provisionInProgressFile,
    SERVER_ROOT: SERVER_ROOT
};
