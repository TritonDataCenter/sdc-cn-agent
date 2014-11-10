/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */


// Sample requests:
//
// curl -i 10.99.99.7:1337 -X POST -d '{
//   "User": "",
//   "Privileged": false,
//   "Tty": true,
//   "Container": "96b594bd38ad",
//   "AttachStdin": false,
//   "AttachStderr": true,
//   "AttachStdout": true,
//   "Detach": false,
//   "Cmd": [
//     "ls",
//     "-la"
//   ]
// }' | json
//
// curl -i 10.99.99.7:1337 -X POST -d '{
//   "User": "",
//   "Privileged": false,
//   "Tty": true,
//   "Container": "96b594bd38ad",
//   "AttachStdin": true,
//   "AttachStderr": true,
//   "AttachStdout": true,
//   "Detach": false,
//   "Cmd": [
//     "/bin/sh"
//   ]
// }' | json
//
//
// Run the servers:
//
// - /usr/node/bin/node console.js
// - Then one of the curl commands above
// - Then from another terminal on the headnode:
//      telnet localhost 2376
//


var http = require('http');
var net = require('net');
var child_process = require('child_process');
var pty = require('pty.js');
var spawn = child_process.spawn;

var commands = {};
var STREAM_TYPES = {
    stdin: 0,
    stdout: 1,
    stderr: 2
};

function createDockerStdioServer(opts) {
    var command = opts.command;
    var timeoutSeconds = opts.timeoutSeconds;
    var uuid = opts.uuid;

    var tcpServer = net.createServer();

    // Close server is no connections are received within timeout window.
    var serverTimeout = setTimeout(function () {
        console.warn('Closing tcpServer after ' +
                     timeoutSeconds + ' seconds without connection');
        tcpServer.close();
    }, timeoutSeconds * 1000);

    tcpServer.on('connection', onConnection);
    tcpServer.listen(0);
    return tcpServer;

    function onConnection(socket) {
        clearTimeout(serverTimeout);

        socket.on('close', function () {
            tcpServer.close();
        });

        var container = uuid;
        var cmd = '/usr/sbin/zlogin';

        var args = [];

        if (command.AttachStdin && command.Tty) {
            args.push('-t', container);
            args = args.concat(command.Cmd);
            runContainerPtyCommand(command, cmd, args, socket);
        } else {
            args.push(container);
            args = args.concat(command.Cmd);
            runContainerCommand(command, cmd, args, socket);
        }
    }
}


/**
 * Write to docker-raw compatible streams
 */
function writeToDockerRawStream(type, stream, data) {
    var streamType = STREAM_TYPES[type];
    var messageSize = data.length;
    var message = new Buffer(8 + messageSize);

    message.writeUInt8(streamType, 0);
    message[1] = 0;
    message[2] = 0;
    message[3] = 0;
    message.writeUInt32BE(messageSize, 4);
    message.write(data.toString(), 8);
    stream.write(message);
}


function runContainerCommand(params, cmd, args, socket) {
    console.log('going to spawn: ' + cmd + ' ' + args.join(' '));

    var cmdSpawn = spawn(cmd, args);

    function write(streamType, stream, data) {
        if (params.Tty) {
            stream.write(data);
        } else {
            writeToDockerRawStream(streamType, stream, data);
        }
    }

    if (params.AttachStdin) {
        socket.on('data', function (data) {
            cmdSpawn.stdin.write(data);
        });
    }

    cmdSpawn.stdout.on('data', function (data) {
        write('stdout', socket, data);
    });

    cmdSpawn.stderr.on('data', function (data) {
        write('stderr', socket, data);
    });

    cmdSpawn.on('exit', function (code) {
        console.log('cmdSpawn %s exited with status code %s',
            params.Cmd.join(' '), code);
        socket.end();
    });

    cmdSpawn.on('close', function (code) {
        console.log('cmdSpawn %s closed with status code %s',
            params.Cmd.join(' '), code);
        socket.end();
    });

    cmdSpawn.on('error', function (error) {
        console.log('cmdSpawn threw an error %s', error.toString());
    });
}


function runContainerPtyCommand(params, cmd, args, socket) {
    console.log('going to pty spawn: ' + cmd + ' ' + args.join(' '));

    // No rows/columns for now
    var cmdSpawn = pty.spawn(cmd, args);

    socket.on('data', function (data) {
        cmdSpawn.write(data);
    });

    cmdSpawn.on('data', function (data) {
        socket.write(data);
    });

    cmdSpawn.on('exit', function (code) {
        console.log('cmdSpawn %s closed', params.Cmd.join(' '));
        socket.end();
    });

    cmdSpawn.on('close', function (code) {
        console.log('cmdSpawn %s closed', params.Cmd.join(' '));
        socket.end();
    });
}


module.exports = {
    createDockerStdioServer: createDockerStdioServer
};
