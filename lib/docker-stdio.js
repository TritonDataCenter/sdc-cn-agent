/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */


var tar = require('tar-stream');
var assert = require('assert-plus');
var child_process = require('child_process');
var async = require('async');
var http = require('http');
var net = require('net');
var path = require('path');
var fs = require('fs');
var find = require('findit');
var pty = require('pty.js');
var spawn = child_process.spawn;
var zfile = require('zfile');

var commands = {};
var STREAM_TYPES = {
    stdin: 0,
    stdout: 1,
    stderr: 2
};

/**
 * Sets up a mechanism for startting a server to relay the contents of a file.
 */

function setupDockerFileStream(opts, callback) {
    assert.object(opts.payload, 'payload');
    assert.number(opts.timeoutSeconds, 'timeoutSeconds');
    assert.string(opts.uuid, 'uuid');

    createDockerFileStreamServer(opts, function (err, server) {
        if (err) {
            process.send({ error: { message: err.message, err: err.stack } });
            return;
        }
        callback(null, { port: server.address().port });
    });
}


/**
 * Sets up a mechanism for starting a server to relay stdio to  a command to be
 * run within a zone.
 */

function setupDockerExecution(opts, callback) {
    assert.object(opts.command, 'command');
    assert.number(opts.timeoutSeconds, 'timeoutSeconds');
    assert.string(opts.uuid, 'uuid');

    var command = opts.command;

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
    assert.object(opts.command, 'command');
    assert.number(opts.timeoutSeconds, 'timeoutSeconds');
    assert.string(opts.uuid, 'uuid');

    var socket = opts.socket;
    var command = opts.command;
    var uuid = opts.uuid;
    var container = uuid;
    var cmd = '/usr/sbin/zlogin';

    var args = ['-Q'];

    if (command.AttachConsole) {
        // special case for 'docker attach', note that if in the future we want
        // to attach to only one or the other of stdout/stderr we should also
        // look at command.AttachStdout and command.AttachStderr (booleans).
        args.push('-I', container);
        runContainerPtyCommand(command, cmd, args, socket);
    } else if (command.Detach) {
        args.push(container);
        args = args.concat(command.Cmd);
        runContainerCommand(command, cmd, args);
    } else if (command.AttachStdin && command.Tty) {
        args.push('-i', container);
        args = args.concat(command.Cmd);
        runContainerPtyCommand(command, cmd, args, socket);
    } else {
        args.push(container);
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
        console.warn(
            'error walking %s for container %s:  got error %s',
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
        console.warn('Closing stream tcpServer after ' +
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
                    console.warn(
                        'error packing container %s file %s: %s',
                        uuid, file, packErr.message);
                }
            });

            if (!entry) {
                console.warn(
                    'error: no entry when packing container %s file %s',
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
                    console.warn(
                        'error packing container %s file %s: %s',
                        uuid, file, packErr.message);
                }
            });

            if (!entry) {
                console.warn(
                    'error: no entry when packing container %s file %s',
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
                    console.warn(
                        'error packing container %s file %s: %s',
                        uuid, file, packErr.message);
                }
            });

            if (!entry) {
                console.warn(
                    'error: no entry when packing container %s file %s',
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
                    console.warn(
                        'error packing container %s file %s: %s',
                        uuid, file, packErr.message);
                }
            });

            if (!entry) {
                console.warn(
                    'error: no entry when packing container %s file %s',
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
                        console.warn(
                            'error packing container %s file %s: %s',
                            uuid, file, packErr.message);
                    }
                });

                if (!entry) {
                    console.warn(
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

function parseRDev(rdev) {
    var MINORBITS = 20;
    var MINORMASK = (1 << MINORBITS) - 1;
    var major = rdev >> MINORBITS;
    var minor = rdev & MINORMASK;

    return { major: major, minor: minor };
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
    setupDockerExecution: setupDockerExecution,
    setupDockerFileStream: setupDockerFileStream
};
