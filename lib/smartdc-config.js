/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
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
    });
}

function sysinfo(callback) {
    execFileParseJSON('/usr/bin/sysinfo', [], function (error, config) {
        if (error) {
            callback(error);
            return;
        }
        callback(null, config);
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
    });
}

function getFirstAdminIp(callback) {
    sysinfo(function (err, sysinfoObj) {
        if (err) {
            callback(err);
            return;
        }

        var interfaces = sysinfoObj['Network Interfaces'];

        var adminifaces = Object.keys(interfaces).filter(function (iface) {
            return interfaces[iface]['NIC Names'].indexOf('admin') !== -1;
        });

        if (adminifaces && adminifaces.length) {
            callback(null, interfaces[adminifaces[0]]['ip4addr']);
        } else {
            callback(new Error('No admin NIC found in compute node sysinfo'));
        }
    });
}

module.exports = {
    getFirstAdminIp: getFirstAdminIp,
    sdcConfig: sdcConfig,
    sysinfo: sysinfo
};
