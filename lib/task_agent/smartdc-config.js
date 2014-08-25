/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var execFile = require('child_process').execFile;

function execFileParseJSON(bin, args, callback) {
    execFile(bin, args, function (error, stdout, stderr) {
        if (error) {
            callback(Error(stderr.toString()));
            return;
        }
        var obj = JSON.parse(stdout.toString());
        callback(null, obj);
        return;
    });
}

function sysinfo(callback) {
    execFileParseJSON('/usr/bin/sysinfo', [], function (error, config) {
        if (error) {
            callback(error);
            return;
        }
        callback(null, config);
        return;
    });
}

function sdcConfig(callback) {
    var args = ['/lib/sdc/config.sh', '-json'];
    execFileParseJSON('/bin/bash', args, function (error, config) {
        if (error) {
            callback(error);
            return;
        }
        callback(null, config);
        return;
    });
}

module.exports = {
    sdcConfig: sdcConfig,
    sysinfo: sysinfo,
    execFileParseJSON: execFileParseJSON
};
