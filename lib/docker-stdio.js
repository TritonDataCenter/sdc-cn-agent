/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */


var assert = require('assert-plus');
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


function setupDockerExecution(opts, callback) {
    assert.object(opts.command, 'command');
    assert.number(opts.timeoutSeconds, 'timeoutSeconds');
    assert.string(opts.uuid, 'uuid');

    var command = opts.command;

    // If we have been instructed to spawn the process as "Detach" or
    // daemonized mode, we skip starting the stdio server and simply spawn the
    // process. If "Detach" was not specified, we create a doker stdio
    // server.
    if (command.Detach) {
        spawnProcess(opts);
        callback(null, {});
        return;
    } else {
        var server = createDockerStdioServer(opts);
        callback(null, { port: server.address().port });
        return;
    }
}


function spawnProcess(opts) {
    assert.object(opts.command, 'command');
    assert.number(opts.timeoutSeconds, 'timeoutSeconds');
    assert.string(opts.uuid, 'uuid');

    var socket = opts.socket;
    var command = opts.command;
    var uuid = opts.uuid;
    var container = uuid;
    var cmd = '/usr/sbin/zlogin';

    var args = [];

    if (command.Detach) {
        args.push(container);
        args = args.concat(command.Cmd);
        runContainerCommand(command, cmd, args);
    } else if (command.AttachStdin && command.Tty) {
        args.push('-t', container);

        args = args.concat(command.Cmd);
        runContainerPtyCommand(command, cmd, args, socket);
    } else {
        args.push(container);
        args = args.concat(command.Cmd);
        runContainerCommand(command, cmd, args, socket);
    }
}


function createDockerStdioServer(opts) {
    var timeoutSeconds = opts.timeoutSeconds;

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

        opts.socket = socket;

        socket.on('close', function () {
            tcpServer.close();
        });

        spawnProcess(opts);
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
    var cmdSpawn = spawn(cmd, args);

    if (socket) {
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
    }

    cmdSpawn.on('exit', function (code) {
        console.log('cmdSpawn %s exited with status code %s',
            params.Cmd.join(' '), code);
        tryEnd();
    });

    cmdSpawn.on('close', function (code) {
        console.log('cmdSpawn %s closed with status code %s',
            params.Cmd.join(' '), code);
        tryEnd();
    });

    cmdSpawn.on('error', function (error) {
        console.log('cmdSpawn threw an error %s', error.toString());
    });

    function tryEnd() {
        if (socket) {
            socket.end();
        }
    }

    function write(streamType, stream, data) {
        if (params.Tty) {
            stream.write(data);
        } else {
            writeToDockerRawStream(streamType, stream, data);
        }
    }
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
    createDockerStdioServer: createDockerStdioServer,
    runContainerCommand: runContainerCommand,
    setupDockerExecution: setupDockerExecution
};
