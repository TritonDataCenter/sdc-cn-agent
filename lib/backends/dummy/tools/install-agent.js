/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

//
// Important: This is not intended to be run by humans. Use at your own risk.
//
// Usage: install-agent.js <serverUuid> <filename.[tgz|tar.gz|tar.bz2]>
//

var fs = require('fs');

var assert = require('assert-plus');
var bunyan = require('bunyan');

var shared = require('../tasks/shared');


function main() {
    var serverUuid = process.argv[2];
    var filename = process.argv[3];

    var logger = bunyan.createLogger({
        level: 'debug',
        name: 'install-agent.js'
    });

    // This is not for human use, so we'll do only the bare minimum of
    // validation.

    assert.uuid(serverUuid, 'serverUuid');
    assert.string(filename, 'filename');
    assert.equal(process.argv[4], undefined); // to ensure no extra args

    console.error('# Server: ' + serverUuid);
    console.error('# Filename: ' + filename);

    shared.installAgent({
        agentFile: filename,
        log: logger,
        serverUuid: serverUuid
    }, function onInstall(err) {
        if (err) {
            console.error('Failed to install agent: ' + err.message);
            console.log('FAILED');
            process.exitCode = 1;
            return;
        }

        console.log('SUCCESS');
    });
}

main();
