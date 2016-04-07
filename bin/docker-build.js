/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * Overview: Handler docker build commands.
 */

var child_process = require('child_process');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var net = require('net');
var util = require('util');

var assert = require('assert-plus');
var async = require('async');
var bunyan = require('bunyan');
var digestStream = require('digest-stream');
var dockerbuild = require('sdc-docker-build');
var IMGAPI = require('sdc-clients').IMGAPI;
var mkdirp = require('mkdirp');
var rimraf = require('rimraf');
var sprintf = require('sprintf').sprintf;
var zfs = require('/usr/node/node_modules/zfs.js').zfs;

var LineStream = require('../lib/linestream');
var smartDcConfig = require('../lib/task_agent/smartdc-config');


var SERVER_CLOSE_TIMEOUT = 60 * 1000; // 1 minute
var messageId = 0;  // The id for a message sent over socket.
var gSnapshotId = 0;  // Snapshot id counter.
var gSnapshots = [];  // Snapshots created during the build.
var gSnapshotsToDelete = []; // Other snapshots to delete at end of the build.
var gSnapshotTarExe = path.join(__dirname, '../lib/zfs_snapshot_tar');


/*
 * Main entry point.
 */
process.on('message', function (message) {
    assert.object(message, 'message');
    assert.object(message.payload, 'payload');
    assert.string(message.payload.account_uuid, 'payload.account_uuid');
    assert.string(message.payload.command, 'payload.command');
    assert.string(message.payload.imgapi_url, 'payload.imgapi_url');
    assert.optionalArrayOfObject(message.payload.allDockerImages,
        'payload.allDockerImages');
    assert.string(message.req_id, 'req_id');
    assert.string(message.uuid, 'uuid');
    assert.optionalNumber(message.timeoutSeconds, 'timeoutSeconds');

    var commandType = message.payload.command;  // Either 'build' or 'commit'
    assert.ok(commandType === 'build' || commandType === 'commit',
        'Unknown command type: ' + commandType);

    // Setup log streams.
    var logStreams = [];
    var logfile = sprintf('%s/%s-%s-docker_%s_child.log', process.env.logdir,
        (new Date()).getTime().toString(), process.pid, commandType);
    logStreams.push({path: logfile, level: 'debug'});
    // Keep last N log messages around - useful for debugging.
    var ringbuffer = new bunyan.RingBuffer({ limit: 100 });
    logStreams.push({
        level: 'debug',
        type: 'raw',
        stream: ringbuffer
    });
    // Create the logger.
    var log = bunyan.createLogger({name: 'docker-' + commandType,
                                    streams: logStreams,
                                    req_id: message.req_id});
    // Store an easy accessor to the ring buffer.
    log.ringbuffer = ringbuffer;

    var opts = {
        contextDownloadFinished: false,
        log: log,
        req_id: message.req_id,
        payload: message.payload,
        uuid: message.uuid,
        timeoutSeconds: message.timeoutSeconds || SERVER_CLOSE_TIMEOUT
    };

    smartDcConfig.getFirstAdminIp(function (aerr, adminIp) {
        if (aerr) {
            process.send({error: { message: aerr.message, aerr: aerr.stack }});
            return;
        }
        opts.adminIp = adminIp;
        setupDockerBuildSocket(opts, function (err, response) {
            if (err) {
                process.send({error: { message: err.message, err: err.stack }});
                return;
            }
            process.send(response);
        });
    });
});


/**
 * Setup the build tcp server and send back the server's host and port details.
 */
function setupDockerBuildSocket(opts, callback) {
    var log = opts.log;
    var commandType = opts.payload.command;  // Either 'build' or 'commit'
    var connectCount = 0;

    if (commandType === 'commit') {
        // Commit does not send a build context.
        connectCount = 1;
        opts.contextDownloadFinished = true;
    }

    log.debug('opts.payload: %s', util.inspect(opts.payload, {depth: 10}));

    var onListening = function build_onListening() {
        var addr = tcpServer.address();
        log.info('DockerBuildTask listening on socket %j', addr);
        var hostAndPort = {
            host: opts.adminIp,
            port: addr.port
        };
        callback(null, hostAndPort);
    };

    var onConnection = function build_onConnection(socket) {
        connectCount += 1;
        log.info('build got connection from', socket.address());

        clearTimeout(serverTimeout);

        if (connectCount == 1) {
            // Download the build context.
            opts.contextSocket = socket;
            downloadContext(opts);
        } else {
            // The second client connection is made - no longer need the server.
            log.debug('opts.contextDownloadFinished: ',
                opts.contextDownloadFinished);
            opts.buildSocket = socket;
            tcpServer.close();

            // Note: There is a race between getting the second socket
            // connection and having the download of the context being finished.
            // We avoid this race by using the contextDownloadFinished boolean,
            // such that we must wait for the context download to complete,
            // before starting the build.
            if (opts.contextDownloadFinished) {
                runBuild(opts);
            }
        }
    };

    log.info('DockerBuildTask setting up socket');

    /**
     * Create TCP Server which will output the build stream.
     */
    var tcpServer = net.createServer({ allowHalfOpen: true });

    // Close server if no connections are received within timeout
    var serverTimeout = setTimeout(function () {
        log.warn('Closing stream tcpServer after ' +
             SERVER_CLOSE_TIMEOUT + ' msec without connection');
        tcpServer.close();
    }, SERVER_CLOSE_TIMEOUT);

    tcpServer.on('connection', onConnection);

    var backlog = 2;
    tcpServer.listen(0, opts.adminIp, backlog, onListening);
}


/**
 * Build helper functions.
 */

function sendEvent(evt, opts, callback) {
    evt.messageId = messageId;
    messageId += 1;
    if (opts.log) {
        opts.log.debug('Sending event: %j', evt);
    }
    opts.socket.write(JSON.stringify(evt) + '\n', callback);
}


function sendMessage(message, opts, callback) {
    sendEvent({
        message: message,
        type: 'message'
    }, opts, callback);
}


function downloadContext(opts) {
    var log = opts.log;
    var socket = opts.contextSocket;

    var contextDir = sprintf('/zones/%s/config/docker-build', opts.uuid);
    mkdirp(contextDir, function (err) {
        if (err) {
            // XXX: Need to stream back error response.
            return;
        }

        opts.contextFilepath = path.join(contextDir, 'context.tar');

        log.info('contextFilepath: ', opts.contextFilepath);

        var fileStream = fs.createWriteStream(opts.contextFilepath);
        socket.pipe(fileStream);

        var onEndHandler = function () {
            opts.contextDownloadFinished = true;
            log.info('build context received, closing context stream');
            sendMessage('Context received', {socket: socket, log: log},
                function _smCbDownloadCallback()
            {
                log.debug('destroying context stream');
                socket.destroy();
            });
            // If the build socket is already connected - then start building.
            if (typeof (opts.buildSocket) !== 'undefined') {
                runBuild(opts);
            }
        };

        socket.on('end', onEndHandler);
    });
}


/**
 * Docker context file is available, start the build process.
 */
function runBuild(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.buildSocket, 'opts.buildSocket');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.payload, 'opts.payload');
    assert.string(opts.uuid, 'opts.uuid');

    var commandType = opts.payload.command;  // Either 'build' or 'commit'
    var log = opts.log;
    var socket = opts.buildSocket;

    // Try to provide logging and feedback when something goes wrong.
    var uncaughtExceptionHandler = function (err) {
        log.error('Build error:', err);

        process.removeListener('uncaughtException', uncaughtExceptionHandler);
        sendMessage('Build failure: ' + err.message, {socket: socket, log: log},
            function _smCbRunBuild()
        {
            log.streams[0].stream.on('end', function () {
                process.exit(0);
            });
            // throw err;
        });
    };
    process.on('uncaughtException', uncaughtExceptionHandler);

    log.info('%s - started for zone %s', commandType, opts.uuid);

    sendMessage('Starting ' + commandType, {socket: socket, log: log});

    if (commandType === 'commit') {
        // Do docker commit.
        commitImage(opts, onDone);
    } else {
        // Do docker build.
        buildFromContext(opts, onDone);
    }

    function onDone(err) {
        log.info('%s finished, err: %s', commandType, err);
        var event = {
            type: 'end'
        };
        if (err) {
            event.error = err.message;
        }
        sendEvent(event, {socket: socket, log: log}, function () {
            log.debug('runBuild: sent end event - calling socket.destroy');
            socket.destroy();
        });
    }
}


/**
 * Create sdc-docker-build Builder instance and manage the building process.
 *
 * Communicates (relay) between sdc-docker and the docker Builder.
 */
function buildFromContext(opts, callback) {
    assert.object(opts.payload, 'opts.payload');

    var log = opts.log;
    var socket = opts.buildSocket;
    var pendingCallbackEvents = {};

    socket.on('end', function () {
        log.debug('buildFromContext: socket.end received');
    });

    // Handle events from sdc-docker - usually this will be an answer (callback)
    // to a request the build system has made.
    var buildEventStream = new LineStream();
    socket.pipe(buildEventStream);
    buildEventStream.on('line', function (event) {
        log.debug('client event received: %j', event);
        var id;
        var cbEvent;
        try {
            event = JSON.parse(event);
        } catch (e) {
            log.error('Build: invalid json: %s - ignoring', event);
            return;
        }
        switch (event.type) {
            case 'callback':
                id = event.messageId;
                cbEvent = pendingCallbackEvents[id];
                assert.object(cbEvent, 'cbEvent with messageId ' + id);
                delete pendingCallbackEvents[id];
                if (event.error) {
                    cbEvent.callback(new Error(event.error));
                } else {
                    cbEvent.callback(null, event.result);
                }
                break;
            default:
                log.error('Unhandled socket event - ignoring: %j', event);
                break;
        }
    });

    var buildOpts = {
        buildargs: opts.payload.buildargs,
        commandType: 'build',
        containerRootDir: path.join('/zones', opts.uuid, 'root'),
        contextFilepath: opts.contextFilepath,
        dockerfile: opts.payload.dockerfile,
        suppressSuccessMsg: true,  // Stop the 'Build successful: ' message.
        existingImages: opts.payload.allDockerImages,
        log: opts.log,
        nocache: opts.payload.nocache,
        uuid: opts.uuid,
        workDir: path.join('/zones', opts.uuid, 'config')
    };
    var builder = new dockerbuild.Builder(buildOpts);

    // XXX: Write up the complete message event spec.
    builder.on('message', function (event) {
        switch (event.type) {
            case 'message':
            case 'stdout':
                sendEvent(event, {socket: socket, log: log});
                break;
            default:
                log.error('Unhandled build event - ignoring: %j', event);
                break;
        }
    });

    builder.on('task', function (event) {
        var addPendingCallback = true;

        switch (event.type) {
            case 'extract_tarfile':
                addPendingCallback = false;
                handleExtractTarfileEvent(builder, event);
                break;
            case 'image_reprovision':
                sendEvent(event, {socket: socket, log: log});
                break;
            case 'image_create':
                sendEvent(event, {socket: socket, log: log});
                break;
            case 'run':
                // Update the metadata.json.
                updateContainerMetadata(builder, event);
                sendEvent(event, {socket: socket, log: log});
                break;
            case 'build_finished':
                sendEvent(event, {socket: socket, log: log});
                break;
            default:
                log.error('Unhandled build task - ignoring: %j', event);
                if (event.callback) {
                    event.callback(new Error('Unhandled build task: '
                                            + event.type));
                    return;
                }
                break;
        }

        if (addPendingCallback && event.callback) {
            pendingCallbackEvents[event.messageId] = event;
        }
    });

    builder.on('image_reprovisioned', function (event) {
        assert.func(event.callback, 'event.callback');
        assert.string(event.cmdName, 'event.cmdName');
        // When an image is reprovisioned, it means the base image is being
        // reset, this happens for the FROM command, or when building on top
        // of a cached image. Make a new base snapshot when building on top
        // of a cached image, as the FROM cmd will already create a snapshot
        // in doPostStep.
        if (event.cmdName !== 'FROM') {
            gSnapshotsToDelete = gSnapshotsToDelete.concat(gSnapshots);
            gSnapshots = [];
            createZfsSnapshot(builder, event.callback);
        } else {
            event.callback();
        }
    });

    builder.__doPostStep = builder.doPostStep;
    builder.doPostStep = function _doPostStep(cmd, cb) {
        builder.__doPostStep(cmd, function _doPostStepCb(err, result) {
            if (err) {
                cb(err);
                return;
            }
            if (cmd.ctx.isCached) {
                // No need to create a snapshot for a cached command.
                cb();
                return;
            }
            // TODO: We don't need to snapshot for metadata commands.
            createZfsSnapshot(builder, cb);
        });
    };

    builder.on('end', function (err) {
        async.waterfall([
            function checkError(cb) {
                cb(err);
            },
            function importImages(cb) {
                importImageSnapshotsIntoImgapi(builder, opts, cb);
            },
            function notifySuccess(next) {
                log.debug('notifySuccess');
                var event = {
                    callback: next,
                    finalId: builder.layers.slice(-1)[0].image.id,
                    type: 'build_finished'
                };
                builder.emitTask(event);
            }
        ], function endAsyncCb(builderr) {
            cleanup(builder, function _cleanupCb(cleanuperr) {
                callback(builderr || cleanuperr);
            });
        });
    });

    builder.start();
}


/**
 * Remove the given snapshots.
 */
function destroySnapshots(snaps, builder, callback) {
    // Delete snapshots and temporary files.
    if (snaps.length === 0) {
        callback();
        return;
    }
    var snapNames = snaps.map(function (s) { return s.name; }).join(',');
    var zfsSnaps = sprintf('zones/%s@%s', builder.zoneUuid, snapNames);
    builder.log.debug('Destroying snapshots %j', zfsSnaps);
    zfs.destroy(zfsSnaps, callback);
}


/**
 * Cleanup directories, files and other data created during the build process.
 */
function cleanup(builder, callback) {
    var allSnaps = gSnapshotsToDelete.concat(gSnapshots);
    destroySnapshots(allSnaps, builder, function _destroySnapsCb(err) {
        if (err || builder.commandType === 'commit') {
            callback(err);
            return;
        }

        rimraf(builder.contextDir, callback);
    });
}


/**
 * Create sdc-docker-build Builder instance and manage the image create process.
 *
 * Communicates (relay) between sdc-docker and the image Builder.
 */
function commitImage(opts, callback) {
    assert.object(opts.payload, 'opts.payload');
    assert.arrayOfString(opts.payload.changes, 'opts.payload.changes');
    assert.object(opts.payload.fromImage, 'opts.payload.fromImage');
    assert.string(opts.payload.fromImageUuid, 'opts.payload.fromImageUuid');

    var changes = opts.payload.changes;
    var fromImage = opts.payload.fromImage;
    var fromImageUuid = opts.payload.fromImageUuid;
    var log = opts.log;
    var pendingCallbackEvents = {};
    var socket = opts.buildSocket;

    socket.on('end', function () {
        log.debug('commitImage: socket.end received');
    });

    // Handle events from sdc-docker - usually this will be an answer (callback)
    // to a request the build system has made.
    var commitEventStream = new LineStream();
    socket.pipe(commitEventStream);
    commitEventStream.on('line', function (event) {
        log.debug('client event received: %j', event);
        var id;
        var cbEvent;
        try {
            event = JSON.parse(event);
        } catch (e) {
            log.error('Build: invalid json: %s - ignoring', event);
            return;
        }
        switch (event.type) {
            case 'callback':
                id = event.messageId;
                cbEvent = pendingCallbackEvents[id];
                assert.object(cbEvent, 'cbEvent with messageId ' + id);
                delete pendingCallbackEvents[id];
                if (event.error) {
                    cbEvent.callback(new Error(event.error));
                } else {
                    cbEvent.callback(null, event.result);
                }
                break;
            default:
                log.error('Unhandled socket event - ignoring: %j', event);
                break;
        }
    });

    var buildOpts = {
        commandType: 'commit',
        containerRootDir: path.join('/zones', opts.uuid, 'root'),
        contextFilepath: '<none for docker commit>',  // XXX: Fake context.
        log: opts.log,
        nocache: true,
        uuid: opts.uuid,
        workDir: path.join('/zones', opts.uuid, 'config')
    };
    var builder = new dockerbuild.Builder(buildOpts);

    // Add the base image as the first snapshot.
    var fullSnapshotName = sprintf('zones/%s@final', fromImageUuid);
    log.debug('Base image snapshot is %j', fullSnapshotName);
    gSnapshots.push({
        name: fullSnapshotName,
        layerIdx: 0
    });

    builder.on('message', function (event) {
        switch (event.type) {
            case 'message':
            case 'stdout':
                sendEvent(event, {socket: socket, log: log});
                break;
            default:
                log.error('Unhandled builder event - ignoring: %j', event);
                break;
        }
    });

    builder.on('task', function (event) {
        switch (event.type) {
            case 'image_create':
                sendEvent(event, {socket: socket, log: log});
                break;
            case 'commit_finished':
                sendEvent(event, {socket: socket, log: log});
                break;
            default:
                log.error('Unhandled commit task - ignoring: %j', event);
                if (event.callback) {
                    event.callback(new Error('Unhandled build task: '
                                            + event.type));
                    return;
                }
                break;
        }

        if (event.callback) {
            pendingCallbackEvents[event.messageId] = event;
        }
    });

    builder.on('end', function (err) {
        async.waterfall([
            function checkBuildError(cb) {
                cb(err);
            },
            function snapshot(cb) {
                createZfsSnapshot(builder, cb);
            },
            // Update image metadata with user provided arguments.
            function updateFinalImage(cb) {
                var img = builder.layers.slice(-1)[0].image;
                if (opts.payload.author) {
                    img.author = opts.payload.author;
                }
                if (opts.payload.comment) {
                    img.comment = opts.payload.comment;
                }
                cb();
            },
            function importImages(cb) {
                importImageSnapshotsIntoImgapi(builder, opts, cb);
            },
            function notifySuccess(next) {
                log.debug('notifySuccess');
                var event = {
                    callback: next,
                    finalId: builder.layers.slice(-1)[0].image.id,
                    type: 'commit_finished'
                };
                builder.emitTask(event);
            }
        ], function endAsyncCb(builderr) {
            cleanup(builder, function _cleanupCb(cleanuperr) {
                callback(builderr || cleanuperr);
            });
        });
    });

    builder.startCommit(fromImage, changes || []);
}


/**
 * Some files in the zone cannot be symlinks or directories (because it will
 * cause container startup errors), so remove any troublesome files.
 */
function removeTroublesomeEtcFiles(builder, callback) {
    var etcFiles = [
        'resolv.conf',
        'hostname',
        'hosts'
    ];
    var filename;
    var fpath;
    var i;
    var log = builder.log;
    var stat;

    var lastCmd = builder.layers.slice(-1)[0].cmd;
    if (!lastCmd || ['ADD', 'COPY'].indexOf(lastCmd.name) === -1) {
        // Removal is not needed for other commands.
        callback();
        return;
    }

    // First, check if there's an '/etc/' directory.
    // Note: `containerRealpath` will ensure we don't leave the
    // zone's root dir.
    var realEtcDir = path.join(builder.containerRootDir,
        builder.containerRealpath('/etc'));
    try {
        log.debug('removeTroublesomeEtcFiles: etc path: %s', realEtcDir);
        stat = fs.lstatSync(realEtcDir);
    } catch (e) {
        // No etc dir - that's great - nothing to do!
        callback();
        return;
    }

    for (i = 0; i < etcFiles.length; i++) {
        filename = etcFiles[i];
        try {
            fpath = path.join(realEtcDir, filename);
            log.debug('removeTroublesomeEtcFiles: checking fpath: %s', fpath);
            stat = fs.lstatSync(fpath);
        } catch (e) {
            // No file - that's great - nothing to do for this file!
            continue;
        }

        try {
            if (stat.isFile()) {
                // A regular file is okay - it will be overwritten as needed.
                continue;
            }
            if (stat.isDirectory()) {
                log.debug('Removing troublesome container dir %s', fpath);
                rimraf.sync(fpath);
            } else {
                log.debug('Removing troublesome container file %s', fpath);
                fs.unlinkSync(fpath);
            }
        } catch (e) {
            log.error('Error removing ' + fpath, e);
            callback(new Error(sprintf('Error removing etc path %s',
                filename)));
            return;
        }
    }

    callback();
}


/**
 * Perform tar file extraction for the given event.
 */
function handleExtractTarfileEvent(builder, event) {
    assert.object(builder, 'builder');
    assert.object(event, 'event');
    assert.func(event.callback, 'event.callback');
    assert.string(event.extractDir, 'event.extractDir');
    assert.string(event.tarfile, 'event.tarfile');

    var callback = event.callback;
    var extractDir = event.extractDir;
    var log = builder.log;
    var tarfile = event.tarfile;

    // Ensure the holding (parent) directory exists.
    builder.mkdirpChown(extractDir, function (err) {
        if (err) {
            callback(err);
            return;
        }

        var cmd = path.join(__dirname, 'chroot-gtar');
        var zoneBaseDir = sprintf('/zones/%s', builder.zoneUuid);
        var extractDirRelToChroot = path.relative(zoneBaseDir, extractDir);
        var tarfileRelToChroot = path.relative(zoneBaseDir, tarfile);

        // Make some assertions for file/directory paths.
        assert.equal(tarfile.substr(0, zoneBaseDir.length), zoneBaseDir,
            sprintf('Tarfile %s should be under zone dir %s',
                tarfile, zoneBaseDir));
        assert.notEqual(extractDirRelToChroot.substr(0, 2), '..',
            sprintf('Invalid extractDirRelToChroot %s for extractDir %s',
                extractDirRelToChroot, extractDir));
        assert.notEqual(tarfileRelToChroot.substr(0, 2), '..',
            sprintf('Invalid tarfileRelToChroot %s for tarfile %s',
                tarfileRelToChroot, tarfile));

        var args = [
            '-r', zoneBaseDir,
            '-C', extractDirRelToChroot,
            '-t', tarfileRelToChroot
        ];

        if (event.compression) {
            args = args.concat(['-z', event.compression]);
        }

        // All following arguments are passed on to gtar directly.
        args.push('--');

        // Add ownership rules for extracted files/directories - this will set
        // uid/gid to root.
        args.push('--no-same-owner');

        if (event.hasOwnProperty('stripDirCount')) {
            args.push(sprintf('--strip-components=%d', event.stripDirCount));
        }

        if (event.hasOwnProperty('replacePattern')) {
            // replacePattern looks like '/text/replace/', but gtar differs
            // slight from regular tar, so make the replacePattern look like:
            // 's/text/replace/'.
            args.push(sprintf('--transform=s%s', event.replacePattern));
        }

        if (event.hasOwnProperty('paths')) {
            args = args.concat(event.paths);
        }

        log.debug({cmd: cmd, args: args}, 'chroot-gtar extraction command');

        child_process.execFile(cmd, args, function (error, stdout, stderr) {
            if (error) {
                log.error('chroot-gtar error:', error, ', stderr:', stderr);
                callback(error);
                return;
            }
            callback();
        });
    });
}


/**
 * Update the zone's json metadata with the current builder's image metadata.
 */
function updateContainerMetadata(builder, event) {
    assert.object(builder, 'builder');
    assert.object(event, 'event');
    assert.object(event.cmd, 'event.cmd');
    assert.object(event.env, 'event.env');
    assert.optionalString(event.user, 'event.user');
    assert.optionalString(event.workdir, 'event.workdir');

    var log = builder.log;
    var metaFilepath = path.join(builder.workDir, 'metadata.json');
    var metadata = JSON.parse(fs.readFileSync(metaFilepath));
    var im = metadata.internal_metadata;

    var jsonCmd = JSON.stringify(event.cmd);
    if (im['docker:cmd'] !== jsonCmd) {
        log.debug('updateContainerMetadata: cmd changed from %j to %j',
            im['docker:cmd'], jsonCmd);
        im['docker:cmd'] = jsonCmd;
    }

    var jsonEnv = JSON.stringify(event.env);
    if (im['docker:env'] !== jsonEnv) {
        log.debug('updateContainerMetadata: env changed from %s to %s',
            im['docker:env'], jsonEnv);
        im['docker:env'] = jsonEnv;
    }

    if (event.user && event.user !== im['docker:user']) {
        log.debug('updateContainerMetadata: user changed from %s to %s',
            im['docker:user'], event.user);
        im['docker:user'] = event.user;
    }

    if (event.workdir && event.workdir !== im['docker:workdir']) {
        log.debug('updateContainerMetadata: workdir changed from %s to %s',
            im['docker:workdir'], event.workdir);
        im['docker:workdir'] = event.workdir;
    }

    fs.writeFileSync(metaFilepath, JSON.stringify(metadata));
}


/**
 * Create a zfs snapshot for the current build step.
 */
function createZfsSnapshot(builder, callback) {
    assert.object(builder, 'builder');
    assert.func(callback, 'callback');

    // Remove special files before we create the snapshot.
    async.waterfall([
        function removeTroubleFiles(next) {
            // Don't remove any files for a docker commit operation.
            if (builder.commandType === 'commit') {
                next();
                return;
            }
            removeTroublesomeEtcFiles(builder, next);
        },
        function takeSnapshot(next) {
            // Take a snapshot and add the name to the list of snapshots taken.
            gSnapshotId += 1;
            var log = builder.log;
            var snapshotName = sprintf('buildlayer%d', gSnapshotId);
            var zfsName = sprintf('zones/%s@%s', builder.zoneUuid,
                snapshotName);
            log.debug('Creating zfs snapshot %j', zfsName);

            zfs.snapshot(zfsName, function zfsSnapshotCb(err, stderr) {
                if (err) {
                    log.error('snapshot error: %s, stderr: %s', err, stderr);
                    next(err);
                    return;
                }
                gSnapshots.push({
                    name: snapshotName,
                    layerIdx: builder.layers.length - 1
                });
                next();
            });
        }
    ], callback);
}


/**
 * For each snapshot, create a image and import it into imgapi.
 */
function importImageSnapshotsIntoImgapi(builder, opts, callback) {
    assert.object(builder, 'builder');
    assert.object(opts, 'opts');
    assert.object(opts.payload, 'opts.payload');
    assert.string(opts.req_id, 'opts.req_id');
    assert.func(callback, 'callback');

    var imgapi = new IMGAPI({url: opts.payload.imgapi_url, agent: false});
    var idx = -1;
    var log = builder.log;
    var finalImageId = builder.layers.slice(-1)[0].image.id;

    log.info('import %d images into IMGAPI', (gSnapshots.length - 1));

    async.eachSeries(gSnapshots, function aImp(snapData, cb) {
        idx += 1;
        // The first step is always the base, so we can skip that.
        if (idx === 0) {
            cb();
            return;
        }
        var snapshotName = snapData.name;
        var layerIdx = snapData.layerIdx;
        // Create snapshot diff in tar format and send to imgapi.
        var cumulativeSize = 0;
        var dockerImage = builder.layers[layerIdx].image;
        var image; // Image metadata from imgapi addImageFile
        var imageOrigStream;
        var imageSdcDocker;
        var imageSha1sum;
        var imageStream;
        var size = 0;
        var zfsProcessError;

        function onZfsProcessError(err) {
            zfsProcessError = err;
        }

        log.debug('Creating image for build layer %d %j', idx, dockerImage);
        if (builder.commandType !== 'commit') {
            builder.emitStdout(util.format('Importing image %s into '
                + 'IMGAPI\n', builder.getShortId(dockerImage.id)));
        }

        async.waterfall([
            function doGetZfsSnapshotSize(next) {
                var snapOpts = {
                    log: log,
                    snapshot: snapshotName,
                    zoneUuid: builder.zoneUuid
                };
                zfsGetSnapshotSizes(snapOpts, function (err, sizes) {
                    if (err) {
                        next(err);
                        return;
                    }
                    // zfs.get returns strings - convert to ints.
                    size = parseInt(sizes.used, 10);
                    cumulativeSize = parseInt(sizes.referenced, 10);
                    next();
                });
            },
            function doImgapiCreate(next) {
                var imageCreateCb = function (err, result) {
                    // Capture results - we'll need the image_uuid.
                    imageSdcDocker = result;
                    next(err);
                };
                var event = {
                    callback: imageCreateCb,
                    payload: {
                        finalId: finalImageId,
                        image: dockerImage,
                        size: size,
                        virtual_size: cumulativeSize
                    },
                    type: 'image_create'
                };
                builder.emit('task', event);
            },
            function doZfsSnapshotTarStream(next) {
                var snapOpts = {
                    commandType: builder.commandType,
                    log: log,
                    parent_snapshot: gSnapshots[idx - 1].name,
                    snapshot: snapshotName,
                    zoneUuid: builder.zoneUuid
                };
                zfsSnapshotStream(snapOpts, function zStrmCb(err, stream) {
                    imageOrigStream = stream;
                    next(err);
                }, onZfsProcessError);
            },
            function doShasumTarStream(next) {
                function onHashEnd(digest) {
                    imageSha1sum = digest;
                }
                var hashPassthrough = digestStream('sha1', 'hex', onHashEnd);
                // The image stream will be passed to imgapi import, so ensure
                // it's (imgapi) paused.
                imageStream = hashPassthrough;
                IMGAPI.pauseStream(imageStream);
                imageOrigStream.pipe(hashPassthrough);

                next();
            },
            function doImgapiImportFromZfsTar(next) {
                var addOpts = {
                    account_uuid: opts.payload.account_uuid,
                    imgapi: imgapi,
                    imageFile: imageStream,
                    image_uuid: imageSdcDocker.image_uuid,
                    log: log,
                    req_id: opts.req_id
                };
                imgapiAddFile(addOpts, function _imgAddZfsCb(err, img) {
                    if (err) {
                        log.error('imgapiAddFile error, image uuid %s - err %s',
                            imageSdcDocker.image_uuid, err);
                    } else {
                        log.debug('imgapi.addImageFile was successful');
                        image = img;
                    }
                    next(err);
                });
            },
            function doImgapiValidate(next) {
                if (zfsProcessError) {
                    log.error('zfs process error: %s', zfsProcessError);
                    next(zfsProcessError);
                    return;
                }
                validateImage(image, {log: log, sha1sum: imageSha1sum}, next);
            },
            function doImgapiActivate(next) {
                var activeateOpts = {
                    imgapi: imgapi,
                    log: log,
                    req_id: opts.req_id
                };
                imgapiActivate(image, activeateOpts, next);
           }
        ], function importCleanup(err) {
            if (err) {
                if (!imageSdcDocker) {
                    log.error('Unable to import image into imgapi: %s', err);
                    cb(err);
                    return;
                }
                // Remove this image as it failed to import/validate.
                var image_uuid = imageSdcDocker.image_uuid;
                log.error('Unable to import image %s into imgapi: %s',
                    image_uuid, err);
                // Remove this image if it failed to import/validate.
                var deleteImageCb = function _deleteImageCb(deleteErr) {
                    if (deleteErr) {
                        log.warn('Unable to delete image %s', image_uuid);
                    }
                    // Ignore the deleteErr here, and then preferring the
                    // zfsProcessError over the general err when available.
                    cb(zfsProcessError || err);
                };
                imgapi.deleteImage(image_uuid, opts.payload.account_uuid,
                    deleteImageCb);
                return;
            }
            cb();
        });
    }, callback);
}


/**
 * Look up the zfs snapshot size - these will be passed to sdc-docker
 * createImage api (i.e. for showing in `docker images`).
 */
function zfsGetSnapshotSizes(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.snapshot, 'opts.snapshot');
    assert.string(opts.zoneUuid, 'opts.zoneUuid');
    assert.func(callback, 'callback');

    var log = opts.log;
    var snapshot = opts.snapshot;
    var zoneUuid = opts.zoneUuid;
    var zfsName = sprintf('zones/%s@%s', zoneUuid, snapshot);

    zfs.get(zfsName, ['used', 'referenced'], true,
        function _zfsGetCb(err, propertyMap)
    {
        if (err) {
            log.error('zfs.get error: %s', err);
            callback(err);
            return;
        }
        if (!propertyMap.hasOwnProperty(zfsName)) {
            log.error();
            callback(new Error(sprintf('no zfs properties found for name: %s',
                                        zfsName)));
            return;
        }
        callback(null, propertyMap[zfsName]);
    });
}


/**
 * Create zfs snapshot tar stream and pass back the stdout (image) stream via
 * the callback.
 *
 * The onError function is called for any process errors.
 */
function zfsSnapshotStream(opts, callback, onProcessError) {
    assert.object(opts, 'opts');
    assert.string(opts.commandType, 'opts.commandType');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.parent_snapshot, 'opts.parent_snapshot');
    assert.string(opts.snapshot, 'opts.snapshot');
    assert.string(opts.zoneUuid, 'opts.zoneUuid');
    assert.func(callback, 'callback');
    assert.func(onProcessError, 'onProcessError');

    var log = opts.log;
    var onProcessErrorCalled = false;
    var parent_snapshot = opts.parent_snapshot;
    var snapshot = opts.snapshot;
    var stderr = '';
    var zoneUuid = opts.zoneUuid;

    var snapshotFullname = util.format('zones/%s@%s', zoneUuid, snapshot);
    var zfsBase = sprintf('zones/%s', zoneUuid);
    var args = [
        '-r', 'root',                         // Include zone root directory
        '-x', 'native',                       // Exclude anything in /native/
        '-x', 'checkpoints',                  // Exclude snapshot /checkpoints/
        '-x', 'var/svc/provision_success',    // Exclude vm provisioning file
        '-x', 'var/log/sdc-dockerinit.log'    // Exclude sdc docker log file
    ];
    if (opts.commandType === 'commit') {
        // For commit, the parent_snapshot is in a different zfs dataset to
        // snapshotFullname, so we have to use the special '-e' argument to
        // zfs_snapshot_tar and provide the full snapshot names.
        args = args.concat(['-e', parent_snapshot, snapshotFullname]);
    } else {
        // For build, both snapshot names are from the same dataset, so we pass
        // the dataset name (zfsBase) and the short (or full) snapshot name to
        // zfs_snapshot_tar.
        args = args.concat([zfsBase, parent_snapshot, snapshot]);
    }

    log.debug({cmd: gSnapshotTarExe, args: args}, 'Creating image tar stream');

    try {
        var zfsProc = child_process.spawn(gSnapshotTarExe, args);
    } catch (ex) {
        log.error('zfs_snapshot_tar error: %s', ex);
        callback(ex);
        return;
    }

    zfsProc.on('error', function _zfsProcOnError(err) {
        log.debug('zfs_snapshot_tar generated error %s', err);
        if (onProcessErrorCalled) {
            return;
        }
        onProcessErrorCalled = true;
        onProcessError(err);
    });
    zfsProc.on('exit', function _zfsProcOnExit(code, signal) {
        log.debug('zfs_snapshot_tar exited with code: %d', code);
        if (stderr) {
            log.debug('zfs_snapshot_tar stderr: %s', stderr);
        }
        if (code !== null && code !== 0) {
            log.error('zfs_snapshot_tar failed - stderr: %s', stderr);
            if (onProcessErrorCalled) {
                return;
            }
            onProcessErrorCalled = true;
            onProcessError(new Error(sprintf('zfs_snapshot_tar exited with '
                + 'code: %d', code)));
            return;
        }
    });
    zfsProc.stderr.on('readable', function _zfsProcOnReadable() {
        var chunk;
        while ((chunk = this.read()) != null) {
            log.debug('zfs_snapshot_tar generated %d bytes stderr',
                chunk.length);
            stderr += String(chunk);
        }
    });

    callback(null, zfsProc.stdout);
}


/**
 * Import the given image into imgapi.
 */
function imgapiAddFile(opts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.account_uuid, 'opts.account_uuid');
    assert.object(opts.imgapi, 'opts.imgapi');
    assert.object(opts.imageFile, 'opts.imageFile');
    assert.string(opts.image_uuid, 'opts.image_uuid');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.optionalNumber(opts.size, 'opts.size');
    assert.func(callback, 'callback');

    var imgapi = opts.imgapi;
    var log = opts.log;

    var addImageOpts = {
        'compression': 'none',
        file: opts.imageFile,
        headers: { 'x-request-id': opts.req_id },
        owner_uuid: opts.account_uuid,
        uuid: opts.image_uuid
    };
    if (opts.hasOwnProperty('size')) {
        addImageOpts.size = opts.size;
    }
    log.debug('imgapi.addImageFile %s', opts.image_uuid);
    imgapi.addImageFile(addImageOpts, opts.account_uuid, callback);
}


/**
 * Ensure the final image's sha1sum matches what zfs_snapshot_tar produced.
 */
function validateImage(image, opts, callback) {
    assert.object(image, 'image');
    assert.arrayOfObject(image.files, 'image.files');
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.sha1sum, 'opts.sha1sum');
    assert.func(callback, 'callback');

    assert.ok(image.files.length === 1,
        sprintf('Expected one image file - got %d', image.files.length));

    var log = opts.log;
    var imageSha1 = image.files[0].sha1;

    log.debug('image.sha1: %j, expected sha1: %j', imageSha1, opts.sha1sum);

    if (imageSha1 !== opts.sha1sum) {
        callback(new Error('imgapi sha1 mismatch - data corruption occured'));
        return;
    }

    callback();
}


/**
 * Use imgapi to activate the given image.
 */
function imgapiActivate(image, opts, callback) {
    assert.object(image, 'image');
    assert.object(opts, 'opts');
    assert.object(opts.imgapi, 'opts.imgapi');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.func(callback, 'callback');

    var log = opts.log;
    var addImageOpts = {
        headers: { 'x-request-id': opts.req_id }
    };
    log.debug('imgapi.activateImage %j', image.uuid);
    opts.imgapi.activateImage(image.uuid, image.owner_uuid, addImageOpts,
        function activateImageCb(err)
    {
        callback(err);
    });
}
