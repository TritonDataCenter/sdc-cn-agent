/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * Overview: Workhorse process for migration sync.
 */

var child_process = require('child_process');
var net = require('net');
var util = require('util');

var assert = require('assert-plus');
var bunyan = require('bunyan');
var jsprim = require('jsprim');
var once = require('once');
var streamThrottle = require('stream-throttle');
var vasync = require('vasync');

var LineStream = require('lstream');
var smartDcConfig = require('../smartdc-config');


var SERVER_CLOSE_TIMEOUT = 60 * 1000; // 1 minute
var SNAPSHOT_NAME_PREFIX = 'vm-migration-';
var SYNC_ABORT_MSG = 'Sync was aborted';
var currentProgress = 0;
var MEGABITS_TO_BYTES = 1000 * 1000 / 8;
var gSyncHandler = null;
var stopProcess = false;
var tcpServer;
var totalProgress = 100;
var VERSION = '1.0.0';
var watcher;

var gExecFileDefaults = {
    // The default maxBuffer for child_process.execFile is 200Kb, we use a much
    // larger value in our execFile calls.
    maxBuffer: 50 * 1024 * 1024,
    // Set timeout for zfs calls.
    timeout: 15 * 60 * 1000
};

/*
 * Setup logging streams.
 */
function setupLogging(action, req_id) {
    var logStreams = [];
    var logfile = util.format('%s/%s-%s-machine_migrate_send.log',
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


// Cribbed from zfs.js
function zfsErrorStr(error, stderr) {
    if (!error) {
        return ('');
    }

    if (error.killed) {
        return ('Process killed due to timeout.');
    }

    return (error.message || (stderr ? stderr.toString() : ''));
}


function zfsError(prefixMsg, error, stderr) {
    var err = (new Error(prefixMsg + ': ' + zfsErrorStr(error, stderr)));
    err.stderr = stderr;
    return err;
}


function writeEvent(socket, event) {
    return socket.write(JSON.stringify(event) + '\n');
}


function endProcess() {
    if (watcher) {
        watcher.end();
    }
    tcpServer.close();
}

function commandStop(opts, event, socket) {
    assert.object(opts, 'opts');
    // assert.object(opts.log, 'opts.log');
    assert.object(event, 'event');
    assert.object(socket, 'socket');

    opts.log.debug('commandStop');

    stopProcess = true;

    if (gSyncHandler) {
        gSyncHandler.abortSyncOperation();
    }

    var responseEvent = {
        type: 'response',
        command: event.command,
        eventId: event.eventId
    };
    writeEvent(socket, responseEvent);

    endProcess();
}


function SyncHandler(opts, event, socket) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.payload, 'opts.payload');
    assert.object(opts.payload.migrationTask, 'opts.payload.migrationTask');
    assert.object(opts.payload.migrationTask.record,
        'opts.payload.migrationTask.record');
    assert.object(opts.payload.vm, 'opts.payload.vm');

    assert.object(event, 'event');
    assert.string(event.host, 'event.host');
    assert.number(event.port, 'event.port');

    this.event = event;
    this.log = opts.log;
    this.opts = opts;
    this.record = opts.payload.migrationTask.record;
    this.socket = socket;
    this.vm = opts.payload.vm;
    this.abortFn = null;
    this.eventId = 1;
    this.isDocker = (this.vm.brand === 'lx' && this.vm.docker === true);
    this.pendingCallbacks = {};
    this.syncAborted = false;

    this.zfs_send_mbps_limit = opts.payload.zfs_send_mbps_limit;

    // This is the main context for each dataset sync operation.
    this.datasets = {};
    this.datasets[this.vm.zfs_filesystem] = {
        zfsFilesystem: this.vm.zfs_filesystem
    };

    // For KVM, the disks hold zfs filesystems that are outside of the base
    // dataset, so we must copy over these filesystems as well. Note that BHYVE
    // uses disks that are a zfs child dataset, which will then be sent
    // recursively all in one go.
    if (this.vm.brand === 'kvm' && Array.isArray(this.vm.disks)) {
        var self = this;

        this.vm.disks.forEach(function _forEachDisk(disk) {
            self.datasets[disk.zfs_filesystem] = {
                zfsFilesystem: disk.zfs_filesystem
            };
        });
    }
}

SyncHandler.prototype.collectSyncInfo =
function _syncHandlerCollectSyncInfo(zfsFilesystemNames, callback) {
    var self = this;

    function collectDatasetInfo(zfsFilesystem, next) {
        var dsCtx = self.datasets[zfsFilesystem];
        dsCtx.endedSuccessfully = false;

        next = once(next);

        // When asked to abort the sync operation, shutdown the send socket.
        this.abortFn = function _colletSyncInfoAbort() {
            if (dsCtx.socket) {
                dsCtx.socket.destroy();
            }
        };

        // Alternative callback handler for functions outside of the pipeline.
        dsCtx.errorCallbackHandler = next;

        vasync.pipeline({arg: dsCtx, funcs: [
            self.getSourceZfsSnapshotNames.bind(self),
            self.connectToReceiver.bind(self),
            self.pipelineCheckSyncAborted.bind(self),
            self.getTargetZfsSnapshotNames.bind(self),
            self.determineSnapshotNames.bind(self),
            self.getZfsSendToken.bind(self),
            self.createMigrationSnapshot.bind(self),
            self.getEstimate.bind(self),
            function _markEndedSuccessfully(ctx, cb) {
                this.abortFn = null;
                ctx.endedSuccessfully = true;
                cb();
            },
            self.disconnectFromReceiver.bind(self)
        ]}, next);
    }

    vasync.forEachPipeline({
        inputs: zfsFilesystemNames,
        func: collectDatasetInfo
    }, function _collectSyncInfoForEachPipelineCb(err) {
        if (err) {
            callback(err);
            return;
        }

        // Determine total dataset estimated send size.
        totalProgress = zfsFilesystemNames.map(
                function _dsSumMap(zfsFilesystem) {
            return self.datasets[zfsFilesystem].estimatedSize;
        }).reduce(function (a, b) {
            return a + b;
        });

        callback();
    });
};

SyncHandler.prototype.syncDatasets =
function _syncHandlerSyncDatasets(zfsFilesystemNames, callback) {
    var self = this;

    function syncDataset(zfsFilesystem, next) {
        var dsCtx = jsprim.deepCopy(self.datasets[zfsFilesystem]);
        dsCtx.endedSuccessfully = false;

        next = once(next);

        // When asked to abort the sync operation, shutdown the send socket.
        this.abortFn = function _colletSyncInfoAbort() {
            if (dsCtx.socket) {
                dsCtx.socket.destroy();
                dsCtx.socket = null;
            }
        };

        // Alternative callback handlers for functions outside of the pipeline.
        dsCtx.errorCallbackHandler = next;
        dsCtx.syncCallbackHandler = next;

        // Do the actual zfs send.
        vasync.pipeline({arg: dsCtx, funcs: [
            self.connectToReceiver.bind(self),
            self.pipelineCheckSyncAborted.bind(self),
            self.setupSync.bind(self),
            self.startSync.bind(self),
            self.waitForSyncSuccess.bind(self),
            function _markEndedSuccessfully(ctx, cb) {
                this.abortFn = null;
                ctx.endedSuccessfully = true;
                cb();
            },
            self.disconnectFromReceiver.bind(self)
        ]}, next);
    }

    vasync.forEachPipeline({
        inputs: zfsFilesystemNames,
        func: syncDataset
    }, function _datasetSyncForEachPipelineCb(err) {
        if (err) {
            callback(err);
            return;
        }

        // Re-adjust total progress - as before it was just an estimate.
        totalProgress = currentProgress;

        callback();
    });
};

SyncHandler.prototype.run = function _syncHandlerRun(callback) {
    var self = this;
    var log = self.log;

    // For each dataset, collect and then sync to the target server.
    var zfsFilesystemNames = Object.keys(self.datasets).sort();

    vasync.pipeline({funcs: [
        function collectSyncInfo(ctx, next) {
            self.collectSyncInfo(zfsFilesystemNames, next);
        },
        function syncDatasets(ctx, next) {
            self.syncDatasets(zfsFilesystemNames, next);
        },
        function cleanupSnapshots(ctx, next) {
            self.cleanupSnapshots(zfsFilesystemNames, next);
        }
    ]}, function _runPipelineCb(err) {
        self.shutdownReceiver(function _shutdownReceiverCb(shutdownErr) {
            if (shutdownErr) {
                log.warn('Error shutting down receiver - ignoring: %s',
                    shutdownErr);
            }
            callback(err);
        });
    });
};

SyncHandler.prototype.abortSyncOperation =
function _syncHandlerAbortSyncOperation(callback) {
    this.syncAborted = true;

    this.log.info('Aborting sync operation');

    if (this.abortFn) {
        this.abortFn();
    }
};

SyncHandler.prototype.pipelineCheckSyncAborted =
function _syncHandlerCheckSyncAborted(ctx, callback) {
    callback(this.syncAborted ? new Error(SYNC_ABORT_MSG) : null);
};

SyncHandler.prototype.shutdownReceiver =
function _syncHandlerShutdownReceiver(callback) {
    var self = this;
    var ctx = {
        endedSuccessfully: true // So no errors get issued during shutdown.
    };

    callback = once(callback);
    ctx.errorCallbackHandler = callback;

    vasync.pipeline({arg: ctx, funcs: [
        self.connectToReceiver.bind(self),
        self.sendReceiverStop.bind(self),
        self.disconnectFromReceiver.bind(self)
    ]}, callback);
};

SyncHandler.prototype.sendReceiverStop =
function _syncHandlerSendReceiverStop(ctx, callback) {
    assert.object(ctx, 'ctx');
    assert.object(ctx.receiverSocket, 'ctx.receiverSocket');
    assert.func(callback, 'callback');

    var self = this;
    var log = self.log;

    log.debug('sendReceiverStop:: telling target server to stop');

    // Tell the target server we are done - so it can shutdown.
    var command = {
        command: 'stop'
    };
    this.runTargetCommand(ctx.receiverSocket, command,
            function _onStopCb(err, event) {
        if (err) {
            log.warn({event: event}, 'Error telling target to shutdown:', err);
        }
        callback();
    });
};

SyncHandler.prototype.runTargetCommand =
function _syncHandlerRunTargetEvent(socket, event, callback) {
    assert.object(socket, 'socket');
    assert.object(event, 'event');
    assert.func(callback, 'callback');

    event.type = 'request';
    event.eventId = this.eventId;
    this.pendingCallbacks[this.eventId] = callback;
    this.eventId += 1;
    writeEvent(socket, event);
};

SyncHandler.prototype.connectToReceiver =
function _syncHandlerConnectToReceiver(ctx, callback) {
    assert.object(ctx, 'ctx');
    assert.func(ctx.errorCallbackHandler, 'ctx.errorCallbackHandler');
    assert.func(callback, 'callback');

    var self = this;
    var log = self.log;

    var host = self.event.host;
    var port = self.event.port;

    assert.notEqual(host, '', 'host defined');
    assert.notEqual(port, -1, 'port !== -1');

    // 1. Start sync receiver process and socket.
    var sock = new net.Socket({allowHalfOpen: true});
    ctx.receiverSocket = sock;

    sock.setTimeout(5 * 60 * 1000);  // 5 minutes

    log.debug({host: host, port: port},
        'connectToReceiver: connecting to cn-agent target process');

    sock.on('error', function _onSocketError(err) {
        log.warn('connectToReceiver: socket error:', err);
        sock.destroy();
        ctx.errorCallbackHandler(err);
    });

    sock.on('timeout', function _onSocketTimeout() {
        log.warn('connectToReceiver: socket timeout');
        sock.destroy();
        ctx.errorCallbackHandler(new Error('receiver socket timeout'));
    });

    sock.on('end', function _onSockEnd() {
        if (!ctx.endedSuccessfully) {
            log.warn('startZfsReceiver: sock ended without "sync-success"');
            sock.destroy();
            ctx.errorCallbackHandler(new Error(
                'No "sync-success" received from target cn-agent process'));
            return;
        }

        log.info('startZfsReceiver: sock ended successfully');
    });

    function onSockConnect() {
        log.debug(
            'connectToReceiver: connected to the cn-agent target process');

        if (self.syncAborted) {
            ctx.errorCallbackHandler(new Error(SYNC_ABORT_MSG));
            return;
        }

        ctx.socket = sock;

        var responseStream = new LineStream();

        responseStream.on('readable', function _commandStreamReadableCb() {
            var line = this.read();

            if (self.syncAborted) {
                ctx.errorCallbackHandler(new Error(SYNC_ABORT_MSG));
                return;
            }

            while (line) {
                processResponse(line);
                line = this.read();
            }
        });

        function processResponse(line) {
            var event;

            try {
                event = JSON.parse(line);
            } catch (ex) {
                log.warn('Ignoring bad JSON line:', line);
                return;
            }

            assert.string(event.type, 'event.type');

            // Handle errors with a specific handler.
            if (event.type === 'error') {
                log.error({event: event},
                    'received "error" event from target cn-agent process');
                ctx.errorCallbackHandler(new Error(event.message), event);
                return;
            }

            // Handle sync success command.
            if (event.type === 'sync-success') {
                assert.func(ctx.syncCallbackHandler,
                    'ctx.syncCallbackHandler');

                // Mark that the sync was successful.
                ctx.endedSuccessfully = true;

                log.info({event: event},
                    'received success event from target cn-agent process');
                ctx.syncCallbackHandler(null, event);
                return;
            }

            // Other events should be in response to a specific request,
            // which must have their own specific callback handler.
            assert.number(event.eventId, 'event.eventId');
            assert.equal(event.type, 'response');
            assert.func(self.pendingCallbacks[event.eventId],
                'self.pendingCallbacks[event.eventId]');

            var cb = self.pendingCallbacks[event.eventId];
            cb(null, event);
        }

        sock.pipe(responseStream);

        callback();
    }

    sock.connect({host: host, port: port}, onSockConnect);
};

SyncHandler.prototype.getSourceZfsSnapshotNames =
function _syncHandlerGetSourceZfsSnapshotNames(ctx, callback) {
    assert.object(ctx, 'ctx');
    assert.string(ctx.zfsFilesystem, 'ctx.zfsFilesystem');
    assert.func(callback, 'callback');

    var log = this.log;

    var cmd = '/usr/sbin/zfs';
    var args = [
        'list',
        '-t',
        'snapshot',
        '-r',
        '-H',
        '-o',
        'name',
        ctx.zfsFilesystem
    ];

    log.debug({cmd: cmd, args: args}, 'getSourceZfsSnapshotNames');

    child_process.execFile(cmd, args, gExecFileDefaults,
            function _execZfsListSnapshotCb(err, stdout, stderr) {
        if (err) {
            log.error({cmd: cmd, args: args},
                'Error listing dataset snapshots, err: %s, stderr: %s',
                err, stderr);
            callback(err);
            return;
        }

        // Example output:
        //   zones/9367e1db-c624-4aab-b91c-a920acaaaaaa@vm-migration-1
        //   zones/9367e1db-c624-4aab-b91c-a920acaaaaaa@vm-migration-2

        var lines = String(stdout).trim().split('\n');
        var seen = {};

        ctx.sourceSnapshotNames = lines.map(function _lineMap(line) {
            return line.split('@').splice(-1)[0];
        }).filter(function _nameFilter(name) {
            return name.startsWith(SNAPSHOT_NAME_PREFIX);
        }).filter(function _duplicateFilter(name) {
            // Filter out the duplicate named snapshots, which is possible for
            // a dataset that contains a child dataset.
            if (seen[name]) {
                return false;
            }
            seen[name] = true;
            return true;
        }).sort(function (a, b) {
            return Number(a.substr(SNAPSHOT_NAME_PREFIX.length)) -
                Number(b.substr(SNAPSHOT_NAME_PREFIX.length));
        });

        log.debug({sourceSnapshotNames: ctx.sourceSnapshotNames},
            'getSourceZfsSnapshotNames');

        callback();
    });
};

/**
 * The target vm uuid may be different to the source - if it is different then
 * the zfs filesystem name will also be different - so handle that here.
 */
SyncHandler.prototype.convertTargetZfsFilesystem =
function _syncHandlerConvertTargetZfsFilesystem(zfsFilesystem) {
    if (this.record.vm_uuid !== this.record.target_vm_uuid) {
        return zfsFilesystem.replace(this.record.vm_uuid,
            this.record.target_vm_uuid);
    }

    return zfsFilesystem;
};

SyncHandler.prototype.getTargetZfsSnapshotNames =
function _syncHandlerGetTargetZfsSnapshotNames(ctx, callback) {
    assert.object(ctx, 'ctx');
    assert.object(ctx.receiverSocket, 'ctx.receiverSocket');
    assert.string(ctx.zfsFilesystem, 'ctx.zfsFilesystem');
    assert.func(callback, 'callback');

    var log = this.log;

    log.debug('getTargetZfsSnapshotNames:: asking target for snapshot names');

    // Get the zfs migration snapshot names from the target server.
    var command = {
        command: 'get-zfs-snapshot-names',
        zfsFilesystem: this.convertTargetZfsFilesystem(ctx.zfsFilesystem)
    };
    this.runTargetCommand(ctx.receiverSocket, command,
            function _getTargetZfsSnapshotNamesCb(err, event) {
        if (err) {
            callback(err);
            return;
        }

        log.info({names: event.names},
            'getTargetZfsSnapshotNames:: got response');
        ctx.targetSnapshotNames = event.names;

        if (!Array.isArray(ctx.targetSnapshotNames)) {
            log.warn('getTargetZfsSnapshotNames:: not an array!?');
            ctx.targetSnapshotNames = [];
        }

        callback();
    });
};

SyncHandler.prototype.determineSnapshotNames =
function _syncHandlerDetermineSnapshotNames(ctx, callback) {
    assert.arrayOfString(ctx.sourceSnapshotNames, 'ctx.sourceSnapshotNames');
    assert.arrayOfString(ctx.targetSnapshotNames, 'ctx.targetSnapshotNames');

    var log = this.log;

    ctx.resumeSync = false;
    ctx.isFirstSync = (ctx.targetSnapshotNames.length === 0);
    ctx.prevSnapshotName = '';
    ctx.snapshotName = SNAPSHOT_NAME_PREFIX + '1';

    if (ctx.sourceSnapshotNames.length === 0) {
        if (ctx.targetSnapshotNames.length > 0) {
            log.error({
                    sourceSnapshotNames: ctx.sourceSnapshotNames,
                    targetSnapshotNames: ctx.targetSnapshotNames,
                    zfsFilesystem: ctx.zfsFilesystem
                }, 'determineSnapshotNames:: snapshots exist on the target, ' +
                'but not on the source - something is wrong');
            callback(new Error('Migration snapshots already exist on the ' +
                'target server'));
            return;
        }

        log.debug({
                prevSnapshotName: ctx.prevSnapshotName,
                snapshotName: ctx.snapshotName,
                zfsFilesystem: ctx.zfsFilesystem
            }, 'determineSnapshotNames:: no previous snapshots');
        callback();
        return;
    }

    // Determine the "next" snapshop name - start from the last source
    // snapshot (most recent) and add one.
    ctx.prevSnapshotName = ctx.sourceSnapshotNames.slice(-1)[0];
    ctx.snapshotName = SNAPSHOT_NAME_PREFIX +
        (Number(ctx.prevSnapshotName.substr(SNAPSHOT_NAME_PREFIX.length)) + 1);
    // We don't actually know if this a resume - but we will find out later
    // when it tries to get the zfs resume token from the target server.
    ctx.resumeSync = true;

    // If the previous snapshot name doesn't yet exist on the target server,
    // then we have tried to send the previous snapshot before - mark it as a
    // continue, and if that fails then fall back to just sending the previous
    // snapshot name.
    if (ctx.targetSnapshotNames.lastIndexOf(ctx.prevSnapshotName) === -1) {
        ctx.snapshotName = ctx.prevSnapshotName;
        if (ctx.sourceSnapshotNames.length > 1) {
            ctx.prevSnapshotName = ctx.sourceSnapshotNames.slice(-2, -1)[0];
            // Now, if this previous previous snapshot doesn't also exist,
            // then that is an error.
            if (ctx.targetSnapshotNames.lastIndexOf(ctx.prevSnapshotName)
                    === -1) {
                log.error({
                        prevSnapshotName: ctx.prevSnapshotName,
                        snapshotName: ctx.snapshotName,
                        sourceSnapshotNames: ctx.sourceSnapshotNames,
                        targetSnapshotNames: ctx.targetSnapshotNames,
                        zfsFilesystem: ctx.zfsFilesystem
                    }, 'determineSnapshotNames:: previous snapshot name is ' +
                    'missing on the target server - something is wrong');
                callback(new Error('Migration snapshots are missing ' +
                    'from the target server'));
                return;
            }
        } else {
            ctx.isFirstSync = true;
            ctx.prevSnapshotName = '';
        }
    }

    // Make sure the "next" snapshot doesn't exist on the target server, i.e. it
    // doesn't exist on the source, why should it exist on the target?
    if (ctx.targetSnapshotNames.lastIndexOf(ctx.snapshotName) >= 0) {
        log.error({
                snapshotName: ctx.snapshotName,
                sourceSnapshotNames: ctx.sourceSnapshotNames,
                targetSnapshotNames: ctx.targetSnapshotNames,
                zfsFilesystem: ctx.zfsFilesystem
            }, 'determineSnapshotNames:: next snapshot name already exists ' +
            'on the target server - something is wrong');
        callback(new Error(
            'Migration snapshots already exist on the target server'));
        return;
    }

    log.debug({
        isFirstSync: ctx.isFirstSync,
        snapshotName: ctx.snapshotName,
        prevSnapshotName: ctx.prevSnapshotName,
        zfsFilesystem: ctx.zfsFilesystem
    }, 'determineSnapshotNames');

    callback();
};

SyncHandler.prototype.getZfsSendToken =
function _syncHandlerGetZfsSendToken(ctx, callback) {
    assert.object(ctx, 'ctx');
    assert.object(ctx.receiverSocket, 'ctx.receiverSocket');
    assert.optionalBool(ctx.resumeSync, 'ctx.resumeSync');
    assert.string(ctx.snapshotName, 'ctx.snapshotName');
    assert.ok(ctx.snapshotName, 'ctx.snapshotName');
    assert.string(ctx.zfsFilesystem, 'ctx.zfsFilesystem');
    assert.func(callback, 'callback');

    var log = this.log;

    if (!ctx.resumeSync) {
        log.debug('getZfsSendToken:: resumeSync is false');
        callback();
        return;
    }

    log.debug('getZfsSendToken:: asking target for sync resume token');

    // Get the zfs send token from the target server.
    var command = {
        command: 'get-zfs-resume-token',
        zfsFilesystem: this.convertTargetZfsFilesystem(ctx.zfsFilesystem)
    };
    this.runTargetCommand(ctx.receiverSocket, command,
            function _getTokenCb(err, event) {
        if (err) {
            callback(err);
            return;
        }

        log.info({token: event.token}, 'getZfsSendToken:: got token response');
        ctx.token = event.token;

        if (!ctx.token) {
            ctx.resumeSync = false;
        }

        callback();
    });
};

SyncHandler.prototype.createMigrationSnapshot =
function _syncHandleCreateMigrationSnapshot(ctx, callback) {
    assert.object(ctx, 'ctx');
    assert.optionalBool(ctx.resumeSync, 'ctx.resumeSync');
    assert.arrayOfString(ctx.sourceSnapshotNames, 'ctx.sourceSnapshotNames');
    assert.string(ctx.zfsFilesystem, 'ctx.zfsFilesystem');
    assert.func(callback, 'callback');

    var log = this.log;

    if (this.syncAborted) {
        callback(new Error(SYNC_ABORT_MSG));
        return;
    }

    if (ctx.resumeSync) {
        log.info({zfsFilesystem: ctx.zfsFilesystem},
            'createMigrationSnapshot:: ignoring - resumeSync is set');
        callback();
        return;
    }

    // Check if the source snapshot already exists.
    if (ctx.sourceSnapshotNames.indexOf(ctx.snapshotName) >= 0) {
        log.info({snapshotName: ctx.snapshotName}, 'Snapshot already exists');
        callback();
        return;
    }

    var cmd = '/usr/sbin/zfs';
    var args = [
        'snapshot',
        '-r',
        util.format('%s@%s', ctx.zfsFilesystem, ctx.snapshotName)
    ];

    log.info({cmd: cmd, args: args}, 'createMigrationSnapshot');

    child_process.execFile(cmd, args, gExecFileDefaults,
            function _execZfsSnapshotCb(error, stdout, stderr) {
        if (error) {
            log.error('zfs snapshot error:', error, ', stderr:', stderr);
            callback(zfsError('zfs snapshot error', error, stderr));
            return;
        }

        // Add the new snapshot to the list of names.
        ctx.sourceSnapshotNames.push(ctx.snapshotName);

        callback();
    });
};

SyncHandler.prototype.getZfsSyncArgs =
function _syncHandleGetZfsSyncArgs(ctx) {
    if (ctx.resumeSync) {
        assert.string(ctx.token, 'ctx.token');

        return [
            'send',
            '-t',
            ctx.token
        ];
    }

    var replicateArg = '--replicate';

    // Docker datasets are created on demand for each CN, so they will always be
    // different between each CN. Thus we don't want the usual --replicate
    // argument (as that will expect the origin dataset to be the same) - we
    // want a full send instead.
    if (this.isDocker) {
        replicateArg = '--props';
    }

    if (ctx.isFirstSync) {
        assert.string(ctx.snapshotName, 'ctx.snapshotName');
        assert.string(ctx.zfsFilesystem, 'ctx.zfsFilesystem');

        return [
            'send',
            replicateArg,
            util.format('%s@%s', ctx.zfsFilesystem, ctx.snapshotName)
        ];
    }

    assert.string(ctx.snapshotName, 'ctx.snapshotName');
    assert.string(ctx.prevSnapshotName, 'ctx.prevSnapshotName');
    assert.string(ctx.zfsFilesystem, 'ctx.zfsFilesystem');

    return [
        'send',
        replicateArg,
        '-I',
        util.format('%s@%s', ctx.zfsFilesystem, ctx.prevSnapshotName),
        util.format('%s@%s', ctx.zfsFilesystem, ctx.snapshotName)
    ];
};

SyncHandler.prototype.getEstimate =
function _syncHandleGetEstimate(ctx, callback) {
    assert.object(ctx, 'ctx');
    assert.string(ctx.zfsFilesystem, 'ctx.zfsFilesystem');
    assert.func(callback, 'callback');

    var log = this.log;

    var cmd = '/usr/sbin/zfs';
    var args = this.getZfsSyncArgs(ctx);

    assert.equal(args[0], 'send');

    args.splice(1, 0, '--parsable', '--dryrun');

    log.info({cmd: cmd, args: args}, 'getEstimate');

    child_process.execFile(cmd, args, gExecFileDefaults,
            function _execZfsSendEstimateCb(error, stdout, stderr) {
        if (error) {
            log.error('zfs snapshot error:', error, ', stderr:', stderr);
            callback(zfsError('zfs snapshot error', error, stderr));
            return;
        }

        var lastLine = stdout.trim().split('\n').splice(-1)[0].trim();
        log.trace('getEstimate:: lastLine: %s', lastLine);

        var match = lastLine.match(/^(size)\s+(\d+)$/);
        if (!match) {
            // For resume, get the size from the "full" or "incremental"
            // output line, e.g:
            //   full                         vm-migration-1  396627824
            //   incremental  vm-migration-1  vm-migration-2  8783224
            log.debug('No lastLine match, trying to get estimate for resume');
            match = lastLine.match(/^(full|incremental)\s+.*\s+(\d+)$/);
        }

        if (!match) {
            log.error('Unable to get zfs send estimate from stdout:', stdout);
            callback(new Error('Unable to get zfs send estimate'));
            return;
        }

        ctx.estimatedSize = Number(match[2]);
        log.debug({zfsFilesystem: ctx.zfsFilesystem,
            estimatedSize: ctx.estimatedSize},
            'getEstimate');

        callback();
    });
};

SyncHandler.prototype.setupSync = function _syncHandleSetupSync(ctx, callback) {
    this.log.info('setupSync');
    // This will start the zfs receive on the target.
    var command = {
        command: 'sync',
        isFirstSync: ctx.isFirstSync,
        resumeSync: ctx.resumeSync,
        zfsFilesystem: this.convertTargetZfsFilesystem(ctx.zfsFilesystem)
    };
    this.runTargetCommand(ctx.receiverSocket, command, callback);
};

SyncHandler.prototype.startSync = function _syncHandleRunSync(ctx, callback) {
    assert.object(ctx, 'ctx');
    assert.func(ctx.errorCallbackHandler, 'ctx.errorCallbackHandler');
    assert.object(ctx.receiverSocket, 'ctx.receiverSocket');
    assert.func(callback, 'callback');

    var self = this;
    var log = self.log;

    // Run zfs sync and pipe data through to the target cn-agent socket, which
    // feeds the data into the zfs receive process on the target.
    var cmd = '/usr/sbin/zfs';
    var args = this.getZfsSyncArgs(ctx);
    var progressIntervalId = -1;
    var startingBytes = ctx.receiverSocket.bytesWritten;
    var startingProgress = currentProgress;
    var stderr;

    log.debug({cmd: cmd, args: args}, 'startSync:: zfs send command');

    var zfsSend = child_process.spawn(cmd, args,
        {
            detached: true,
            stdio: [ 'ignore', 'pipe', 'pipe']
        });

    zfsSend.on('error', function (err) {
        log.error({
                exitCode: zfsSend.exitCode,
                killed: zfsSend.killed,
                signalCode: zfsSend.signalCode
            }, 'zfs send error:', err, ', stderr:', stderr);

        // Adjust the progress made and end the progress updater.
        currentProgress = startingProgress + ctx.receiverSocket.bytesWritten
            - startingBytes;
        clearInterval(progressIntervalId);
        progressIntervalId = -1;

        ctx.errorCallbackHandler(err);
    });

    zfsSend.on('close', function (code) {
        log.info({
                exitCode: zfsSend.exitCode,
                killed: zfsSend.killed,
                signalCode: zfsSend.signalCode
            },
            'zfs send closed, stderr:\n', stderr);

        // Adjust the progress made and end the progress updater.
        currentProgress = startingProgress + ctx.receiverSocket.bytesWritten
            - startingBytes;
        clearInterval(progressIntervalId);
        progressIntervalId = -1;

        if (zfsSend.killed) {
            ctx.errorCallbackHandler(new Error('zfs send process was killed'));
            return;
        }

        if (code) {
            ctx.errorCallbackHandler(new Error(
                'zfs send exited with code: ' + code));
            return;
        }

        log.debug('startSync: zfs send finished successfully');
    });

    zfsSend.stderr.on('data', function (buf) {
        log.warn('zfs send stderr: ' + String(buf));
        // Only keep the first 2500 and last 2500 characters of stderr.
        if (stderr) {
            stderr = Buffer.concat([stderr, buf]);
        } else {
            stderr = buf;
        }
        if (stderr.length > 5000) {
            stderr = Buffer.concat([
                stderr.slice(0, 2500),
                Buffer.from('\n...\n'),
                stderr.slice(-2500)
            ]);
        }
    });

    // Limit how much "zfs send" data we send through the socket.
    if (self.zfs_send_mbps_limit) {
        log.info('startSync: config.zfs_send_mbps_limit is set, ' +
            'sending at %d mbps',
            self.zfs_send_mbps_limit);
        self.throttle = new streamThrottle.Throttle({
            // convert value to B/sec
            rate: self.zfs_send_mbps_limit * MEGABITS_TO_BYTES
        });
        zfsSend.stdout.pipe(self.throttle).pipe(ctx.receiverSocket);
    } else {
        log.info('startSync: config.zfs_send_mbps_limit not set, ' +
            'sending with no bandwidth limit',
            self.zfs_send_mbps_limit);
        zfsSend.stdout.pipe(ctx.receiverSocket);
    }

    // Periodically update the progress made.
    progressIntervalId = setInterval(function _onUpdateProgress() {
        if (self.syncAborted) {
            log.info('Progress updater stopped because sync was aborted');
            clearInterval(progressIntervalId);
            progressIntervalId = -1;
            return;
        }
        currentProgress = startingProgress + ctx.receiverSocket.bytesWritten
            - startingBytes;
        if (currentProgress > totalProgress) {
            totalProgress = currentProgress;
        }
    }, 495);

    // self.zfsSendProcess = zfsSend;

    callback();
};


SyncHandler.prototype.waitForSyncSuccess =
function _syncHandleWaitForSyncSuccess(ctx, callback) {
    assert.object(ctx, 'ctx');
    assert.func(callback, 'callback');

    this.log.info('waiting for sync success event');

    if (this.syncAborted) {
        callback(new Error(SYNC_ABORT_MSG));
        return;
    }

    // Override the callback handler to be the given callback. This will be
    // fired when the 'sync-success' event is seen (or there is an error).
    ctx.syncCallbackHandler = once(callback);
};

// After a successful sync, only keep the most recent migration snapshot.
SyncHandler.prototype.cleanupSourceSnapshots =
function _syncHandlerCleanupSourceSnapshots(ctx, callback) {
    assert.object(ctx, 'ctx');
    assert.arrayOfString(ctx.sourceSnapshotNames, 'ctx.sourceSnapshotNames');
    assert.string(ctx.zfsFilesystem, 'ctx.zfsFilesystem');
    assert.func(callback, 'callback');

    var log = this.log;

    if (ctx.sourceSnapshotNames.length <= 1) {
        callback();
        return;
    }

    function deleteOneSourceSnapshot(snapshotName, next) {
        var cmd = '/usr/sbin/zfs';
        var args = [
            'destroy',
            '-r', // To delete child datasets with this snapshot name too.
            util.format('%s@%s', ctx.zfsFilesystem, snapshotName)
        ];

        log.debug({cmd: cmd, args: args}, 'deleteOneSnapshot');

        child_process.execFile(cmd, args, gExecFileDefaults,
                function _execZfsDestroySnapshotCb(err, stdout, stderr) {
            if (err) {
                log.error({cmd: cmd, args: args},
                    'Error destroying snapshot, err: %s, stderr: %s',
                    err, stderr);
                next(err);
                return;
            }

            next();
        });
    }

    var snapshotsToDelete = ctx.sourceSnapshotNames.slice(0, -1);

    vasync.forEachPipeline({
        inputs: snapshotsToDelete,
        func: deleteOneSourceSnapshot
    }, callback);
};

// Note that each successful sync replicates the snapshot names from the
// source to the target. This means we either have one snapshot if it's the
// first sync or two snapshots in the case of an incremental sync.
SyncHandler.prototype.cleanupTargetSnapshots =
function _syncHandlerCleanupTargetSnapshots(ctx, callback) {
    assert.object(ctx, 'ctx');
    assert.optionalBool(ctx.isFirstSync, 'ctx.isFirstSync');
    assert.object(ctx.receiverSocket, 'ctx.receiverSocket');
    assert.string(ctx.zfsFilesystem, 'ctx.zfsFilesystem');
    assert.func(callback, 'callback');

    var self = this;
    var log = self.log;

    if (ctx.isFirstSync) {
        callback();
        return;
    }

    assert.string(ctx.prevSnapshotName, 'ctx.prevSnapshotName');

    var prevSnapshot = util.format('%s@%s',
        self.convertTargetZfsFilesystem(ctx.zfsFilesystem),
        ctx.prevSnapshotName);

    var command = {
        command: 'zfs-destroy',
        zfsFilesystem: prevSnapshot
    };
    self.runTargetCommand(ctx.receiverSocket, command,
            function _zfsDestroyCb(err) {
        if (err) {
            callback(err);
            return;
        }

        log.info({snapshot: prevSnapshot}, 'cleanupTargetSnapshots:: success');

        callback();
    });
};

SyncHandler.prototype.cleanupSnapshots =
function _syncHandlerCleanupSnapshots(zfsFilesystemNames, callback) {
    var self = this;

    function syncDataset(zfsFilesystem, next) {
        var dsCtx = jsprim.deepCopy(self.datasets[zfsFilesystem]);
        dsCtx.endedSuccessfully = false;

        next = once(next);

        // Alternative callback handlers for functions outside of the pipeline.
        dsCtx.errorCallbackHandler = next;

        // Cleanup zfs snapshots on the source and target CN.
        vasync.pipeline({arg: dsCtx, funcs: [
            self.cleanupSourceSnapshots.bind(self),
            self.connectToReceiver.bind(self),
            self.cleanupTargetSnapshots.bind(self),
            self.disconnectFromReceiver.bind(self)
        ]}, next);
    }

    vasync.forEachPipeline({
        inputs: zfsFilesystemNames,
        func: syncDataset
    }, callback);
};

SyncHandler.prototype.disconnectFromReceiver =
function _syncHandleDisconnectFromReceiver(ctx, callback) {
    assert.object(ctx.receiverSocket, 'ctx.receiverSocket');

    ctx.receiverSocket.end();
    callback();
};

function commandSync(opts, event, socket) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(socket, 'socket');

    var log = opts.log;
    var responseEvent;

    log.debug({event: event}, 'commandSync');

    if (gSyncHandler) {
        log.error('sync handler was already configured');
        if (!socket.destroyed) {
            responseEvent = {
                type: 'error',
                command: event.command,
                eventId: event.eventId,
                message: 'sync error: sync handler was already configured'
            };
            writeEvent(socket, responseEvent);
        }
        endProcess();
        return;
    }

    if (!watcher) {
        watcher = new Watcher(opts);
    }
    watcher.addSocket(socket);

    gSyncHandler = new SyncHandler(opts, event, socket);

    gSyncHandler.run(function _onSyncInstRunCb(err, details) {
        if (err) {
            log.error({err: err}, 'commandSync failed - ending source process');
            responseEvent = {
                type: 'error',
                command: event.command,
                details: details,
                err: err,
                eventId: event.eventId,
                message: 'sync error: ' + err.message
            };
            if (!socket.destroyed) {
                writeEvent(socket, responseEvent);
            }
            endProcess();
            return;
        }

        log.info('sync command finished successfully');
        responseEvent = {
            type: 'response',
            command: event.command,
            details: details,
            eventId: event.eventId
        };
        writeEvent(socket, responseEvent);
    });
}

function Watcher(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.payload, 'opts.payload');
    assert.object(opts.payload.migrationTask, 'opts.payload.migrationTask');
    assert.object(opts.payload.migrationTask.record,
        'opts.payload.migrationTask.record');
    assert.uuid(opts.payload.migrationTask.record.vm_uuid,
        'opts.payload.migrationTask.record.vm_uuid');

    var hrtime = process.hrtime();

    this.log = opts.log;
    this.isRunning = false;
    this.lastProgress = 0;
    this.lastMs = hrtime[0] * 1000 + hrtime[1] / 1000000;
    this.lastSpeed = 0;
    this.runTimeoutId = -1;
    this.sockets = [];
    this.vm_uuid = opts.payload.migrationTask.record.vm_uuid;
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
            // Do not fight with the end calls.
            return;
        }
        var idx = self.sockets.indexOf(socket);
        if (idx >= 0) {
            self.sockets.splice(idx, 1);
            self.log.info({numSockets: self.sockets.length},
                'Watcher:: socket close event received - removed');
        } else {
            self.log.error({socket: socket},
                'Watcher:: should not get a close event for an unknown socket');
        }
    });

    self.log.info({numSockets: self.sockets.length},
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

    // Send progress events every second (if progress was made), or at least
    // once every 60 seconds (the latter is used as a socket keep alive).
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

        self.runTimeoutId = setTimeout(runLoop, 1000);
    }

    runLoop();

    self.log.info('Watcher:: started');
};


Watcher.prototype.destroySockets = function WatcherDestroySockets() {
    this.log.debug({numSockets: this.sockets.length},
        'Watcher:: closing watcher sockets');
    this.sockets.forEach(function _endForEachSocket(socket) {
        socket.destroy();
    });
    this.sockets = [];
};

Watcher.prototype.end = function WatcherEnd() {
    this.log.info('Watcher:: end');
    this.isRunning = false;

    clearTimeout(this.runTimeoutId);

    this.destroySockets();
};

Watcher.prototype.sendProgress = function WatcherSendProgress(isMinute) {
    // Send progress events when there has been progress made, or when there
    // has been no progress for a minute (just to keep the sockets alive).
    var progressMade = currentProgress - this.lastProgress;

    var hrtime = process.hrtime();
    var ms = hrtime[0] * 1000 + hrtime[1] / 1000000;

    var msSinceLastUpdate = ms - this.lastMs;
    // Speed in bytes per second.
    var speed = progressMade / msSinceLastUpdate * 1000;
    // Get an average between the last speeds.
    var avgSpeed = (speed + this.lastSpeed) / 2;
    var eta_ms = Math.max(totalProgress - currentProgress, 5000) /
        Math.max(1, avgSpeed) * 1000;

    // this.log.debug(
    //     {
    //         avgSpeed: avgSpeed,
    //         eta_ms: eta_ms,
    //         ms: ms,
    //         msSinceLastUpdate: msSinceLastUpdate,
    //         currentProgress: currentProgress,
    //         speed: speed,
    //         lastMs: this.lastMs,
    //         lastProgress: this.lastProgress,
    //         lastSpeed: this.lastSpeed,
    //         totalProgress: totalProgress
    //     }, 'speed check');

    this.lastMs = ms;
    this.lastProgress = currentProgress;
    this.lastSpeed = speed;

    if (isMinute || progressMade) {
        // Send a progress event.
        var event = {
            current_progress: currentProgress,
            eta_ms: Math.round(eta_ms),
            phase: 'sync',
            state: 'running',
            store: isMinute,
            total_progress: Math.max(currentProgress, totalProgress),
            transfer_bytes_second: Math.round(avgSpeed),
            type: 'progress'
        };
        this.sendEvent(event);
        this.log.trace({
                progressMade: progressMade,
                currentProgress: currentProgress,
                totalProgress: totalProgress
            }, 'Watcher:: sent progress event');
    }
};

Watcher.prototype.sendEvent = function WatcherSendEvent(event) {
    var line = JSON.stringify(event) + '\n';

    this.sockets.forEach(function _sendEventForEachSocket(socket) {
        socket.write(line);
    });
};


function commandWatch(opts, event, socket) {
    assert.object(opts, 'opts');
    assert.object(event, 'event');
    assert.object(socket, 'socket');

    if (!watcher) {
        watcher = new Watcher(opts);
    }
    watcher.addSocket(socket);
}


function commandSetRecord(opts, event, socket) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.payload, 'opts.payload');
    assert.object(opts.payload.migrationTask, 'opts.payload.migrationTask');
    assert.object(event, 'event');
    assert.object(event.record, 'event.record');
    assert.object(socket, 'socket');

    opts.log.debug({record: event.record}, 'commandSetRecord');

    // Update the migration record.
    opts.payload.migrationTask.record = event.record;

    var responseEvent = {
        type: 'response',
        command: event.command,
        eventId: event.eventId
    };
    writeEvent(socket, responseEvent);
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

    opts.log.debug({event: event}, 'commandNotImplemented');

    var responseEvent = {
        type: 'error',
        command: event.command,
        eventId: event.eventId,
        message: 'Not Implemented',
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
        log.error('Build: invalid json: %s - ignoring', line);
        return;
    }

    assert.equal(event.type, 'request');

    switch (event.command) {
        case 'end':
            commandStop(opts, event, socket);
            break;
        case 'stop':
            commandStop(opts, event, socket);
            break;
        case 'ping':
            commandPing(opts, event, socket);
            break;
        case 'set-record':
            commandSetRecord(opts, event, socket);
            break;
        case 'sync':
            commandSync(opts, event, socket);
            break;
        case 'watch':
            commandWatch(opts, event, socket);
            break;
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
    assert.string(opts.adminIp, 'opts.adminIp');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.payload, 'opts.payload');
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
