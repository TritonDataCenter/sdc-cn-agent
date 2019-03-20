/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * Overview: Reboots the server in a manner similar to what ur-agent does when
 * a script has exited with code 113.
 *
 */

var execFile = require('child_process').execFile;

function main() {
    execFile(
        '/usr/sbin/shutdown',
        ['-y', '-g', '0', '-i', '6'],
        function (error, stdout, stderr) {
            if (error) {
                throw new Error(stderr.toString());
            }
            setTimeout(function () {
                console.error('reboot-server.js forcing reboot');
                forceReboot();
            }, 5 * 60 * 1000);
        });
}

function forceReboot() {
    execFile(
        '/usr/sbin/reboot',
        [],
        function () {
            // Wait for reboot
        });
}
