/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * Overview: Receiver process for migrating an instance.
 */

var child_process = require('child_process');
var fs = require('fs');
var net = require('net');
var util = require('util');

var assert = require('assert-plus');
var bunyan = require('bunyan');
var jsprim = require('jsprim');
var zfs = require('zfs').zfs;

var LineStream = require('lstream');
var smartDcConfig = require('../smartdc-config');


var SERVER_CLOSE_TIMEOUT = 60 * 1000; // 1 minute
var currentProgress = 0;
var gLog;
var stopProcess = false;
var tcpServer;
var totalProgress = 100;
var VERSION = '1.0.0';

/*
 * Setup logging streams.
 */
function setupLogging(action, req_id) {
    var logStreams = [];
    var logfile = util.format('%s/%s-%s-migrate_machine_receive_child.log',
        process.env.logdir, process.env.logtimestamp, process.pid);
    logStreams.push({path: logfile, level: 'debug'});

    // Keep last N log messages around - useful for debugging.
    var ringbuffer = new bunyan.RingBuffer({ limit: 100 });
    logStreams.push({
        level: 'debug',
        type: 'raw',
        stream: ringbuffer
    });

    // Create the logger.
    var log = bunyan.createLogger({
        name: 'migrate-receive-' + action,
        streams: logStreams,
        req_id: req_id
    });

    // Store an easy accessor to the ring buffer.
    log.ringbuffer = ringbuffer;

    gLog = log;

    return log;
}


function writeEvent(socket, event) {
    if (socket.destroyed) {
        gLog.warn({event: event}, 'writeEvent:: socket already destroyed');
        return;
    }
    gLog.debug({event: event}, 'write event');
    socket.write(JSON.stringify(event) + '\n');
}


function endServer() {
    stopProcess = true;
    tcpServer.close();
    gLog.info('endServer');
}


function endProcess(opts, event, socket) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(event, 'event');
    assert.object(socket, 'socket');

    endServer();

    var responseEvent = {
        type: 'response',
        command: event.command,
        eventId: event.eventId
    };

    writeEvent(socket, responseEvent);
    socket.destroy();
}


function commandStop(opts, event, socket) {
    assert.object(opts, 'opts');
    // assert.object(opts.log, 'opts.log');
    assert.object(event, 'event');
    assert.object(socket, 'socket');

    opts.log.info('commandStop');

    endProcess(opts, event, socket);
}


// Note: From this point on - anything received on this socket will be zfs send
// data.
function zfsSyncReceive(opts, event, socket) {
    assert.object(opts, 'opts');
    assert.object(opts.commandStream, 'opts.commandStream');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.payload, 'opts.payload');
    assert.object(opts.payload.vm, 'opts.payload.vm');
    assert.string(opts.payload.vm.zfs_filesystem,
        'opts.payload.vm.zfs_filesystem');
    assert.object(event, 'event');
    assert.object(socket, 'socket');

    var cmd = '/usr/sbin/zfs';
    var args = [
        'receive',
        '-s',
        opts.payload.vm.zfs_filesystem
    ];
    var log = opts.log;
    var output = {
        stdout: null,
        stderr: null
    };
    var responseEvent;

    // Disconnect the line stream reader.
    socket.unpipe(opts.commandStream);

    log.debug('zfsSyncReceive:: unpiped command stream');

    currentProgress = 0;

    log.debug({cmd: cmd, args: args}, 'zfsSyncReceive');

    var zfsReceive = child_process.spawn(cmd, args,
        {
            detached: true,
            // stdio: [socket, 'pipe', 'pipe']
            stdio: ['pipe', 'pipe', 'pipe']
        });

    zfsReceive.on('error', function (err) {
        log.error({
                exitCode: zfsReceive.exitCode,
                killed: zfsReceive.killed,
                signalCode: zfsReceive.signalCode
            },
            'zfs receive error: %s, stderr: %s', err, String(output.stderr));

        endServer();

        responseEvent = {
            type: 'error',
            command: event.command,
            eventId: event.eventId,
            message: 'zfs receive process error: ' + err,
            err: err,
            stderr: String(output.stderr)
        };
        writeEvent(socket, responseEvent);
    });

    zfsReceive.on('close', function (code) {
        log.info({
                // total_size: total_size,
                exitCode: zfsReceive.exitCode,
                killed: zfsReceive.killed,
                signalCode: zfsReceive.signalCode
            },
            'zfs receive closed with code: %s, stdout: %s\nstderr: %s\n',
            code, String(output.stdout), String(output.stderr));

        if (zfsReceive.killed) {
            responseEvent = {
                type: 'error',
                command: event.command,
                eventId: event.eventId,
                message: 'zfs receive process was killed',
                stderr: String(output.stderr)
            };
            writeEvent(socket, responseEvent);
            return;
        }

        if (code !== 0) {
            responseEvent = {
                type: 'error',
                command: event.command,
                eventId: event.eventId,
                message: 'zfs receive exited with code: ' + code,
                stderr: String(output.stderr)
            };
            writeEvent(socket, responseEvent);
            return;
        }

        responseEvent = {
            type: 'sync-success'
        };
        writeEvent(socket, responseEvent);

        endServer();
    });

    function storeLimitedOutput(type, buf) {
        // Only keep the first 2500 and last 2500 characters of stdout.
        if (output[type]) {
            output[type] = Buffer.concat([output[type], buf]);
        } else {
            output[type] = buf;
        }
        if (output[type].length > 5000) {
            output[type] = Buffer.concat([
                output[type].slice(0, 2500),
                Buffer.from('\n...\n'),
                output[type].slice(-2500)
            ]);
        }
    }

    zfsReceive.stdout.on('data', function (buf) {
        log.debug('zfsSyncReceive:: zfs receive stdout: ' + String(buf));
        storeLimitedOutput('stdout', buf);
    });

    zfsReceive.stderr.on('data', function (buf) {
        log.info('zfsSyncReceive:: zfs receive stderr: ' + String(buf));
        storeLimitedOutput('stderr', buf);
    });

    // All future socket data will be piped into zfs receive.
    socket.pipe(zfsReceive.stdin);

    // var through2 = require('through2');
    // var count = 0;
    // var total_size = 0;
    // var next_log_size = 1000;
    // socket.pipe(through2(function (chunk, enc, callback) {
    //     if (count < 10) {
    //         log.debug('chunk:', chunk);
    //         count += 1;
    //     }
    //     total_size += chunk.length;
    //     if (total_size > next_log_size) {
    //         log.debug('total_size:', total_size);
    //         next_log_size *= 2;
    //     }
    //     callback();
    // }))
    // .pipe(zfsReceive.stdin);

    // Inform the source process that we are all ready to go.
    responseEvent = {
        type: 'response',
        command: event.command,
        eventId: event.eventId
    };
    writeEvent(socket, responseEvent);
}


function commandSync(opts, event, socket) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.payload, 'opts.payload');
    assert.object(opts.payload.vm, 'opts.payload.vm');
    assert.string(opts.payload.vm.zfs_filesystem,
        'opts.payload.vm.zfs_filesystem');
    assert.object(event, 'event');
    assert.object(socket, 'socket');

    if (!event.isFirstSync) {
        zfsSyncReceive(opts, event, socket);
        return;
    }

    var log = opts.log;
    var responseEvent;
    var zonePath = util.format('/%s', opts.payload.vm.zfs_filesystem);

    // Check if the dataset exists.
    if (!fs.existsSync(zonePath)) {
        log.info({zonePath: zonePath}, 'Zone path does not exist');

        zfsSyncReceive(opts, event, socket);
        return;
    }

    var cmd = '/usr/sbin/zfs';
    var args = [
        'destroy',
        '-f',
        '-r',
        opts.payload.vm.zfs_filesystem
    ];

    log.debug({cmd: cmd, args: args},
        'commandSync - destroying existing dataset');

    child_process.execFile(cmd, args, function (error, stdout, stderr) {
        if (error) {
            log.error('zfs destroy error:', error, ', stderr:', String(stderr));

            responseEvent = {
                type: 'error',
                command: event.command,
                eventId: event.eventId,
                message: 'zfs destroy error: ' + error
            };
            writeEvent(socket, responseEvent);
            return;
        }

        zfsSyncReceive(opts, event, socket);
    });
}


/**
 * Retrieve the zfs resume token for the provided dataset.
 */
function commandGetZfsResumeToken(opts, event, socket) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.payload, 'opts.payload');
    assert.object(opts.payload.vm, 'opts.payload.vm');
    assert.string(opts.payload.vm.zfs_filesystem,
        'opts.payload.vm.zfs_filesystem');
    assert.object(event, 'event');
    assert.object(socket, 'socket');

    var log = opts.log;
    var responseEvent;
    var zonePath = util.format('/%s', opts.payload.vm.zfs_filesystem);

    // Check if the dataset exists.
    if (!fs.existsSync(zonePath)) {
        log.info({zonePath: zonePath}, 'Zone does not exist');

        responseEvent = {
            type: 'response',
            command: event.command,
            eventId: event.eventId
        };

        writeEvent(socket, responseEvent);
        return;
    }

    var cmd = '/usr/sbin/zfs';
    var args = [
        'get',
        '-Ho',
        'value',
        'receive_resume_token',
        opts.payload.vm.zfs_filesystem
    ];

    log.debug({cmd: cmd, args: args}, 'commandGetZfsResumeToken');

    child_process.execFile(cmd, args, function (error, stdout, stderr) {
        if (error) {
            log.error('zfs get error:', error, ', stderr:', String(stderr));

            responseEvent = {
                type: 'error',
                command: event.command,
                eventId: event.eventId,
                message: 'zfs get error: ' + error
            };
            writeEvent(socket, responseEvent);
            return;
        }

        var token = String(stdout).trim();

        log.debug({token: token}, 'commandGetZfsResumeToken:: got token');

        // A dash means there is no resume token.
        if (token === '-') {
            token = '';
        }

        responseEvent = {
            type: 'response',
            command: event.command,
            eventId: event.eventId,
            token: token
        };

        writeEvent(socket, responseEvent);
    });
}


function commandPing(opts, event, socket) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(event, 'event');
    assert.object(socket, 'socket');

    opts.log.debug('commandPing');

    var responseEvent = {
        type: 'response',
        command: event.command,
        eventId: event.eventId,
        pid: process.pid,
        version: VERSION
    };

    writeEvent(socket, responseEvent);
}


function commandNotImplemented(opts, event, socket) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(event, 'event');
    assert.object(socket, 'socket');

    opts.log.error({event: event}, 'Unimplemented command');

    var responseEvent = {
        type: 'error',
        command: event.command,
        eventId: event.eventId,
        message: 'Not Implemented',
        version: VERSION
    };

    writeEvent(socket, responseEvent);
}


function commandError(opts, event, socket) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(event, 'event');
    assert.object(socket, 'socket');

    opts.log.error({event: event}, 'Unknown command');

    var responseEvent = {
        type: 'error',
        command: event.command,
        eventId: event.eventId,
        message: 'Unknown command',
        version: VERSION
    };

    writeEvent(socket, responseEvent);
}


function onSocketCommand(opts, socket, line) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(socket, 'socket');
    assert.string(line, 'line');

    var event;
    var log = opts.log;

    log.debug('received command line: %j', line);

    try {
        event = JSON.parse(line);
    } catch (e) {
        log.error('Migrate-receive: invalid json: %s - ignoring', line);
        return;
    }

    switch (event.command) {
        case 'stop':
            commandStop(opts, event, socket);
            break;
        case 'ping':
            commandPing(opts, event, socket);
            break;
        case 'rate':
            commandNotImplemented(opts, event, socket);
            break;
        case 'status':
            commandNotImplemented(opts, event, socket);
            break;
        case 'get-zfs-resume-token':
            commandGetZfsResumeToken(opts, event, socket);
            break;
        case 'sync':
            commandSync(opts, event, socket);
            break;
        case 'switch':
            commandNotImplemented(opts, event, socket);
            break;
        // case 'abort':
        // case 'pause':
        default:
            commandError(opts, event, socket);
            break;
    }
}


function handleSocketConnection(opts, socket) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(socket, 'socket');

    var log = opts.log;

    log.info('got connection from', socket.address());

    socket.on('error', function _onSocketError(err) {
        log.warn('handleSocketConnection: socket.error', err);
    });

    socket.on('timeout', function _onSocketTimeout() {
        log.warn('handleSocketConnection: socket timeout');
        socket.destroy();
    });

    socket.on('end', function _onSocketEnd() {
        log.debug('handleSocketConnection: socket.end received');
    });

    // Read what the socket wants us to do.
    var commandStream = new LineStream();
    opts.commandStream = commandStream;
    socket.pipe(commandStream);

    commandStream.on('readable', function _commandStreamReadableCb() {
        var line = this.read();
        while (line) {
            onSocketCommand(opts, socket, line);
            line = this.read();
        }
    });
}


/**
 * Setup the tcp server and send back the process/server details.
 */
function setupMigrationServer(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.func(callback, 'callback');

    var log = opts.log;

    log.debug({payload: opts.payload}, 'migration payload');

    var onListening = function migrate_socket_onListening() {
        var addr = tcpServer.address();
        var response = {
            event: 'setup completed',
            host: opts.adminIp,
            pid: process.pid,
            port: addr.port
        };

        log.info('MigrationTask listening on socket %j', addr);

        callback(null, response);
    };

    log.info('MigrationTask setting up socket');

    /**
     * Create TCP Server which will output the build stream.
     */
    tcpServer = net.createServer({ allowHalfOpen: true });

    tcpServer.on('connection', function _onConnection(socket) {
        handleSocketConnection(opts, socket);
    });

    tcpServer.listen(0, opts.adminIp, onListening);
}


/*
 * Main entry point.
 */
process.on('message', function (message) {
    assert.object(message, 'message');
    assert.object(message.payload, 'payload');
    assert.object(message.payload.migrationTask, 'payload.migrationTask');
    assert.string(message.payload.migrationTask.action,
        'payload.migrationTask.action');
    assert.string(message.req_id, 'req_id');
    assert.optionalNumber(message.timeoutSeconds, 'timeoutSeconds');
    assert.string(message.uuid, 'uuid');

    var action = message.payload.migrationTask.action;  // 'sync' or 'switch'.
    assert.ok(action === 'sync' || action === 'switch',
        'Unknown action: ' + action);

    var log = setupLogging(action, message.req_id);

    var opts = {
        log: log,
        req_id: message.req_id,
        payload: message.payload,
        uuid: message.uuid,
        timeoutSeconds: message.timeoutSeconds || SERVER_CLOSE_TIMEOUT
    };

    // XXX: TODO: Remove TESTING hack.
    var vm = opts.payload.vm;
    vm.uuid = vm.uuid.slice(0, -6) + 'aaaaaa';
    vm.alias = vm.alias + '-aaaaaa';
    vm.zfs_filesystem = vm.zfs_filesystem.slice(0, -6) + 'aaaaaa';

    // This process will listen on the admin network, allowing a connection
    // from vmapi/workflow to control the process actions.
    smartDcConfig.getFirstAdminIp(function (aerr, adminIp) {
        if (aerr) {
            process.send({error: { message: aerr.message, aerr: aerr.stack }});
            return;
        }

        opts.adminIp = adminIp;

        setupMigrationServer(opts, function (err, response) {
            if (err) {
                process.send({error: { message: err.message, err: err.stack }});
                return;
            }

            process.send(response);
        });
    });
});
