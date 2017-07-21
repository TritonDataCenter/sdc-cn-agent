/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
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
var zlib = require('zlib');

var assert = require('assert-plus');
var async = require('async');
var bunyan = require('bunyan');
var digestStream = require('digest-stream');
var dockerbuild = require('sdc-docker-build');
var IMGAPI = require('sdc-clients').IMGAPI;
var imgmanifest = require('imgmanifest');
var jsprim = require('jsprim');
var mkdirp = require('mkdirp');
var mod_uuid = require('uuid');
var rimraf = require('rimraf');
var sprintf = require('sprintf').sprintf;
var zfs = require('zfs').zfs;

var LineStream = require('lstream');
var smartDcConfig = require('../lib/task_agent/smartdc-config');


var SERVER_CLOSE_TIMEOUT = 60 * 1000; // 1 minute
var messageId = 0;  // The id for a message sent over socket.
var gBaseImageUuid = null;  // Base image uuid the build is working from.
var gImgapiClient = null;  // IMGAPI client.
var gScratchImageUuid = null;  // Scratch image uuid in IMGAPI.
var gSnapshotId = 0;  // Snapshot id counter.
var gSnapshots = [];  // Snapshots created during the build.
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

    if (commandType === 'build') {
        assert.string(message.payload.scratchImageUuid,
            'message.payload.scratchImageUuid');
        gScratchImageUuid = message.payload.scratchImageUuid;
        // Start with scratch, will get updated by reprovision later.
        gBaseImageUuid = gScratchImageUuid;
    } else {
        assert.object(message.payload.fromImg, 'message.payload.fromImg');
        assert.string(message.payload.fromImg.image_uuid,
            'message.payload.fromImg.image_uuid');
        gBaseImageUuid = message.payload.fromImg.image_uuid;
    }

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

    // Create IMGAPI client.
    gImgapiClient = new IMGAPI({url: message.payload.imgapi_url});

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
                gImgapiClient.close();
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
 * Check if the cmd is a metadata command - i.e. doesn't modify the filesystem.
 */
function isMetadataCmd(cmd) {
    if (!cmd) {
        return false;
    }
    return ['ADD', 'COPY', 'RUN'].indexOf(cmd.name) === -1;
}


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


/**
 * Remove joyent specific labels that we don't want inside the built image.
 */
function sanitizeLabels(labels) {
    delete labels['com.joyent.package'];
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
    assert.string(opts.req_id, 'opts.req_id');
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

    // Before we start, we want all files created by docker build/commit to use
    // 'root:root' permissions. Note that the cn-agent (parent) process defaults
    // to using 'root:staff' permissions.
    // We do this so that we can avoid having to 'chown' files that get added by
    // the ADD/COPY instructions (that way we don't need to keep track of what
    // was copied and we avoid the performance of calling chown).
    // Note that this should not be needed if we change the tar extraction to
    // run inside of the zone - DOCKER-872.
    process.setuid(0);
    process.setgid(0);

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
        gImgapiClient.close();
    }
}


/**
 * Create sdc-docker-build Builder instance and manage the building process.
 *
 * Communicates (relay) between sdc-docker and the docker Builder.
 */
function buildFromContext(opts, callback) {
    assert.object(opts.payload, 'opts.payload');
    assert.string(opts.req_id, 'opts.req_id');

    var log = opts.log;
    var setScratchImageUuid = false;
    var socket = opts.buildSocket;
    var pendingCallbackEvents = {};

    socket.on('end', function () {
        log.debug('buildFromContext: socket.end received');
    });

    // Handle events from sdc-docker - usually this will be an answer (callback)
    // to a request the build system has made.
    var buildEventStream = new LineStream();
    socket.pipe(buildEventStream);

    buildEventStream.on('readable', function buildFromContextOnReadable() {
        var line = this.read();
        while (line) {
            onLine(line);
            line = this.read();
        }
    });

    function onLine(line) {
        log.debug('client event received: %j', line);
        var event;
        var id;
        var cbEvent;
        try {
            event = JSON.parse(line);
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
    }

    // Sanitize labels.
    var labels = JSON.parse(opts.payload.labels || '{}');
    sanitizeLabels(labels);
    labels = JSON.stringify(labels);

    var buildOpts = {
        buildargs: opts.payload.buildargs,
        commandType: 'build',
        containerRootDir: path.join('/zones', opts.uuid, 'root'),
        contextFilepath: opts.contextFilepath,
        dockerfile: opts.payload.dockerfile,
        labels: labels,
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
            case 'find_cached_image':
                sendEvent(event, {socket: socket, log: log});
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

    builder.__setBaseImg = builder.setBaseImg;
    builder.setBaseImg = builderSetBaseImg.bind(builder);

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
            if (builder.stepNo === 0) {
                // The first 'FROM' build step doesn't create a layer.
                assert.equal(cmd.name, 'FROM', 'First command must be "FROM"');
                if (cmd.args === 'scratch') {
                    // Need to set the base image uuid in the next step.
                    setScratchImageUuid = true;
                }
                cb();
                return;
            }
            if (setScratchImageUuid) {
                var buildLayer = builder.layers[builder.layers.length-1];
                buildLayer.uuid = gScratchImageUuid;
                setScratchImageUuid = false;
            }
            createDockerLayer(builder, cmd, { log: log, req_id: opts.req_id },
                cb);
        });
    };

    builder.on('end', function (err) {
        async.waterfall([
            function checkError(cb) {
                cb(err);
            },
            function notifySuccess(next) {
                log.debug('notifySuccess');
                var event = {
                    callback: next,
                    finalImageDigest: builder.layers.slice(-1)[0].imageDigest,
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


function builderSetBaseImg(cmd, img) {
    // Note: img is a docker ImageV2 model instance. For reference,
    // like this:
    //  {
    //    config_digest: this.params.config_digest,
    //    created: this.params.created,
    //    head: this.params.head,
    //    image: this.params.image,
    //    image_uuid: this.params.image_uuid,
    //    manifest_str: this.params.manifest_str,
    //    manifest_digest: this.params.manifest_digest,
    //    owner_uuid: this.params.owner_uuid,
    //    size: this.params.size
    //  }

    assert.object(img, 'img');
    assert.object(img.image, 'img.image');
    assert.arrayOfObject(img.image.history, 'img.image.history');
    assert.object(img.image.rootfs, 'img.image.rootfs');
    assert.arrayOfString(img.image.rootfs.diff_ids,
        'img.image.rootfs.diff_ids');
    assert.string(img.image_uuid, 'img.image_uuid');
    assert.string(img.manifest_str, 'img.manifest_str');

    var builder = this;
    var diffIdx = 0;
    var layerDigests = [];

    try {
        var manifest = JSON.parse(img.manifest_str);
    } catch (ex) {
        throw new Error('Unable to parse img.manifest_str: ' + ex);
    }

    assert.arrayOfObject(manifest.layers, 'manifest.layers');
    assert.equal(manifest.layers.length, img.image.rootfs.diff_ids.length,
        'manifest.layers length should equal rootfs.diff_ids length');

    builder.layers = img.image.history.map(function (history) {
        var layer = {
            cmd: null,
            historyEntry: history,
            image: null,
            imageDigest: null
        };
        if (!history.empty_layer) {
            assert.ok(diffIdx < img.image.rootfs.diff_ids.length,
                'diffIdx out of range');
            layer.fileDigest = manifest.layers[diffIdx].digest;
            layer.manifestLayerEntry = manifest.layers[diffIdx];
            layer.size = manifest.layers[diffIdx].size;
            layer.uncompressedDigest = img.image.rootfs.diff_ids[diffIdx];
            layerDigests.push(layer.fileDigest);
            layer.uuid = imgmanifest.imgUuidFromDockerDigests(layerDigests);
            diffIdx += 1;
        }
        return layer;
    });

    // Update last layer.
    var buildLayer = builder.layers[builder.layers.length - 1];
    buildLayer.cmd = cmd;
    buildLayer.image = jsprim.deepCopy(img.image);
    buildLayer.imageDigest = img.config_digest;
    buildLayer.uuid = img.image_uuid;

    // Update current image.
    builder.image = jsprim.deepCopy(img.image);
    builder.setImageId(img.config_digest);

    gBaseImageUuid = img.image_uuid;
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
    destroySnapshots(gSnapshots, builder, function _destroySnapsCb(err) {
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
    assert.optionalString(opts.payload.author, 'opts.payload.author');
    assert.arrayOfString(opts.payload.changes, 'opts.payload.changes');
    assert.optionalString(opts.payload.comment, 'opts.payload.comment');
    assert.object(opts.payload.fromImg, 'opts.payload.fromImg');

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

    commitEventStream.on('readable', function commitImageOnReadable() {
        var line = this.read();
        while (line) {
            onLine(line);
            line = this.read();
        }
    });

    function onLine(line) {
        log.debug('client event received: %j', line);
        var event;
        var id;
        var cbEvent;
        try {
            event = JSON.parse(line);
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
    }

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

    builder.__setBaseImg = builder.setBaseImg;
    builder.setBaseImg = builderSetBaseImg.bind(builder);

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
        async.series([
            function checkBuildError(cb) {
                cb(err);
            },
            // Update image metadata with user provided arguments.
            function updateFinalImage(cb) {
                var image = builder.layers.slice(-1)[0].image;
                if (opts.payload.author) {
                    image.author = opts.payload.author;
                }
                if (opts.payload.comment) {
                    image.comment = opts.payload.comment;
                }
                // Sanitize labels.
                if (image.config && image.config.Labels) {
                    sanitizeLabels(image.config.Labels);
                }
                if (image.container_config && image.container_config.Labels) {
                    sanitizeLabels(image.container_config.Labels);
                }
                cb();
            },
            function createCommitImage(cb) {
                createDockerLayer(builder, null, opts, cb);
            },
            function notifySuccess(next) {
                log.debug('notifySuccess');
                var event = {
                    callback: next,
                    finalImageDigest: builder.layers.slice(-1)[0].imageDigest,
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

    builder.startCommit(opts.payload.fromImg, opts.payload.changes);
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
    mkdirp(extractDir, function (err) {
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
 * Create a docker image layer for for the current build step.
 */
function createDockerLayer(builder, cmd, opts, callback) {
    var buildLayer = builder.layers[builder.layers.length - 1];
    var log = builder.log;

    log.debug('Creating image for step %d', builder.stepNo);

    if (isMetadataCmd(cmd)) {
        createDockerManifests(builder);
        createSdcDockerImage(builder, callback);
        return;
    }

    async.series([
        function createSnapshot(next) {
            createZfsSnapshot(builder, next);
        },
        function importSnapshot(next) {
            importImageSnapshotIntoImgapi(builder, opts, next);
        },
        function createManifests(next) {
            createDockerManifests(builder);
            next();
        },
        function updateLayer(next) {
            updateImgapiMetadata(builder, opts, next);
        },
        function activate(next) {
            imgapiActivate(buildLayer.newImgManifest, opts, next);
        },
        function createImage(next) {
            createSdcDockerImage(builder, next);
        }
    ], callback);
}


/**
 * Create a zfs snapshot for the current build step.
 */
function createZfsSnapshot(builder, callback) {
    assert.object(builder, 'builder');
    assert.func(callback, 'callback');

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
            callback(err);
            return;
        }
        gSnapshots.push({
            name: snapshotName,
            layerIdx: builder.layers.length - 1
        });
        var buildLayer = builder.layers[builder.layers.length - 1];
        buildLayer.snapshotName = snapshotName;
        callback();
    });
}


/**
 * Add image history entries.
 *
 *  [
 *    {
 *      "created": "2016-05-05T18:13:29.963947682Z",
 *      "author": "Me Now <me@now.com>",
 *      "created_by": "/bin/sh -c #(nop) MAINTAINER Me Now <me@now.com>",
 *      "empty_layer": true
 *    }, {
 *      "created": "2016-05-05T18:13:30.218788521Z",
 *      "author": "Me Now <me@now.com>",
 *      "created_by": "/bin/sh -c #(nop) ADD file:c59222783...364a in /"
 *    }, {
 *      "created": "2016-05-05T18:13:30.456465331Z",
 *      "author": "Me Now <me@now.com>",
 *      "created_by": "/bin/touch /odd.txt"
 *    }
 *  ]
 */
function historyEntryForCmdAndImage(cmd, image) {
    var entry = {
        created: image.created,
        created_by: image.container_config.Cmd.join(' ')
    };

    if (isMetadataCmd(cmd)) {
        entry.empty_layer = true;
    }
    if (image.author) {
        entry.author = image.author;
    }
    if (image.comment) {
        entry.comment = image.comment;
    }

    return entry;
}


function v1ImageFromLayers(layers) {
    assert.arrayOfObject(layers, 'layers');

    var image = layers.slice(-1)[0].image;

    image.history = layers.map(function (layer) {
        if (layer.historyEntry) {
            return layer.historyEntry;
        }
        return historyEntryForCmdAndImage(layer.cmd, layer.image);
    });

    /**
     * Add RootFS layers.
     *
     * {
     *   "type": "layers",
     *   "diff_ids": [
     *       "sha256:3f69a7949970fe2d62a5...c65003d01ac3bbe8645d574b",
     *       "sha256:f980315eda5e9265282c...41b30de83027a2077651b465",
     *       "sha256:30785cd7f84479984348...533457f3a5dcf677d0b0c51e"
     *   ]
     * }
     */
    assert.equal(layers.length, image.history.length,
        'Layers and image history must be the same length');
    var nonEmptyLayers = layers.filter(function _filterEmpty(layer, idx) {
        return !image.history[idx].empty_layer;
    });
    image.rootfs = {
        type: 'layers',
        diff_ids: nonEmptyLayers.map(function _getRootfsDiffId(layer) {
            assert.string(layer.uncompressedDigest, 'layer.uncompressedDigest');
            return layer.uncompressedDigest;
        })
    };

    return image;
}


function createV2Manifest(image, layers) {
    var imageStr = JSON.stringify(image);
    var imageDigest = 'sha256:' + crypto.createHash('sha256')
        .update(imageStr, 'binary').digest('hex');

    var manifest = {
        schemaVersion: 2,
        mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
        config: {
            'mediaType': 'application/vnd.docker.container.image.v1+json',
            'size': imageStr.length,
            'digest': imageDigest
        },
        layers: layers.filter(function _filterLayers(layer) {
            return layer.fileDigest;
        }).map(function _mapLayers(layer) {
            if (layer.manifestLayerEntry) {
                assert.object(layer.manifestLayerEntry,
                    'layer.manifestLayerEntry');
                return layer.manifestLayerEntry;
            }
            assert.object(layer.imgManifest, 'layer.imgManifest');
            var compressionSuffix = '';
            var imgManifest = layer.imgManifest;
            var imgFile = imgManifest.files[0];
            if (imgFile.compression && imgFile.compression !== 'none') {
                compressionSuffix = '.' + imgFile.compression;
            }
            return {
                digest: layer.fileDigest,
                mediaType: 'application/vnd.docker.image.rootfs.diff.tar' +
                    compressionSuffix,
                size: imgFile.size
            };
        })
    };

    return manifest;
}


/**
 * Use snapshot to create an image and import it into imgapi.
 */
function importImageSnapshotIntoImgapi(builder, opts, callback) {
    assert.object(builder, 'builder');
    assert.object(opts, 'opts');
    assert.string(opts.req_id, 'opts.req_id');
    assert.func(callback, 'callback');

    assert.ok(gSnapshots.length >= 1, 'gSnapshots.length >= 1');
    assert.ok(builder.layers.length >= 1, 'builder.layers.length >= 1');

    var isAgainstBaseImage = (gSnapshots.length === 1);
    var buildLayer = builder.layers[builder.layers.length - 1];
    var imgapiOpts = {
        headers: { 'x-request-id': opts.req_id }
    };
    var log = builder.log;
    var layerStream;
    var parentSnapshotName;
    var previousLayer = builder.layers[builder.layers.length - 2];
    var snapshotName = buildLayer.snapshotName;
    var zfsProcessError;
    var zfsTarStream;

    // Faked repo and tag (aka rat).
    // TODO: Should we use the original docker build tag here?
    var rat = {
        localName: '',
        index: {
            name: 'docker.io'
        }
    };

    if (isAgainstBaseImage) {
        // Working off the base (or cached) image.
        parentSnapshotName = sprintf('zones/%s@final', gBaseImageUuid);
        log.debug({baseSnapshot: parentSnapshotName}, 'Base image snapshot');
    } else {
        parentSnapshotName = gSnapshots[gSnapshots.length - 2].name;
    }

    log.info('importing layer for step %d into IMGAPI', builder.stepNo);

    function onZfsProcessError(err) {
        zfsProcessError = err;
    }

    /*
     * buildLayer will end up like this:
     * {
     *   cmd: <original Cmd object used to create this layer>
     *   configDigest: <'sha256:' + sha256 sum of config string>
     *   fileDigest: <'sha256:' + sha256 sum of file>
     *   image: <build image object>
     *   imageDigest: <'sha256:' + sha256 sum of stringified image>
     *   sha1: <sha1 sum of the file>
     *   size: <size of uncompressed file>
     *   snapshotName: <name of the zfs snapshot>
     *   uncompressedDigest: <'sha256:' + sha256 sum of uncompressed file>
     *   uuid: <final IMGAPI uuid>
     *   uuidPlaceholder: <placeholder IMGAPI uuid>
     * }
     */

    async.series([
        // Create the place holder image that will be updated later.
        function doImgapiCreatePlaceholder(next) {
            // A temporary image uuid is used to store the image.
            buildLayer.uuidPlaceholder = mod_uuid.v4();
            var origin = (previousLayer ? previousLayer.uuid : '');
            // The digest/id and imgManifest are just placeholders (fakes)
            // until the real ones are generated in `activateImages`.
            buildLayer.imgManifest = imgmanifest.imgManifestFromDockerInfo({
                layerDigests: [buildLayer.imageDigest],  // Place holder.
                imgJson: buildLayer.image,
                origin: origin,
                public: false,
                repo: rat,
                uuid: buildLayer.uuidPlaceholder
            });
            log.debug({imgManifest: buildLayer.imgManifest},
                'placeholder imgManifest');
            gImgapiClient.adminImportImage(buildLayer.imgManifest, imgapiOpts,
                    function _adminImportCb(err) {
                if (err) {
                    log.error('Unable to create imgapi placeholder image: %s',
                        err);
                }
                next(err);
            });
        },

        function doZfsSnapshotTarStream(next) {
            var snapOpts = {
                explicitParent: isAgainstBaseImage,
                log: log,
                parent_snapshot: parentSnapshotName,
                snapshot: snapshotName,
                zoneUuid: builder.zoneUuid
            };
            zfsSnapshotStream(snapOpts, function zStrmCb(err, stream) {
                zfsTarStream = stream;
                next(err);
            }, onZfsProcessError);
        },

        function doShasumTarStream(next) {
            var uncompSha256Stream = digestStream('sha256', 'hex',
                function _uncompSha256End(digest, len) {
                    buildLayer.uncompressedDigest = 'sha256:' + digest;
                    buildLayer.size = len;
                });
            var sha256Stream = digestStream('sha256', 'hex',
                function _sha256End(digest) {
                    buildLayer.fileDigest = 'sha256:' + digest;
                });
            var sha1Stream = digestStream('sha1', 'hex',
                function _sha1End(digest) {
                    buildLayer.sha1 = digest;
                });
            // The layer stream will be passed to imgapi import, so ensure
            // it's (imgapi) paused.
            layerStream = sha1Stream;
            IMGAPI.pauseStream(layerStream);
            zfsTarStream.pipe(uncompSha256Stream)      // For rootfs field
                .pipe(zlib.createGzip())               // Compressing layer
                .pipe(sha256Stream)                    // For layer digest
                .pipe(sha1Stream);                     // To verify upload
            next();
        },

        function doImgapiImportFromZfsTar(next) {
            var addOpts = {
                imageFile: layerStream,
                image_uuid: buildLayer.uuidPlaceholder,
                log: log,
                req_id: opts.req_id
            };
            imgapiAddFile(addOpts, function _imgAddZfsCb(err, img) {
                if (err) {
                    log.error({uuid: buildLayer.uuidPlaceholder},
                        'imgapiAddFile error - %s', err);
                } else {
                    log.debug({uuid: buildLayer.uuidPlaceholder},
                        'imgapi.addImageFile was successful');
                    buildLayer.imgManifest = img;
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
            validateImage(buildLayer.imgManifest,
                {log: log, sha1sum: buildLayer.sha1}, next);
        }
    ], callback);
}


function updateImgapiMetadata(builder, opts, callback) {
    var buildLayer = builder.layers[builder.layers.length-1];
    var log = builder.log;

    // Layer (snapshot) has been uploaded into IMGAPI. We now have the digest
    // (sha256) of the layer, so we now need to update the IMGAPI image (with
    // new uuid and file sha256 sums), then activate the image (layer) in
    // IMGAPI.
    log.debug('buildLayer: ', buildLayer);

    var imgapiOpts = {
        headers: { 'x-request-id': opts.req_id }
    };
    var layerDigests = builder.layers.filter(function (l) {
        return l.fileDigest;
    }).map(function (l) {
        return l.fileDigest;
    });
    log.debug('layerDigests: ', layerDigests);

    // Have to update these IMGAPI image fields:
    //  * uuid
    //  * origin
    //  * tags.docker:id
    //  * version
    //  * files[0].digest
    //  * files[0].uncompressedDigest
    assert.string(buildLayer.imageDigest, 'buildLayer.imageDigest');
    var dockerId = imgmanifest.dockerIdFromDigest(
        buildLayer.imageDigest);
    var oldUuid = buildLayer.uuidPlaceholder;
    var newImg = jsprim.deepCopy(buildLayer.imgManifest);
    newImg.uuid = imgmanifest.imgUuidFromDockerDigests(
        layerDigests);
    if (layerDigests.length > 1) {
        newImg.origin = imgmanifest.imgUuidFromDockerDigests(
            layerDigests.slice(0, -1));
    }
    newImg.tags['docker:id'] = buildLayer.imageDigest;
    newImg.version = imgmanifest.shortDockerId(dockerId);
    newImg.files[0].digest = buildLayer.fileDigest;
    newImg.files[0].uncompressedDigest = buildLayer.uncompressedDigest;

    // Remove fields used by create but not allowed in update.
    delete newImg.disabled;
    delete newImg.published_at;
    delete newImg.type;
    delete newImg.v;
    delete newImg.owner;

    log.debug({uuid: oldUuid, imgManifest: newImg}, 'updating IMGAPI manifest');
    gImgapiClient.updateImage(oldUuid, newImg, undefined,
            imgapiOpts,
            function _updateImageCb(updateErr, img) {
        if (!updateErr) {
            log.debug({updatedImgManifest: img}, 'Updated IMGAPI manifest');
            // Save the updated IMGAPI manigest and uuid.
            buildLayer.newImgManifest = newImg;
            buildLayer.uuid = newImg.uuid;
        }
        callback(updateErr);
    });
}


/**
 * Create docker image manifest and config manifest for the current layer(s).
 */
function createDockerManifests(builder) {
    var buildLayer = builder.layers[builder.layers.length - 1];
    var image = v1ImageFromLayers(builder.layers);
    var manifest = createV2Manifest(image, builder.layers);
    var manifestStr = JSON.stringify(manifest, null, 4);
    var manifestDigest = 'sha256:' + crypto.createHash('sha256')
        .update(manifestStr, 'binary').digest('hex');

    builder.setImageId(manifest.config.digest);
    builder.image = image;
    buildLayer.image = jsprim.deepCopy(image);
    buildLayer.imageDigest = manifest.config.digest;
    buildLayer.manifest = manifest;
    buildLayer.manifestDigest = manifestDigest;
    buildLayer.manifestStr = manifestStr;

    // Freeze the image and manifest - they are not allowed to change as we have
    // generated the digests for them.
    Object.freeze(buildLayer.image);
    Object.freeze(manifest);
}


/**
 * Create sdc-docker image for this layer.
 */
function createSdcDockerImage(builder, callback) {
    var buildLayer = builder.layers[builder.layers.length - 1];

    // Fix up the image_uuid reference for metadata layers.
    if (!buildLayer.uuid) {
        assert.ok(builder.layers.length > 1, 'Must be more than 1 layer');
        assert.ok(isMetadataCmd(buildLayer.cmd),
            'No uuid expected only for metadata commands');
        // Keep the same uuid as the last layer.
        var previousLayer = builder.layers[builder.layers.length - 2];
        assert.string(previousLayer.uuid, 'previousLayer.uuid');
        buildLayer.uuid = previousLayer.uuid;
    }
    builder.log.debug('buildLayer: ', buildLayer);
    assert.string(buildLayer.uuid, 'buildLayer.uuid');

    builder.log.debug({manifest: buildLayer.manifestStr, uuid: buildLayer.uuid},
        'sdc-docker create image');

    // Calculate total (cumalative) size - note that metadata layers don't have
    // a file, thus they won't have a size property.
    var cumulativeSize = builder.layers.reduce(function (a, l) {
        return a + (l.size || 0);
    }, 0);

    var event = {
        callback: callback,
        payload: {
            config_digest: buildLayer.imageDigest,
            head: builder.isLastStep(),
            image: buildLayer.image,
            image_uuid: buildLayer.uuid,
            manifest_digest: buildLayer.manifestDigest,
            manifest_str: buildLayer.manifestStr,
            size: cumulativeSize
        },
        type: 'image_create'
    };
    builder.emit('task', event);
}


/**
 * Create zfs snapshot tar stream and pass back the stdout (image) stream via
 * the callback.
 *
 * The onError function is called for any process errors.
 */
function zfsSnapshotStream(opts, callback, onProcessError) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.parent_snapshot, 'opts.parent_snapshot');
    assert.string(opts.snapshot, 'opts.snapshot');
    assert.string(opts.zoneUuid, 'opts.zoneUuid');
    assert.func(callback, 'callback');
    assert.func(onProcessError, 'onProcessError');
    assert.optionalBool(opts.explicitParent, 'opts.explicitParent');

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
        '-x', 'system',                       // Exclude the system contract dir
        '-x', 'etc/hostname',                 // Exclude etc hostname
        '-x', 'etc/hosts',                    // Exclude etc hosts
        '-x', 'etc/mnttab',                   // Exclude etc mount table
        '-x', 'etc/resolv.conf',              // Exclude etc resolver
        '-x', 'var/log/sdc-dockerinit.log',   // Exclude sdc docker log file
        '-x', 'var/run',                      // Exclude vm run dir
        '-x', 'var/svc/provisioning',         // Exclude vm provisioning file
        '-x', 'var/svc/provision_failure',    // Exclude vm provisioning file
        '-x', 'var/svc/provision_success'     // Exclude vm provisioning file
    ];
    if (opts.explicitParent) {
        // The parent_snapshot is in a different zfs dataset to
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
                + 'code: %d (%s)', code, stderr.substr(0, 1024))));
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
    assert.object(opts.imageFile, 'opts.imageFile');
    assert.string(opts.image_uuid, 'opts.image_uuid');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.optionalNumber(opts.size, 'opts.size');
    assert.func(callback, 'callback');

    var log = opts.log;

    var addImageOpts = {
        compression: 'gzip',
        file: opts.imageFile,
        headers: { 'x-request-id': opts.req_id },
        uuid: opts.image_uuid
    };
    if (opts.hasOwnProperty('size')) {
        addImageOpts.size = opts.size;
    }
    log.debug('imgapi.addImageFile %s', opts.image_uuid);
    gImgapiClient.addImageFile(addImageOpts, callback);
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
    assert.object(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.func(callback, 'callback');

    var log = opts.log;
    var addImageOpts = {
        headers: { 'x-request-id': opts.req_id }
    };
    log.debug('imgapi.activateImage %j', image.uuid);
    gImgapiClient.activateImage(image.uuid, undefined, addImageOpts,
        function activateImageCb(err)
    {
        callback(err);
    });
}
