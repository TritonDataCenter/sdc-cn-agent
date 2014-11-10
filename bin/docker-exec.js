/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var net = require('net');
var createDockerStdioServer =
    require('../lib/docker-stdio-server').createDockerStdioServer;

var SERVER_CLOSE_TIMEOUT = 5000;

process.on('message', function (message) {
    var command = message.command;
    var uuid = message.uuid;

    var opts = {
        command: message.command,
        uuid: message.uuid,
        timeoutSeconds: 5
    };

    var server = createDockerStdioServer(opts);
    process.send({ port: server.address().port });
});

