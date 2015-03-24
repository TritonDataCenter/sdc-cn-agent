/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */


var tar = require('tar-stream');
var assert = require('assert-plus');
var bunyan = require('bunyan');
var child_process = require('child_process');
var async = require('async');
var http = require('http');
var net = require('net');
var path = require('path');
var fs = require('fs');
var find = require('findit');
var LineStream = require('./linestream');
var pty = require('pty.js');
var spawn = child_process.spawn;
var wait_flag = require('./update-wait-flag');
var zfile = require('zfile');

var commands = {};

/**
 * Sets up a mechanism for startting a server to relay the contents of a file.
 */

function setupDockerFileStream(opts, callback) {
    assert.object(opts.payload, 'payload');
    assert.number(opts.timeoutSeconds, 'timeoutSeconds');
    assert.string(opts.uuid, 'uuid');
    assert.string(opts.req_id, 'req_id');

    opts.log = bunyan.createLogger({name: 'docker-stdio', req_id: opts.req_id});

    createDockerFileStreamServer(opts, function (err, server) {
        if (err) {
            process.send({ error: { message: err.message, err: err.stack } });
            return;
        }
        callback(null, { port: server.address().port });
    });
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
 * Due to security reasons, the contents of files requested through `docker cp`
 * will not be read from the global zone and instead need to pass through
 * node-zfile. As a result, implementing recursively copying a directory tree
 * is a little bit hairy. The basic method used is:
 *
 *     - create tar stream`
 *     - create tcp  server that will serve tar stream to clients
 *     - create queue to serialize streaming of file contents into tar stream
 *       so we don't inadventently try to write two streams into the tar stream
 *       in parallel
 *     - walk the container's directory tree from the global zone (not
 *       following symlinks)...
 *     - ... and for each file found:
 *         - if it's a regular file, open a node-zfile stream to it, record tar
 *           stream entry
 *         - if it's a link, read the link and record tar stream entry
 */
function createDockerFileStreamServer(opts, callback) {
    assert.object(opts.payload, 'payload');
    assert.number(opts.timeoutSeconds, 'timeoutSeconds');
    assert.string(opts.uuid, 'uuid');
    assert.object(opts.log, 'log');

    var log = opts.log;
    var uuid = opts.uuid;
    var timeoutSeconds = opts.timeoutSeconds;

    var returned = false;
    var finder;
    var queue;
    var tcpServer;

    var norm = path.normalize('/' + opts.payload.Resource);
    var root = path.join('/zones', opts.uuid, 'root');
    var abspath = path.join(root, norm);
    var base = path.dirname(abspath);

    // Fail early if possible
    if (!fs.existsSync(abspath)) {
        callback(new Error('no such file in container'));
        return;
    }

    /**
     * Create the archiver which will create our tar stream
     */
    var pack = tar.pack();

    /**
     * Create the work queue which will take each zstream and feed them one
     * after another in turn into the archiver
     */
    queue = async.queue(onTask, 1);

    /**
     * Create the file finder which will feed the files to stream
     */
    finder = find(abspath, { followSymlinks: false });

    finder.on('error', function (err) {
        log.warn('error walking %s for container %s: got error %s',
            abspath, uuid, err.message);
        finder.stop();
        callback(err);
    });

    finder.on('file', function (file, stat) {
        var type;

        // If we've found the first file, we can now return the tcp server
        if (!returned) {
            returned = true;
            process.nextTick(function () { callback(null, tcpServer); });
        }

        if (stat.isBlockDevice()) {
            type = 'block-device';
        } else if (stat.isCharacterDevice()) {
            type = 'character-device';
        } else if (stat.isFIFO()) {
            type = 'fifo';
        } else {
            type = 'file';
        }

        var modfile = file.slice(root.length);
        var name = file.slice(base.length+1);
        queue.push({ type: type, name: name, path: modfile, stat: stat });
    });

    finder.on('link', function (file, stat) {
        // If we've found the first file, we can now return the tcp server
        if (!returned) {
            returned = true;
            process.nextTick(function () { callback(null, tcpServer); });
        }

        var modfile = file.slice(root.length);
        var name = file.slice(base.length+1);
        queue.push({ type: 'link', name: name, path: modfile, stat: stat });
    });

    finder.on('end', function () {
        // If we've found the first file, we can now return the tcp server
        if (!returned) {
            returned = true;
            process.nextTick(function () { callback(null, tcpServer); });
        }
        queue.push({ type: 'finalize' });
    });

    /**
     * Create TCP Server which will output the archive stream
     */
    tcpServer = net.createServer();

    // Close server if no connections are received within timeout
    var serverTimeout = setTimeout(function () {
        log.warn('Closing stream tcpServer after ' +
             timeoutSeconds + ' seconds without connection');
        tcpServer.close();
        finder.stop();
    }, timeoutSeconds * 1000);

    tcpServer.on('connection', onConnection);
    tcpServer.listen(0);

    function onConnection(socket) {
        clearTimeout(serverTimeout);

        socket.on('close', function () {
            tcpServer.close();
        });

        pack.pipe(socket);
    }

    function onTask(task, cb) {
        var entry;
        var header;
        var file;
        var rdev;
        var name = task.name;
        var stat = task.stat;


        if (task.type === 'finalize') {
            pack.finalize();
            cb();
            return;
        }

        // Remove leading slash on paths
        file = task.path;
        file = file.slice(1);

        if (task.type === 'fifo') {
            header = stat;
            header.name = name;
            header.size = 0;
            header.type = 'fifo';

            entry = pack.entry(header, function (packErr) {
                if (packErr) {
                    log.warn('error packing container %s file %s: %s',
                        uuid, file, packErr.message);
                }
            });

            if (!entry) {
                log.warn('error: no entry when packing container %s file %s',
                    uuid, file);
            }

            cb();
            return;
        } else if (task.type === 'character-device') {
            rdev = parseRDev(stat.rdev);

            header = stat;
            header.size = 0;
            header.name = name;
            header.type = 'character-device';
            header.devmajor = rdev.major;
            header.devminor = rdev.minor;

            entry = pack.entry(header, function (packErr) {
                if (packErr) {
                    log.warn('error packing container %s file %s: %s',
                        uuid, file, packErr.message);
                }
            });

            if (!entry) {
                log.warn('error: no entry when packing container %s file %s',
                    uuid, file);
            }

            cb();
            return;
        } else if (task.type === 'block-device') {
            rdev = parseRDev(stat.rdev);

            header = stat;
            header.size = 0;
            header.name = name;
            header.type = 'block-device';
            header.devmajor = rdev.major;
            header.devminor = rdev.minor;

            entry = pack.entry(header, function (packErr) {
                if (packErr) {
                    log.warn('error packing container %s file %s: %s',
                        uuid, file, packErr.message);
                }
            });

            if (!entry) {
                log.warn('error: no entry when packing container %s file %s',
                    uuid, file);
            }

            cb();
            return;
        } else if (task.type === 'link') {
            header = stat;
            header.name = name;
            header.size = 0;
            header.type = 'symlink';
            header.linkname = fs.readlinkSync(path.join(root, file));

            entry = pack.entry(header, function (packErr) {
                if (packErr) {
                    log.warn('error packing container %s file %s: %s',
                        uuid, file, packErr.message);
                }
            });

            if (!entry) {
                log.warn('error: no entry when packing container %s file %s',
                    uuid, file);
            }

            cb();
            return;
        } else if (task.type === 'file') {
            var createOpts = {
                zone: uuid,
                path: file
            };
            zfile.createZoneFileStream(createOpts, function (err, stream) {
                if (err) {
                    cb(err);
                    return;
                }

                header = stat;
                header.type = 'file';
                header.name = name;

                entry = pack.entry(header, function (packErr) {
                    if (packErr) {
                        log.warn('error packing container %s file %s: %s',
                            uuid, file, packErr.message);
                    }
                });

                if (!entry) {
                    log.warn(
                        'error: no entry when packing container %s file %s',
                        uuid, file);
                }
                stream.pipe(entry, { end: false });
                stream.on('end', function () {
                    entry.end();
                    cb();
                });
            });
        }
    }
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
                stream.write(parsed.data);
            }
        } else if (parsed.type === 'stdin') {
            stream.write(parsed.data);
        } else if (parsed.type === 'end') {
            tryEnd();
        } else {
            opts.log.error({
                parsed: parsed
            }, 'LineStream received unrecognized data');
            if (stream.kill) {
                stream.kill();
            } else {
                tryEnd();
            }
        }
    });

    function tryEnd() {
        if (!stream.destroyed) {
            stream.end();
        }
    }

    return lstream;
}

function runContainerCommand(params, cmd, args, socket) {
    assert.object(params.log, 'log');

    var cmdSpawn = spawn(cmd, args);
    var in_dockerexec = false;
    var log = params.log;
    var mdata_filename;
    var state = {};
    var stdout_written = 0;
    var stderr_written = 0;
    var uuid = params.uuid;

    if (params.dockerexec) {
        in_dockerexec = true;
    }

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
                log.error({err: err}, 'runContainerCommand(): failed to '
                    + 'unset wait_for_attach flag');
            }
        });
    }

    if (socket) {
        if (params.AttachStdin) {
            var lstream = _createLinestreamParser({
                log: log
            }, cmdSpawn.stdin);
            socket.pipe(lstream);
        }

        cmdSpawn.stdout.on('data', function (data) {
            stdout_written += data.length;
            writeData('stdout', socket, data);
        });

        cmdSpawn.stderr.on('data', function (data) {
            var matches;

            stderr_written += data.length;
            if (in_dockerexec) {
                dockerExecLines(state, data.toString(), {log: log},
                    function (execline) {

                    matches = execline.message.match(/^FATAL \(code: (\d+)\):/);
                    if (matches) {
                        in_dockerexec = false;
                        log.error({
                            time: execline.timestamp,
                            component: 'dockerexec'
                        }, execline.message);
                        // TODO: send an error code back to the client instead
                        // of just the fatal message.
                        writeData('stderr', socket, execline.line + '\r\n');
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
                writeData('stderr', socket, data);
            }
        });

        socket.on('end', function () {
            cmdSpawn.stdin.end();
        });

        socket.on('error', function (err) {
            log.error({err: err}, 'runContainerCommand(): socket error');
        });
    }

    cmdSpawn.on('exit', function (code, signal) {
        log.info('cmdSpawn %s exited with status code %d signal %s',
            params.Cmd.join(' '), code, signal);
    });

    cmdSpawn.on('close', function (code, signal) {
        log.info('wrote %d bytes to stdout, %d bytes to stderr', stdout_written,
            stderr_written);
        log.info('cmdSpawn %s closed with status code %d signal %s',
            params.Cmd.join(' '), code, signal);

        writeEnd(socket, { code: code, signal: signal }, function () {
            tryEnd();
        });
    });

    cmdSpawn.on('error', function (error) {
        log.info('cmdSpawn threw an error %s', error.toString());
    });

    function tryEnd() {
        if (socket) {
            socket.end();
        }
    }

    function writeData(streamType, stream, chunk) {
        if (params.Tty) {
            streamType = 'tty';
        }

        var data = JSON.stringify({
            type: streamType,
            data: chunk.toString()
        }) + '\r\n';

        stream.write(data);
    }

    function writeEnd(stream, obj, callback) {
        var data = JSON.stringify({
            type: 'end',
            data: obj
        }) + '\r\n';

        stream.write(data, callback);
    }
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
                    writeData(socket, execline.line + '\r\n');
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
            writeData(socket, data);
        }
    });

    cmdSpawn.on('exit', function (code, signal) {
        log.info({cmd: params.Cmd, code: code, signal: signal},
            'pty cmdSpawn exited');
        writeEnd(socket, { code: code, signal: signal }, function () {
            tryEnd();
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

    function tryEnd() {
        if (!socket.destroyed) {
            socket.end();
        }
    }

    function writeData(stream, chunk) {
        var data = JSON.stringify({
            type: 'tty',
            data: chunk.toString()
        }) + '\r\n';

        stream.write(data);
    }

    function writeEnd(stream, obj, callback) {
        var data = JSON.stringify({
            type: 'end',
            data: obj
        }) + '\r\n';

        stream.write(data, callback);
    }
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

        writeData(rec.stream, socket, data);
    });

    cmdSpawn.on('exit', function (code, signal) {
        log.info('cmdSpawn "%s %s" exited with status code %d signal %s',
            cmd, cmdArgs.join(' '), code, signal);
    });

    cmdSpawn.on('close', function (code, signal) {
        log.info('cmdSpawn "%s %s" closed with status code %d signal %s',
            cmd, cmdArgs.join(' '), code, signal);
        tryEnd();
    });

    cmdSpawn.on('error', function (error) {
        log.error('cmdSpawn threw an error %s', error.toString());
    });

    socket.on('end', function () {
        log.info('socket for "%s %s" has ended', cmd, cmdArgs.join(' '));
        tryEnd();
    });

    cmdSpawn.stdout.pipe(lstream);

    function tryEnd() {
        if (!socket.destroyed) {
            socket.end();
        }
    }

    function writeData(streamType, stream, chunk) {
        var data = JSON.stringify({
            type: streamType,
            data: chunk.toString()
        }) + '\r\n';

        stream.write(data);
    }
}


module.exports = {
    setupDockerExecution: setupDockerExecution,
    setupDockerFileStream: setupDockerFileStream
};
