/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * Overview: Workhorse process for migrating an instance.
 */

var child_process = require('child_process');
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
var stopProcess = false;
var tcpServer;
var totalProgress = 100;
var VERSION = '1.0.0';
var watcher;

/*
 * Setup logging streams.
 */
function setupLogging(action, req_id) {
    var logStreams = [];
    var logfile = util.format('%s/%s-%s-migrate-machine-child.log',
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
        name: 'migrate-' + action,
        streams: logStreams,
        req_id: req_id
    });

    // Store an easy accessor to the ring buffer.
    log.ringbuffer = ringbuffer;

    return log;
}


function endProcess() {
    if (watcher) {
        watcher.end();
    }
    tcpServer.close();
}

function commandStop(opts, socket) {
    assert.object(opts, 'opts');
    // assert.object(opts.log, 'opts.log');
    assert.object(socket, 'socket');

    stopProcess = true;
    if (watcher) {
        watcher.stop();
    }
    tcpServer.close();
}

function commandSync(opts, socket) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(socket, 'socket');

    var log = opts.log;

    if (!watcher) {
        watcher = new Watcher(opts);
    }
    watcher.addSocket(socket);

    currentProgress = 0;
    totalProgress = 10;

    function oneSync() {
        // Check if we've been told to stop early.
        if (stopProcess) {
            log.info('sync command stopped because stopProcess is set');
            return;
        }
        // Check if the command is finished.
        if (currentProgress >= totalProgress) {
            log.info('sync command finished successfully - ending process');
            endProcess();
            return;
        }

        // socket.write(new Buffer('hello '));
        currentProgress += 1;

        setTimeout(oneSync, 1000);
    }

    oneSync(0);
}

function Watcher(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');

    this.log = opts.log;
    this.isRunning = false;
    this.lastProgress = -1;
    this.sockets = [];
}

Watcher.prototype.addSocket = function WatcherAdd(socket) {
    var self = this;

    if (self.sockets.indexOf(socket) !== -1) {
        // Socket is already added - nothing to do.
        return;
    }

    self.sockets.push(socket);

    socket.once('error', function _onSocketWatchError(err) {
        self.log.warn('Watcher:: socket error: ', err);
    });

    socket.once('close', function _onSocketWatchClose() {
        if (stopProcess || !self.isRunning) {
            // Do not fight with the stop/end calls.
            return;
        }
        var idx = self.sockets.indexOf(socket);
        if (idx >= 0) {
            self.sockets.splice(idx, 1);
            self.log.info({length: self.sockets.length},
                'Watcher:: socket close event received - removed');
        } else {
            self.log.error({socket: socket},
                'Watcher:: should not get a close event for an unknown socket');
        }
    });

    self.log.info({numWatchers: self.sockets.length},
        'Watcher:: added watcher socket');

    self.run();
};

Watcher.prototype.run = function WatcherRun() {
    var self = this;

    if (self.isRunning) {
        return;
    }

    self.isRunning = true;

    var loopCount = 0;

    function runLoop() {
        if (stopProcess) {
            self.log.info('Watcher:: stopped because stopProcess is set');
            return;
        }
        if (!self.isRunning) {
            self.log.info('Watcher:: stopped');
            return;
        }

        loopCount += 1;

        if (loopCount === 60) {
            loopCount = 0;
            self.sendProgress(true);
        } else {
            self.sendProgress(false);
        }

        setTimeout(runLoop, 1000);
    }

    runLoop();

    self.log.info('Watcher:: started');
};


Watcher.prototype.destroySockets = function WatcherDestroySockets() {
    this.log.debug('Watcher:: closing %d watcher sockets', this.sockets.length);
    this.sockets.forEach(function _endForEachSocket(socket) {
        socket.destroy();
    });
    this.sockets = [];
};

Watcher.prototype.stop = function WatcherStop() {
    this.log.info('Watcher:: stop');
    this.isRunning = false;

    var event = {
        type: 'stop',
        current: currentProgress,
        total: totalProgress
    };

    this.sendEvent(event);
    this.destroySockets();
};

Watcher.prototype.end = function WatcherEnd() {
    this.log.info('Watcher:: end');
    this.isRunning = false;

    var event = {
        type: 'end',
        current: currentProgress,
        total: totalProgress
    };

    this.log.info('Watcher:: sending end event to watchers');
    this.sendEvent(event);
    this.destroySockets();
};

Watcher.prototype.sendProgress = function WatcherSendProgress(isMinute) {
    // Send progress events when there has been progress made, or when there
    // has been no progress for a minute (just to keep the sockets alive).
    var progressMade = currentProgress !== this.lastProgress;

    if (isMinute || progressMade) {
        // Send a progress event.
        var event = {
            type: 'progress',
            current: currentProgress,
            total: totalProgress
        };
        this.lastProgress = currentProgress;
        this.sendEvent(event);
        if (progressMade) {
            this.log.debug({
                    currentProgress: currentProgress,
                    totalProgress: totalProgress
                }, 'Watcher:: sent progress event');
        }
    }
};

Watcher.prototype.sendEvent = function WatcherSendEvent(event) {
    var line = JSON.stringify(event) + '\n';

    this.sockets.forEach(function _sendEventForEachSocket(socket) {
        socket.write(line);
    });
};

function commandWatch(opts, socket) {
    assert.object(opts, 'opts');
    // assert.object(opts.log, 'opts.log');
    assert.object(socket, 'socket');

    if (!watcher) {
        watcher = new Watcher(opts);
    }
    watcher.addSocket(socket);
}

function commandPing(opts, socket) {
    assert.object(opts, 'opts');
    // assert.object(opts.log, 'opts.log');
    assert.object(socket, 'socket');

    var event = {
        type: 'pong',
        pid: process.pid,
        version: VERSION
    };
    var line = JSON.stringify(event) + '\n';

    socket.write(line);
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
        log.error('Build: invalid json: %s - ignoring', line);
        return;
    }

    switch (event.type) {
        case 'stop':
            commandStop(opts, socket);
            break;
        case 'ping':
            commandPing(opts, socket);
            break;
        case 'sync':
            commandSync(opts, socket);
            break;
        case 'switch':
            commandSync(opts, socket);
            break;
        case 'watch':
            commandWatch(opts, socket);
            break;
        // case 'abort':
        // case 'pause':
        default:
            log.error('Unhandled socket event - ignoring: %j', event);
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

    socket.on('end', function _onSocketEnd() {
        log.debug('handleSocketConnection: socket.end received');
    });

    // Read what the socket wants us to do.
    var commandStream = new LineStream();
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
function setupMigrationSocket(opts, callback) {
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

    // This process will listen on the admin network, allowing a connection
    // from vmapi/workflow to control the process actions.
    smartDcConfig.getFirstAdminIp(function (aerr, adminIp) {
        if (aerr) {
            process.send({error: { message: aerr.message, aerr: aerr.stack }});
            return;
        }

        opts.adminIp = adminIp;

        setupMigrationSocket(opts, function (err, response) {
            if (err) {
                process.send({error: { message: err.message, err: err.stack }});
                return;
            }

            process.send(response);
        });
    });
});
