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
 * Common functions that don't belong anywhese else.
 *
 */

var execFile = require('child_process').execFile;
var fs = require('fs');

var async = require('async');


function modifyConfig(configPath, key, value, callback) {
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

        fs.writeFile(configPath, out.join('\n'), 'utf8', function (writeError) {
            callback(writeError);
        });
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
    modifyConfig: modifyConfig,
    provisionInProgressFile: provisionInProgressFile
};
