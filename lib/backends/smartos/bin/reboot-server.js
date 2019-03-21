#!/opt/smartdc/agents/lib/node_modules/cn-agent/node/bin/node
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

var bunyan = require('bunyan');

var log = bunyan.createLogger({name: 'reboot-server.js'});

function main() {
    execFile(
        '/usr/sbin/shutdown',
        ['-y', '-g', '0', '-i', '6'],
        function (error, stdout, stderr) {
            if (error) {
                log.error({
                    err: error,
                    stderr: stderr,
                    stdout: stdout
                }, '/usr/sbin/shutdown failed');
                throw new Error(stderr.toString());
            } else {
                log.info({
                    stderr: stderr,
                    stdout: stdout
                }, '/usr/sbin/shutdown');
            }
            setTimeout(function () {
                log.info('forcing reboot');
                forceReboot();
            }, 5 * 60 * 1000);
        });
}

function forceReboot() {
    console.log(' forcing reboot');
    execFile(
        '/usr/sbin/reboot',
        [],
        function (error, stdout, stderr) {
            if (error) {
                log.error({
                    err: error,
                    stderr: stderr,
                    stdout: stdout
                }, '/usr/sbin/reboot failed');
                throw new Error(stderr.toString());
            } else {
                log.info({
                    stderr: stderr,
                    stdout: stdout
                }, '/usr/sbin/reboot');
            }
            // Wait for reboot
        });
}

main();
