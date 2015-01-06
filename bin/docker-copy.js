/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var net = require('net');
var dockerstdio = require('../lib/docker-stdio');

var SERVER_CLOSE_TIMEOUT = 5;

process.on('message', function (message) {
    var command = message.command;
    var uuid = message.uuid;

    var opts = {
        command: command,
        uuid: message.uuid,
        timeoutSeconds: message.timeoutSeconds || SERVER_CLOSE_TIMEOUT
    };

    dockerstdio.setupDockerFileStream(opts, function (err, response) {
        process.send(response);
    });
});
