/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * The logic contained in this file is responsible for plumbing the various
 * input/output connections and sockets necessary for communicating with docker
 * containers.
 */


var assert = require('assert-plus');
var bunyan = require('bunyan');
var child_process = require('child_process');
var async = require('async');
var http = require('http');
var net = require('net');
var path = require('path');
var fs = require('fs');
var LineStream = require('./linestream');
var pty = require('pty.js');
var spawn = child_process.spawn;
var wait_flag = require('./update-wait-flag');
var shellescape = require('shell-escape');

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

    // If we have been instructed to spawn the process as "Detach" or
    // daemonized mode, we skip starting the stdio server and simply spawn the
    // process. If "Detach" was not specified, we create a docker stdio
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
 * Start up a zlogin'd tar within the user's container then start a TCP server
 * which will stream the tar stream to the first connection on the server.
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

    var tcpServer;

    var norm = path.normalize('/' + opts.path);
    var root = path.join('/zones', opts.uuid, 'root');
    var abspath = path.join(root, norm);

    var error;
    var stat;
    var containerPathStat;

    // try to fail early if possible
    try {
        stat = fs.lstatSync(abspath);
        containerPathStat = {
            name: norm,
            size: stat.size,
            mode: stat.mode,
            mtime: stat.mtime.toISOString(),
            linkTarget: ''
        };

        if (stat.isSymbolicLink()) {
            containerPathStat.linkTarget = fs.readlinkSync(abspath);
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

    /**
     * Create TCP Server which will output the archive stream
     */
    tcpServer = net.createServer();

    // Close server if no connections are received within timeout
    var serverTimeout = setTimeout(function () {
        log.warn('Closing stream tcpServer after ' +
             timeoutSeconds + ' seconds without connection');
        tcpServer.close();
    }, timeoutSeconds * 1000);

    tcpServer.on('connection', onConnection);
    tcpServer.on('error', function (err) {
        log.error({ err: err }, 'read stream error');
    });
    tcpServer.listen(0, opts.admin_ip);
    tcpServer.on('listening', function () {
        callback(null, tcpServer, { containerPathStat: containerPathStat });
    });
    return;

    function onConnection(socket) {
        clearTimeout(serverTimeout);

        socket.on('close', function () {
            tcpServer.close();
        });

        var tar = ['/native/usr/bin/gtar', 'cf', '-'];

        /**
         * If path ends with a / then we want to only archive the contents of
         * the directory, not the directory itself. To do this we lean on the
         * -C flag of tar which does a chdir before resolving the path argument
         * (which would be . when -C is used)
         */
        if (norm.match(new RegExp('/$'))) {
            tar.push('-C', norm, '.');
        } else {
            tar.push(norm);
        }

        tar = shellescape(tar);

        var args = ['-Q', uuid, tar];

        var spawnargs = ['/usr/sbin/zlogin', args, { encoding: 'binary' }];

        log.info('docker copy tar spawn args');
        log.info(JSON.stringify(spawnargs));

        var zlogin = spawn.apply(null, spawnargs);

        zlogin.on('end', function (err) {
            if (err) {
                log.error(err);
            }
            tcpServer.close();
        });

        zlogin.stdout.pipe(socket);
    }
}

/**
 * Start up a zlogin'd tar within the user's container then start a TCP server
 * which will receive a tar stream from the first connection and extract it.
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
    var timeoutSeconds = opts.timeoutSeconds;

    var tcpServer;

    var norm = path.normalize('/' + opts.path);
    var root = path.join('/zones', opts.uuid, 'root');
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

    tcpServer = net.createServer();

    // Close server if no connections are received within timeout
    var serverTimeout = setTimeout(function () {
        log.warn('Closing stream tcpServer after ' +
             timeoutSeconds + ' seconds without connection');
        tcpServer.close();
    }, timeoutSeconds * 1000);

    tcpServer.on('connection', onConnection);
    tcpServer.listen(0, opts.admin_ip);
    tcpServer.on('error', function (err) {
        log.error({ err: err }, 'write stream error');
    });

    tcpServer.on('listening', function () {
        callback(null, tcpServer);
    });
    return;

    function onConnection(socket) {
        clearTimeout(serverTimeout);

        var overwrite = opts.no_overwrite_dir ?
            '--no-overwrite-dir' : '--overwrite';

        var tar = ['/native/usr/bin/gtar', 'xf', '-', overwrite, '-C', norm];
        tar = shellescape(tar);

        var args = [
            '-Q',
            uuid,
            tar
        ];


        var spawnargs = ['/usr/sbin/zlogin', args, { encoding: 'binary' }];

        log.info('docker copy (write) tar spawn args');
        log.info(JSON.stringify(spawnargs));

        var zlogin = spawn.apply(null, spawnargs);

        zlogin.stderr.on('data', function (data) {
            console.log(data.toString());
        });

        zlogin.stdout.on('data', function (data) {
            console.log(data.toString());
        });

        zlogin.on('end', function (err) {
            if (err) {
                log.error(err);
            }
            tcpServer.close();
        });

        socket.pipe(zlogin.stdin);

        socket.on('close', function () {
            tcpServer.close();
        });
    }
}


/**
 * Start up a zlogin'd tar within the user's container then start a TCP server
 * which will stream the tar stream to the first connection on the server.
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
    var stat;
    var containerPathStat;

    // try to fail early if possible
    try {
        var statpath = abspath.replace(new RegExp('/$'), '');
        stat = fs.lstatSync(statpath);
        containerPathStat = {
            name: norm.replace(new RegExp('^/'), ''),
            size: stat.size,
            mtime: stat.mtime.toISOString(),
            linkTarget: ''
        };

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

        if (stat.isSymbolicLink()) {
            containerPathStat.linkTarget = fs.readlinkSync(abspath);
            containerPathStat.mode = (1<<26)>>>0;
        } else if (stat.isDirectory()) {
            containerPathStat.mode = (1<<31)>>>0;
        } else {
            containerPathStat.mode = 0;
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


function rtrim(str, chars)
{
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
function dockerExecLines(state, data, opts, callback)
{
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

function writeData(streamType, stream, chunk) {
    assert.ok(stream);
    assert.notEqual(stream.destroyed,
        true,
        'Cannot write to a destroyed stream');
    assert.string(chunk);

    var data = JSON.stringify({
        type: streamType,
        data: chunk
    }) + '\r\n';

    stream.write(data);
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

    lstream.on('line', function (line) {
        line = line.trim();
        if (!line) {
            return;
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
        writeData(params.Tty ? 'tty' : 'stdout', socket, data.toString());
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
                    writeData(params.Tty ? 'tty' : 'stderr',
                        socket,
                        execline.line + '\r\n');
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
            writeData(params.Tty ? 'tty' : 'stderr', socket, data.toString());
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
                    writeData('tty', socket, execline.line + '\r\n');
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
            writeData('tty', socket, data.toString());
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
 * cat/tail the stdio.log file and then use linestream to process every line
 * in order to correctly send data back to the multiplexed streams
 */
function runContainerLogsCommand(container, params, socket) {
    assert.object(params.log, 'log');

    var cmd;
    var cmdArgs = [];
    var log = params.log;

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

    lstream.on('line', function (line) {
        line = line.trim();
        if (!line) {
            return;
        }

        var rec = JSON.parse(line);
        var data;
        if (params.Timestamps) {
            data = rec.time + ' ' + rec.log;
        } else {
            data = rec.log;
        }

        writeData(rec.stream, socket, data.toString());
    });

    cmdSpawn.on('exit', function (code, signal) {
        log.info('cmdSpawn "%s %s" exited with status code %d signal %s',
            cmd, cmdArgs.join(' '), code, signal);
    });

    cmdSpawn.on('close', function (code, signal) {
        log.info('cmdSpawn "%s %s" closed with status code %d signal %s',
            cmd, cmdArgs.join(' '), code, signal);
        tryEnd(socket);
    });

    cmdSpawn.on('error', function (error) {
        log.error('cmdSpawn threw an error %s', error.toString());
    });

    socket.on('end', function () {
        log.info('socket for "%s %s" has ended', cmd, cmdArgs.join(' '));
        tryEnd(socket);
    });

    cmdSpawn.stdout.pipe(lstream);
}


module.exports = {
    setupDockerExecution: setupDockerExecution,
    setupDockerFileStream: setupDockerFileStream
};
