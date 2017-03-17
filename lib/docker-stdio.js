/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * The logic contained in this file is responsible for plumbing the various
 * input/output connections and sockets necessary for communicating with docker
 * containers.
 */


var assert = require('assert-plus');
var async = require('async');
var bunyan = require('bunyan');
var once = require('once');
var child_process = require('child_process');
var fs = require('fs');
var http = require('http');
var net = require('net');
var path = require('path');
var pty = require('pty.js');
var spawn = child_process.spawn;
var execFile = child_process.execFile;
var vmadm = require('vmadm');

var LineStream = require('lstream');
var wait_flag = require('./update-wait-flag');

var commands = {};
var CTRL_P = '\u0010';
var CTRL_Q = '\u0011';

/**
 * Sets up a mechanism for starting a server to relay the contents of a file.
 */

function setupDockerFileStream(opts, callback) {
    assert.number(opts.timeoutSeconds, 'opts.timeoutSeconds');
    assert.string(opts.uuid, 'opts.uuid');
    assert.string(opts.admin_ip, 'opts.admin_ip');
    assert.string(opts.path, 'opts.path');
    assert.optionalBool(opts.no_overwrite_dir, 'opts.no_overwrite_dir');
    assert.string(opts.mode, 'opts.mode');
    assert.string(opts.req_id, 'opts.req_id');

    opts.log = bunyan.createLogger({name: 'docker-stdio', req_id: opts.req_id});

    if (opts.mode === 'read' || !opts.mode) {
        createDockerFileReadStreamServer(opts, function (err, server, extra) {
            if (err) {
                callback(err);
                return;
            }
            callback(null, {
                port: server.address().port,
                containerPathStat: extra.containerPathStat
            });
        });
    } else if (opts.mode === 'write') {
        createDockerFileWriteStreamServer(opts, function (err, server) {
            if (err) {
                callback(err);
                return;
            }
            callback(null, { port: server.address().port });
        });
    } else if (opts.mode === 'stat') {
        getDockerContainerPathStat(opts, function (err, extra) {
            if (err) {
                callback(err);
                return;
            }
            callback(null, { containerPathStat: extra.containerPathStat });
        });
    } else {
        callback(new Error('unknown mode: ' + opts.mode));
        return;
    }
}


/**
 * Sets up a mechanism for starting a server to relay stdio to a command to be
 * run within a zone.
 */

function setupDockerExecution(opts, callback) {
    assert.object(opts.command, 'command');
    assert.number(opts.timeoutSeconds, 'timeoutSeconds');
    assert.string(opts.uuid, 'uuid');
    assert.string(opts.req_id, 'req_id');

    var command = opts.command;
    opts.log = bunyan.createLogger({name: 'docker-stdio', req_id: opts.req_id});

    // If we have been instructed to spawn the process as 'Detach' or
    // daemonized mode, we skip starting the stdio server and simply spawn the
    // process. If 'Detach' was not specified, we create a docker stdio
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
    assert.string(opts.brand, 'brand');
    assert.object(opts.command, 'command');
    assert.object(opts.log, 'log');
    assert.number(opts.timeoutSeconds, 'timeoutSeconds');
    assert.string(opts.uuid, 'uuid');
    assert.string(opts.platform, 'platform');

    var args = ['-Q'];
    var cmd = '/usr/sbin/zlogin';
    var command = opts.command;
    var container = opts.uuid;
    var log = opts.log;
    var helper;
    var socket = opts.socket;
    var uuid = opts.uuid;

    if (opts.brand === 'lx') {
        helper = '/native/usr/vm/sbin/dockerexec';
    } else {
        helper = '/usr/vm/sbin/dockerexec';
    }

    command.uuid = uuid;
    command.log = log;

    if (command.AttachConsole) {
        // special case for 'docker attach', note that if in the future we want
        // to attach to only one or the other of stdout/stderr we should also
        // look at command.AttachStdout and command.AttachStderr (booleans).
        args.push('-I', container);
        var fn = (command.Tty ? runContainerPtyCommand: runContainerCommand);
        fn.call(null, command, cmd, args, socket);
    } else if (command.Logs) {
        runContainerLogsCommand(container, command, socket);
    } else if (command.Detach) {
        command.dockerexec = true;
        args.push(container);
        args.push(helper);
        args = args.concat(command.Cmd);
        runContainerCommand(command, cmd, args);
    } else if (command.AttachStdin && command.Tty) {
        command.dockerexec = true;
        args.push('-i', container);
        args.push(helper);
        args = args.concat(command.Cmd);
        runContainerPtyCommand(command, cmd, args, socket);
    } else {
        command.dockerexec = true;
        args.push(container);
        args.push(helper);
        args = args.concat(command.Cmd);
        runContainerCommand(command, cmd, args, socket);
    }
}


/**
 * Start up a tar process within the given container's zonepath. Spawn the tar
 * process via zlogin if zone is running, or chroot if the zone is not, then
 * start a TCP server which will stream the tar stream to the first connection
 * on the server. This function is the main logic for docker copying out of a
 * container.
 */

function createDockerFileReadStreamServer(opts, callback) {
    assert.number(opts.timeoutSeconds, 'opts.timeoutSeconds');
    assert.string(opts.path, 'opts.path');
    assert.string(opts.uuid, 'opts.uuid');
    assert.string(opts.admin_ip, 'opts.admin_ip');
    assert.object(opts.log, 'opts.log');

    var log = opts.log;
    var uuid = opts.uuid;
    var timeoutSeconds = opts.timeoutSeconds;

    var zoneState;
    var serverTimeout;
    var tcpServer;

    var norm = path.normalize('/' + opts.path);
    var zonepath = path.join('/zones', opts.uuid);
    var root = path.join(zonepath, 'root');
    var abspath = path.join(root, norm);

    var error;
    var containerPathStat;

    // try to fail early if possible
    try {
        containerPathStat =
            dockerPathStatFromPath({ norm: norm, abspath: abspath });
        log.info({ containerPathStat: containerPathStat },
                 'docker copy path stat');
    } catch (e) {
        if (e.code === 'ENOTDIR') {
            error = new Error('path was not a directory: ' + norm);
            error.restCode = 'PathNotDirectory';
            callback(error);
            return;
        } else if (e.code === 'ENOENT') {
            error = new Error('no such file in container: ' + norm);
            error.restCode = 'FileNotFound';
            callback(error);
            return;
        } else {
            callback(e);
            return;
        }
    }

    var loadOpts = {
        log: opts.log,
        req_id: opts.req_id,
        uuid: opts.uuid
    };

    async.waterfall([
        /**
         * Capture zone state, as this will dictate which method we use to do
         * the copying.
         */
        function (next) {
            vmadm.load(loadOpts, function (err, vm) {
                if (err) {
                    next(err);
                    return;
                }
                zoneState = vm.zone_state;
                next();
            });
        },

        /**
         * Create TCP Server which will output the archive stream
         */
        function (next) {
            tcpServer = net.createServer();

            var onceNext = once(next);

            // Close server if no connections are received within timeout
            serverTimeout = setTimeout(function () {
                log.warn('Closing stream tcpServer after ' +
                     timeoutSeconds + ' seconds without connection');
                tcpServer.close();
            }, timeoutSeconds * 1000);

            if (zoneState === 'running') {
                tcpServer.on('connection', onConnectionZoneRunning);
            } else {
                tcpServer.on('connection', onConnectionZoneNotRunning);
            }

            tcpServer.on('error', function (err) {
                log.error({ err: err }, 'read stream error');
                onceNext(err);
            });
            tcpServer.listen(0, opts.admin_ip);
            tcpServer.on('listening', function () {
                onceNext();
            });
        }
    ], function (err) {
        if (err) {
            clearTimeout(serverTimeout);
            tcpServer.close();
            callback(err);
            return;
        }

        callback(null, tcpServer, { containerPathStat: containerPathStat });
    });

    function onConnectionZoneRunning(socket) {
        clearTimeout(serverTimeout);

        socket.on('close', function () {
            tcpServer.close();
        });

        var tar = ['/native/usr/bin/gtar', 'cf', '-'];

        tar.push('-C', path.dirname(norm), path.basename(norm));

        var zloginTarCmd = '/usr/sbin/zlogin';
        var zloginTarArgs = ['-Q', uuid];

        Array.prototype.push.apply(zloginTarArgs, tar);

        log.info({ zloginTarArgs: zloginTarArgs },
                 'createDockerFileReadStreamServer ' +
                 'onConnectionZoneRunning zloginTarArgs');

        var streamProc =
            spawn(zloginTarCmd, zloginTarArgs, { encoding: 'binary' });

        streamProc.stderr.on('data', function (data) {
            log.error({ errorOutput: data.toString() },
                      'zlogin error output');
        });

        streamProc.on('end', function (err) {
            if (err) {
                log.error(err);
            }
            tcpServer.close();
        });

        streamProc.stdout.pipe(socket);
    }

    function onConnectionZoneNotRunning(socket) {
        clearTimeout(serverTimeout);

        socket.on('close', function () {
            tcpServer.close();
        });

        var chrootTarCmd = __dirname + '/../bin/chroot-gtar';
        var chrootTarArgs = [
            '-r', zonepath,
            '-t', '-',
            '-m', 'create'
        ];

        if (norm.match(new RegExp('^/'))) {
            norm = norm.slice(1);
        }

        chrootTarArgs.push('-C', path.join('root', path.dirname(norm)),
                           path.basename(norm));

        log.info({ norm: norm, chrootTarArgs: chrootTarArgs }, 'tar args');

        var streamProc =
            spawn(chrootTarCmd, chrootTarArgs, { encoding: 'binary' });

        streamProc.stderr.on('data', function (data) {
            log.error({ errorOutput: data.toString() },
                      'chroot-gtar error output');
        });

        streamProc.on('end', function (err) {
            if (err) {
                log.error(err);
            }
            tcpServer.close();
        });

        streamProc.stdout.pipe(socket);
    }
}

/**
 * Start up a tar process within the given container's zonepath. Spawn the tar
 * process via zlogin if zone is running, or chroot if the zone is not, then
 * start a TCP server which will stream the tar stream from the first connection
 * on the server. This function is the main logic for docker copying into a
 * container.
 */

function createDockerFileWriteStreamServer(opts, callback) {
    assert.number(opts.timeoutSeconds, 'timeoutSeconds');
    assert.string(opts.uuid, 'opts.uuid');
    assert.string(opts.path, 'opts.path');
    assert.string(opts.admin_ip, 'opts.admin_ip');
    assert.optionalBool(opts.no_overwrite_dir, 'opts.no_overwrite_dir');
    assert.object(opts.log, 'log');

    var log = opts.log;
    var uuid = opts.uuid;
    var zoneState;
    var serverTimeout;
    var timeoutSeconds = opts.timeoutSeconds;

    var tcpServer;

    var norm = path.normalize('/' + opts.path);
    var zonepath = path.join('/zones', opts.uuid);
    var root = path.join(zonepath, 'root');
    var abspath = path.join(root, norm);

    // try to fail early if possible
    var error;
    var stat;
    try {
        stat = fs.lstatSync(abspath);

        if (!stat.isDirectory()) {
            error = new Error('path was not a directory: ' + norm);
            error.restCode = 'PathNotDirectory';
            callback(error);
            return;
        }
    } catch (e) {
        if (e.code === 'ENOTDIR') {
            error = new Error('path was not a directory: ' + norm);
            error.restCode = 'PathNotDirectory';
            callback(error);
            return;
        } else if (e.code === 'ENOENT') {
            error = new Error('no such file in container: ' + norm);
            error.restCode = 'FileNotFound';
            callback(error);
            return;
        } else {
            callback(e);
            return;
        }
    }

    var loadOpts = {
        log: opts.log,
        req_id: opts.req_id,
        uuid: opts.uuid
    };

    async.waterfall([
        /**
         * Capture zone state, as this will dictate which method we use to do
         * the copying.
         */
        function (next) {
            vmadm.load(loadOpts, function (err, vm) {
                if (err) {
                    next(err);
                    return;
                }
                zoneState = vm.zone_state;
                next();
            });
        },
        /**
         * Create TCP Server which will receive the archive stream
         */
        function (next) {
            tcpServer = net.createServer();

            var onceNext = once(next);

            // Close server if no connections are received within timeout
            serverTimeout = setTimeout(function () {
                log.warn('Closing stream tcpServer after ' +
                     timeoutSeconds + ' seconds without connection');
                tcpServer.close();
            }, timeoutSeconds * 1000);

            if (zoneState === 'running') {
                tcpServer.on('connection', onConnectionZoneRunning);
            } else {
                tcpServer.on('connection', onConnectionZoneNotRunning);
            }
            tcpServer.listen(0, opts.admin_ip);
            tcpServer.on('error', function (err) {
                log.error({ err: err }, 'write stream error');
                onceNext(err);
            });

            tcpServer.on('listening', function () {
                onceNext();
            });
        }
    ], function (err) {
        if (err) {
            clearTimeout(serverTimeout);
            tcpServer.close();
            callback(err);
            return;
        }
        callback(null, tcpServer);
    });

    return;

    function onConnectionZoneRunning(socket) {
        clearTimeout(serverTimeout);

        var overwrite = opts.no_overwrite_dir ?
            '--no-overwrite-dir' : '--overwrite';

        var tar = ['/native/usr/bin/gtar', 'xf', '-', overwrite, '-C', norm];

        var zloginTarCmd = '/usr/sbin/zlogin';
        var zloginTarArgs = ['-Q', uuid];

        Array.prototype.push.apply(zloginTarArgs, tar);

        var streamProc =
            spawn(zloginTarCmd, zloginTarArgs, { encoding: 'binary' });

        streamProc.stderr.on('data', function (data) {
            log.error({ errorOutput: data.toString() }, 'zlogin error output');
        });

        streamProc.on('end', function (err) {
            if (err) {
                log.error(err);
            }
            tcpServer.close();
        });

        socket.pipe(streamProc.stdin);

        socket.on('close', function () {
            tcpServer.close();
        });
    }

    function onConnectionZoneNotRunning(socket) {
        clearTimeout(serverTimeout);

        var overwrite = opts.no_overwrite_dir ?
        '--no-overwrite-dir' : '--overwrite';

        var chrootTarCmd = __dirname + '/../bin/chroot-gtar';
        var chrootTarArgs = [
            '-r', zonepath,
            '-t', '-',
            '-m', 'extract',
            '-C', path.join('root', norm)
            ];

        chrootTarArgs.push(overwrite);


        log.info({ chroot: chrootTarArgs }, 'chroot-gtar args');

        var streamProc =
            spawn(chrootTarCmd, chrootTarArgs, { encoding: 'binary' });

        streamProc.stderr.on('data', function (data) {
            log.error({ errorOutput: data.toString() },
                      'chroot-gtar error output');
        });

        streamProc.stdout.on('data', function (data) {
            console.log(data.toString());
        });

        streamProc.on('end', function (err) {
            if (err) {
                log.error(err);
            }
            tcpServer.close();
        });

        socket.pipe(streamProc.stdin);

        socket.on('close', function () {
            tcpServer.close();
        });
    }
}


/**
 * getDockerContainerPathStat returns details of the given path:
 * file size, link target (if path is a link), modification time, type of file
 * (directory or symlink).
 */

function getDockerContainerPathStat(opts, callback) {
    assert.number(opts.timeoutSeconds, 'opts.timeoutSeconds');
    assert.string(opts.path, 'opts.path');
    assert.string(opts.uuid, 'opts.uuid');
    assert.string(opts.admin_ip, 'opts.admin_ip');
    assert.object(opts.log, 'opts.log');

    var norm = path.normalize('/' + opts.path);
    var root = path.join('/zones', opts.uuid, 'root');
    var abspath = path.join(root, norm);

    var error;
    var containerPathStat;

    // try to fail early if possible
    try {
        containerPathStat =
            dockerPathStatFromPath({ norm: norm, abspath: abspath });
    } catch (e) {
        if (e.code === 'ENOTDIR') {
            error = new Error('path was not a directory: ' + norm);
            error.restCode = 'PathNotDirectory';
            callback(error);
            return;
        } else if (e.code === 'ENOENT') {
            error = new Error('no such file in container: ' + norm);
            error.restCode = 'FileNotFound';
            callback(error);
            return;
        } else {
            callback(e);
            return;
        }
    }

    callback(null, { containerPathStat: containerPathStat });
}


function createDockerStdioServer(opts) {
    assert.object(opts.log, 'log');

    var log = opts.log;
    var timeoutSeconds = opts.timeoutSeconds;
    var tcpServer = net.createServer();

    // Close server is no connections are received within timeout window.
    var serverTimeout = setTimeout(function () {
        log.warn('Closing tcpServer after ' +
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


function rtrim(str, chars) {
    chars = chars || '\\s';
    str = str || '';
    return str.replace(new RegExp('[' + chars + ']+$', 'g'), '');
}

/*
 * state is an object (initially empty) that you should pass in to each call
 * callback is called for each line.
 * opts is expected to include at least opts.log, a bunyan logger.
 * data is expected to be a chunk of output from dockerexec.
 *
 */
function dockerExecLines(state, data, opts, callback) {
    assert.object(opts.log, 'log');

    var buffer = '';
    var chunk;
    var chunks;
    var log = opts.log;
    var matches;

    if (state.remainder) {
        buffer = state.remainder;
    }

    buffer += data.toString();
    chunks = buffer.split('\n');
    while (chunks.length > 1) {
        chunk = rtrim(chunks.shift());

        /* JSSTYLED */
        matches = chunk.match(/^(\d+\-\d+\-\d+T\d+\:\d+\:\d+\.\d+Z) (.*)$/);
        if (matches) {
            callback({
                line: chunk,
                message: matches[2],
                timestamp: new Date(matches[1])
            });
        } else {
            log.error('no match: [%s]\n', chunk);
        }
    }
    state.remainder = chunks.pop();
}

/*
 * Checks if the client socket has sent a ^P^Q control sequence
 */
function isCtrlPQ(previous, current) {
    if (previous.length !== 1 || current.length !== 1) {
        return false;
    }

    return (previous.toString() === CTRL_P && current.toString() === CTRL_Q);
}

/*
 * Sends a SIGUSR1 to the zlogin process in order to switch its -N mode
 */
function issueCtrlPQ(stream) {
    stream.kill('SIGUSR1');
    setTimeout(function () {
        stream.kill();
    }, 50);
}

function tryEnd(socket) {
    if (socket && !socket.destroyed) {
        socket.end();
    }
}

function writeData(opts) {
    var data;

    assert.object(opts.log, 'opts.log');
    assert.string(opts.streamType, 'opts.streamType');
    assert.object(opts.stream, 'opts.stream');
    assert.string(opts.chunk, 'opts.chunk');
    assert.ok(opts.stream);

    if (opts.stream.destroyed) {
        opts.log.warn('cannot write to a destroyed stream');
        return;
    }

    data = JSON.stringify({
        type: opts.streamType,
        data: opts.chunk
    }) + '\r\n';

    opts.stream.write(data);
}

function writeEnd(stream, obj, callback) {
    assert.ok(stream);
    assert.notEqual(stream.destroyed,
        true,
        'Cannot write to a destroyed stream');
    assert.object(obj);

    var data = JSON.stringify({
        type: 'end',
        data: obj
    }) + '\r\n';

    stream.write(data, callback);
}

/**
 * This lstream parser allows docker-stdio to parse any message coming from
 * sdc-docker. On non-tty containers the sdc-docker will be sending 'stdin'
 * data events and 'end' events when the remote client has closed the stdin.
 *
 * A pty (tty container) will also be able to send resize vents. Here are all
 * the possible message types
 *
 * { type: 'stdin', data: data }
 * { type: 'tty', data: data }
 * { type: 'tty', resize: { h: h, w: w } }
 * { type: 'end' } // indication of a closed stdin
 *
 * We use linestream to parse the \r\n separated messages coming from
 * the sdc-docker client socket
 */
function _createLinestreamParser(opts, stream) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(stream, 'stream');

    // Keeps track of the previous byte received to see if the user is
    // sending a control sequence
    var previous;

    var lstream = new LineStream({ encoding: 'utf8' });
    lstream.on('error', function (err) {
        opts.log.error({ err: err }, 'LineStream threw an error');
    });

    lstream.on('readable', function createLineStreamParserOnReadable() {
        var line;

        while ((line = lstream.read()) != null) {
            line = line.trim();
            if (!line) {
                continue;
            }

            var parsed = JSON.parse(line);

            if (parsed.type === 'tty') {
                if (parsed.resize) {
                    stream.resize(parsed.resize.w, parsed.resize.h);
                } else if (parsed.data) {
                    handleDataEvent(parsed.data);
                }
            } else if (parsed.type === 'stdin') {
                handleDataEvent(parsed.data);
            } else if (parsed.type === 'end') {
                tryEnd(stream);
            } else {
                opts.log.error({
                    parsed: parsed
                }, 'LineStream received unrecognized data');
                if (stream.kill) {
                    stream.kill();
                } else {
                    tryEnd(stream);
                }
            }

        }
    });

    function handleDataEvent(current) {
        if (previous !== undefined && isCtrlPQ(previous, current)) {
            issueCtrlPQ(stream);
            previous = undefined;
            return;
        }

        if (current.length === 1) {
            previous = current;

            // If we see a single character press, don't
            // pass CTRL-P keystrokes through
            if (current.toString() === CTRL_P) {
                return;
            }
        } else {
            previous = undefined;
        }

        stream.write(current);
    }

    return lstream;
}

function runContainerCommand(params, cmd, args, socket) {
    assert.object(params.log, 'log');

    var cmdSpawn = spawn(cmd, args);
    var mdata_filename;
    var uuid = params.uuid;
    var log = params.log;

    var sharedParams = {
        in_dockerexec: params.dockerexec,
        stdout_written: 0,
        stderr_written: 0,
        state: {},
        Tty: params.Tty
    };

    if (params.AttachConsole) {
        // Attempt to remove the wait_for_attach flag now. If this fails we've
        // got nobody to tell about this except the log.
        mdata_filename = path.normalize('/zones/' + uuid
            + '/config/metadata.json');

        log.info({uuid: uuid, filename: mdata_filename},
            'runContainerCommand(): Unsetting wait_for_attach');
        wait_flag.unsetWaitFlag(uuid, mdata_filename, null, log,
            function (err) {
                if (err) {
                    log.error({err: err},
                        'runContainerCommand(): failed to '
                        + 'unset wait_for_attach flag');
                }
        });
    }

    cmdSpawn.on('exit', function (code, signal) {
        log.info('cmdSpawn %s exited with status code %d signal %s',
            params.Cmd.join(' '),
            code,
            signal);
    });

    cmdSpawn.on('error', function (error) {
        log.info('cmdSpawn threw an error %s', error.toString());
    });

    if (socket) {
        runAttachedContainerCommand(sharedParams, log, cmdSpawn, socket);
        cmdSpawn.on('close', function (code, signal) {
            log.info('wrote %d bytes to stdout, %d bytes to stderr',
                sharedParams.stdout_written,
                sharedParams.stderr_written);
            log.info('cmdSpawn %s closed with status code %d signal %s',
                params.Cmd.join(' '), code, signal);
            writeEnd(socket, { code: code, signal: signal }, function () {
                tryEnd(socket);
            });
        });
    } else {
        cmdSpawn.on('close', function (code, signal) {
            log.info('wrote %d bytes to stdout, %d bytes to stderr',
                sharedParams.stdout_written,
                sharedParams.stderr_written);
            log.info('cmdSpawn %s closed with status code %d signal %s',
                params.Cmd.join(' '), code, signal);
        });
    }
}

function runAttachedContainerCommand(params, log, cmdSpawn, socket) {
    assert.ok(socket);

    if (params.AttachStdin) {
        var lstream = _createLinestreamParser({
            log: log
        }, cmdSpawn.stdin);
        socket.pipe(lstream);
    }

    cmdSpawn.stdout.on('data', function (data) {
        params.stdout_written += data.length;
        writeData({
            log: log,
            streamType: params.Tty ? 'tty' : 'stdout',
            stream: socket,
            chunk: data.toString()
        });
    });

    cmdSpawn.stderr.on('data', function (data) {
        var matches;

        params.stderr_written += data.length;
        if (params.in_dockerexec) {
            dockerExecLines(params.state, data.toString(), {log: log},
                function (execline) {

                matches = execline.message.match(/^FATAL \(code: (\d+)\):/);
                if (matches) {
                    params.in_dockerexec = false;
                    log.error({
                        time: execline.timestamp,
                        component: 'dockerexec'
                    }, execline.message);
                    // TODO: send an error code back to the client instead
                    // of just the fatal message.
                    writeData({
                        log: log,
                        streamType: params.Tty ? 'tty' : 'stderr',
                        stream: socket,
                        chunk: execline.line + '\r\n'
                    });
                } else {
                    if (execline.message.indexOf('EXEC') === 0) {
                        params.in_dockerexec = false;
                    }
                    log.info({
                        time: execline.timestamp,
                        component: 'dockerexec'
                    }, execline.message);
                }
            });
        } else {
            writeData({
                log: log,
                streamType: params.Tty ? 'tty' : 'stderr',
                stream: socket,
                chunk: data.toString()
            });
        }
    });

    socket.on('end', function () {
        cmdSpawn.stdin.end();
    });

    socket.on('error', function (err) {
        log.error({err: err}, 'runContainerCommand(): socket error');
    });
}

function parseRDev(rdev) {
    var MINORBITS = 20;
    var MINORMASK = (1 << MINORBITS) - 1;
    var major = rdev >> MINORBITS;
    var minor = rdev & MINORMASK;

    return { major: major, minor: minor };
}


function runContainerPtyCommand(params, cmd, args, socket) {
    assert.object(params.log, 'log');

    var cmdSpawn = pty.spawn(cmd, args);
    var log = params.log;
    var in_dockerexec = false;
    var mdata_filename;
    var output_written = 0;
    var state = {};
    var uuid = params.uuid;

    log.info('going to pty spawn: ' + cmd + ' ' + args.join(' '));

    if (params.dockerexec) {
        in_dockerexec = true;
    }

    if (params.AttachConsole) {
        // Attempt to remove the wait_for_attach flag now. If this fails we've
        // got nobody to tell about this except the log.
        mdata_filename = path.normalize('/zones/' + uuid
            + '/config/metadata.json');
        log.info({uuid: uuid, filename: mdata_filename},
            'runContainerPtyCommand(): Unsetting wait_for_attach');
        wait_flag.unsetWaitFlag(uuid, mdata_filename, null, log,
            function (err) {

            if (err) {
                log.error({err: err}, 'runContainerPtyCommand() failed to '
                    + 'unset wait_for_attach flag');
            }
        });
    }

    var lstream = _createLinestreamParser({
        log: log
    }, cmdSpawn);
    socket.pipe(lstream);

    cmdSpawn.on('data', function (data) {
        if (in_dockerexec) {
            dockerExecLines(state, data.toString(), {log: log},
                function (execline) {
                var matches;

                matches = execline.message.match(/^FATAL \(code: (\d+)\):/);
                if (matches) {
                    in_dockerexec = false;
                    log.error({
                        time: execline.timestamp,
                        component: 'dockerexec'
                    }, execline.message);
                    // TODO: send an error code back to the client instead
                    // of just the fatal message.
                    writeData({
                        log: log,
                        streamType: 'tty',
                        stream: socket,
                        chunk: execline.line + '\r\n'
                    });
                } else {
                    if (execline.message.indexOf('EXEC') === 0) {
                        in_dockerexec = false;
                    }
                    log.info({
                        time: execline.timestamp,
                        component: 'dockerexec'
                    }, execline.message);
                }
            });
        } else {
            output_written += data.length;
            writeData({
                log: log,
                streamType: 'tty',
                stream: socket,
                chunk: data.toString()
            });
        }
    });

    cmdSpawn.on('exit', function (code, signal) {
        log.info({cmd: params.Cmd, code: code, signal: signal},
            'pty cmdSpawn exited');
        writeEnd(socket, { code: code, signal: signal }, function () {
            tryEnd(socket);
        });
    });

    cmdSpawn.on('close', function (code, signal) {
        log.info('wrote %d bytes to of output', output_written);
        log.info('cmdSpawn %s closed code %d signal %s', params.Cmd.join(' '),
            code, signal);
    });

    socket.on('end', function () {
        log.info('pty socket for "%s %s" has ended', cmd, args.join(' '));
        cmdSpawn.end();
    });

    socket.on('error', function (err) {
        log.error({err: err}, 'runContainerPtyCommand(): socket error');
    });
}


/*
 * Run `cat` or `tail` (using the latter if we're "following") the stdio.log
 * file and then use linestream to process every line in order to correctly
 * send data back to the multiplexed streams.
 */

function runContainerLogsCommand(container, params, socket) {
    var cmd;
    var cmdArgs = [];
    var cmdSpawnExited = false;
    var cmdSpawnExitInterval;
    var log = params.log;
    var cmdSpawnExitCurrentlyWaited = 0;
    var cmdSpawnExitIntervalDuration =  500;
    var cmdSpawnExitTimeoutDuration = 5000;

    assert.object(params.log, 'log');

    if (params.Tail === 'all' && !params.Follow) {
        cmd = '/usr/bin/cat';
    } else {
        cmd = '/usr/bin/tail';

        if (params.Follow) {
            cmdArgs.push('-f');
        }
    }

    if (params.Tail !== 'all') {
        cmdArgs.push('-n' + params.Tail);
    }

    cmdArgs.push('/zones/' + container + '/logs/stdio.log');
    var cmdSpawn = spawn(cmd, cmdArgs);

    var lstream = new LineStream({ encoding: 'utf8' });
    lstream.on('error', function (err) {
        log.error('LineStream threw an error %s', err.toString());
    });

    lstream.on('readable', function runContainerLogsCommandOnReadable() {
        var line;

        while ((line = lstream.read()) != null) {
            line = line.trim();
            if (!line) {
                continue;
            }

            // If the socket has already been closed, do not continue to try to
            // write data to it.
            if (socket.destroyed) {
                break;
            }

            var rec = JSON.parse(line);
            var data;
            if (params.Timestamps) {
                data = rec.time + ' ' + rec.log;
            } else {
                data = rec.log;
            }

            writeData({
                log: log,
                streamType: rec.stream,
                stream: socket,
                chunk: data.toString()
            });
        }
    });

    cmdSpawn.on('exit', function onCmdSpawnExit(code, signal) {
        log.info('cmdSpawn "%s %s" exited with status code %d signal %s',
            cmd, cmdArgs.join(' '), code, signal);
        cmdSpawnExited = true;
        clearInterval(cmdSpawnExitInterval);
        lstream.removeAllListeners('readable');
    });

    cmdSpawn.on('close', function onCmdSpawnClose(code, signal) {
        log.info('cmdSpawn "%s %s" closed with status code %d signal %s',
            cmd, cmdArgs.join(' '), code, signal);
        tryEnd(socket);
    });

    cmdSpawn.on('error', function onCmdSpawnError(error) {
        log.error('cmdSpawn threw an error %s', error.toString());
    });

    // Kill the cat/tail process after the socket is closed so we don't
    // continue to get `readable` events from lstream.
    socket.on('close', function onSocketClose() {
        log.info(
            'logs socket for container %s has closed, ending container stdio',
            container);

        cmdSpawn.kill();

        beginExitCheckingInterval();
    });

    socket.on('end', function onSocketEnd() {
        log.info('socket for "%s %s" has ended', cmd, cmdArgs.join(' '));
        tryEnd(socket);
    });

    cmdSpawn.stdout.pipe(lstream);

    function beginExitCheckingInterval() {
        /**
         * Ensure cmdSpawnExitInterval is always undefined to prevent against
         * programmer error (multiple setIntervals being initiated.
         */
        assert.strictEqual(cmdSpawnExitInterval, undefined,
            'cmdSpawnExitInterval should always start off undefined');

        cmdSpawnExitInterval = setInterval(function onCmdSpawnExitInterval() {
            cmdSpawnExitCurrentlyWaited += cmdSpawnExitInterval;

            if (!cmdSpawnExited) {
                cmdSpawn.kill();
            } else {
                // process has already exited, nothing left to do
                clearInterval(cmdSpawnExitInterval);
                return;
            }

            log.warn(
                'stdio logs process has not exited (waiting %d seconds)',
                cmdSpawnExitIntervalDuration / 1000);

            if (cmdSpawnExitCurrentlyWaited >=
                    cmdSpawnExitTimeoutDuration)
            {
                log.warn(
                    'stdio logs process did not exit after signal ' +
                    '(waited %d seconds)', cmdSpawnExitCurrentlyWaited / 1000);
                throw new Error(
                    'could not terminate stdio logs child process');
            }
        }, cmdSpawnExitIntervalDuration).unref();
    }
}


/* BEGIN JSSTYLED */
/**
 * The `mode` member is very important because, despite receiving
 * almost no mention in the Docker remote api documentation, it
 * determines the course of action the docker client will undertake to
 * mangle the filenames in the internal structure of tar stream it
 * creates and feeds to us. It encodes whether the specified file is a
 * regular file or a symlink or perhaps most importantly, a directory.
 *
 * If you imagined that `mode` member would correpond to the mode bitfield
 * as returned by stat(2) you are incorrect and should feel bad. Why does
 * Go not follow POSIX's conventions? Who knows.
 *
 * In any case, Docker in their infinite wisdom leak a bunch of Go
 * internal implementation details into their API. So we need to deal
 * with it.
 *
 * See:
 *
 * https://github.com/docker/docker/blob/master/api/client/cp.go#L121-L154
 * https://golang.org/src/os/types.go
 * https://golang.org/src/os/stat_linux.go
 */
/* END JSSTYLED */

function dockerPathStatFromPath(opts) {
    assert.string(opts.norm, 'opts.norm');
    assert.string(opts.abspath, 'opts.abspath');

    var norm = opts.norm;
    var abspath = opts.abspath;

    var statpath = abspath.replace(new RegExp('/$'), '');
    var stat = fs.lstatSync(statpath);

    var containerPathStat = {
        name: norm.replace(new RegExp('^/'), ''),
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        linkTarget: '',
        mode: 0
    };
    if (stat.isSymbolicLink()) {
        containerPathStat.linkTarget = fs.readlinkSync(abspath);
        containerPathStat.mode = (1<<26)>>>0;
    } else if (stat.isDirectory()) {
        containerPathStat.mode = (1<<31)>>>0;
    }
    return containerPathStat;
}


module.exports = {
    setupDockerExecution: setupDockerExecution,
    setupDockerFileStream: setupDockerFileStream
};
