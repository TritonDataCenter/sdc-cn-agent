/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * Functionalities shared between two or more cn-agent tasks.
 */

var child_process = require('child_process');
var exec = child_process.exec;
var execFile = child_process.execFile;
var fs = require('fs');
var path = require('path');

var assert = require('assert-plus');
var restify = require('restify');
var uuid = require('uuid');
var vasync = require('vasync');

var backendCommon = require('../../common');
var common = require('../common');

var SERVER_ROOT = common.SERVER_ROOT;


function installAgent(opts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.agentFile, 'opts.agentFile');
    assert.object(opts.log, 'opts.log');
    assert.uuid(opts.serverUuid, 'opts.serverUuid');
    assert.func(callback, 'callback');

    var agentName; // will be filled in when we read package.json
    var tmpDir = path.join('/var/tmp/', opts.serverUuid);

    vasync.pipeline({ arg: {
        server_uuid: opts.serverUuid
    }, funcs: [
        function detectTarDir(ctx, cb) {
            //
            // Because SmartOS tar lacks nice things such as --wildcards or
            // --include, we can't figure out directly where package.json is in
            // this archive. But we have a requirement that all files exist in
            // the same directory, so we'll just use a pipeline to head -1 and
            // get the first file and pull the directory out that way.
            //
            var cmdline = [
                '/usr/bin/tar', '-ztf', opts.agentFile,
                '| /usr/bin/head', '-1'
            ];
            var logLevel = 'debug';

            // When we download the file we ensure it's either named .tar.gz or
            // .tar.bz2. We detect which here so we can make sure we have the
            // correct tar args.
            if (opts.agentFile.match(/.tar.bz2$/)) {
                cmdline[1] = '-jtf';
            }

            exec(cmdline.join(' '), function onTar(err, stdout, stderr) {
                if (err) {
                    logLevel = 'error';
                }

                opts.log[logLevel]({
                    err: err,
                    stderr: stderr,
                    stdout: stdout
                }, 'ran "%s"', cmdline.join(' '));

                if (!err) {
                    ctx.baseName = stdout.split('/')[0];
                    if (typeof (ctx.baseName) !== 'string' ||
                        ctx.baseName.length < 1) {

                        cb(new Error('tarball missing agentName/ directory'));
                        return;
                    }
                }

                opts.log.debug({
                    agentFile: opts.agentFile,
                    baseName: ctx.baseName
                }, 'found baseName from agent tarball');

                cb(err);
            });
        },
        function mkTempDir(ctx, cb) {
            fs.mkdir(tmpDir, function onMkdir(err) {
                if (err && err.code !== 'EEXIST') {
                    cb(err);
                    return;
                }

                cb();
            });
        },
        function cleanupPreviousInstallFiles(ctx, cb) {
            var logLevel = 'debug';
            var unpackDir = path.join(tmpDir, ctx.baseName);

            ctx.unpackDir = unpackDir;
            execFile('/bin/rm', [
                '-rf', unpackDir
            ], function onRm(err, stdout, stderr) {
                if (err) {
                    logLevel = 'error';
                }
                opts.log[logLevel]({
                    dir: unpackDir,
                    err: err,
                    stderr: stderr,
                    stdout: stdout
                }, 'ran "rm -rf %s"', unpackDir);
                cb(err);
            });
        },
        function unpackTar(ctx, cb) {
            var args = [
                '-zxvf', opts.agentFile,
                '-C', tmpDir + '/',
                ctx.baseName + '/image_uuid',
                ctx.baseName + '/package.json'
            ];
            var logLevel = 'debug';

            // When we download the file we ensure it's either named .tar.gz or
            // .tar.bz2. We detect which here so we can make sure we have the
            // correct tar args.
            if (opts.agentFile.match(/.tar.bz2$/)) {
                args[0] = '-jxvf';
            }

            execFile('/usr/bin/tar', args,
                function onTar(err, stdout, stderr) {

                if (err) {
                    logLevel = 'error';
                }
                opts.log[logLevel]({
                    err: err,
                    stderr: stderr,
                    stdout: stdout
                }, 'ran "tar %s"', args.join(' '));
                cb(err);
            });
        },
        function readPackageJson(ctx, cb) {
            var packageJson;
            var packageJsonFile =
                path.join(tmpDir, ctx.baseName, 'package.json');

            fs.readFile(packageJsonFile, 'utf8',
                function onFileData(err, data) {

                if (err) {
                    opts.log.error({
                        err: err,
                        packageJsonFile: packageJsonFile
                    }, 'failed to read package.json');
                    cb(err);
                    return;
                }

                try {
                    packageJson = JSON.parse(data);
                } catch (e) {
                    opts.log.error({
                        err: err,
                        packageJsonFile: packageJsonFile
                    }, 'failed to parse JSON in package.json');
                    cb(e);
                    return;
                }

                // If there's a package.json it needs to have a "name" otherwise
                // we really have no idea what to do.
                agentName = packageJson.name;
                assert.string(agentName, 'package.json:agentName');

                cb();
            });
        },
        function makeTargetDir(ctx, cb) {
            var logLevel = 'debug';

            ctx.targetDir = path.join(SERVER_ROOT, opts.serverUuid,
                'agents', agentName);

            execFile('/bin/mkdir', [
                '-p',
                ctx.targetDir
            ], function onMkdir(err, stdout, stderr) {
                if (err) {
                    logLevel = 'error';
                }
                opts.log[logLevel]({
                    err: err,
                    stderr: stderr,
                    stdout: stdout
                }, 'ran "mkdir -p %s"', ctx.targetDir);
                cb(err);
            });
        },
        function moveFiles(ctx, cb) {
            var args = [
                path.join(ctx.unpackDir, '/image_uuid'),
                path.join(ctx.unpackDir, '/package.json'),
                ctx.targetDir + '/'
            ];
            var logLevel = 'debug';

            execFile('/bin/mv', args, function onMv(err, stdout, stderr) {
                if (err) {
                    logLevel = 'error';
                }
                opts.log[logLevel]({
                    err: err,
                    stderr: stderr,
                    stdout: stdout
                }, 'ran "mv %s"', args.join(' '));
                cb(err);
            });
        },
        function createMissingInstanceUuid(ctx, cb) {
            var instanceFile = path.join(ctx.targetDir, '/instance_uuid');

            fs.readFile(instanceFile, function onRead(err, data) {
                if (err) {
                    if (err.code === 'ENOENT') {
                        // Here there's no instance_uuid, so we'll create one
                        // and write it out for next time.
                        ctx.instanceUuid = uuid.v4();
                        opts.log.info({
                            agentName: agentName,
                            instanceUuid: ctx.instanceUuid,
                            serverUuid: opts.serverUuid
                        }, 'created new uuid for agent instance');
                        fs.writeFile(instanceFile, ctx.instanceUuid,
                            'utf8', cb);
                        return;
                    } else {
                        cb(err);
                        return;
                    }
                }

                // No error, means we should have our uuid in data.
                ctx.instanceUuid = data.toString().trim();
                assert.uuid(ctx.instanceUuid, 'ctx.instanceUuid');
                opts.log.debug({
                    agentName: agentName,
                    instanceUuid: ctx.instanceUuid,
                    serverUuid: opts.serverUuid
                }, 'loaded uuid for agent instance');
                cb();
            });
        },
        function createSapiClient(ctx, cb) {
            common.getSdcConfig(function onConfig(err, config) {
                var sapiUrl;

                if (err) {
                    cb(err);
                    return;
                }

                sapiUrl = 'http://sapi.' + config.datacenter_name + '.' +
                    config.dns_domain;

                ctx.sapiClient = restify.createJsonClient({
                    url: sapiUrl
                });

                opts.log.debug({
                    sapiUrl: sapiUrl
                }, 'created SAPI client');

                cb();
            });
        },
        function adoptIntoSapi(ctx, cb) {

            // TODO: Rather than always adopting into SAPI, can we do that only
            //       when we create the instance_uuid? However, this is what
            //       "real" cn-agent does now, so we do the same.

            backendCommon.adoptInstanceInSapi({
                agentName: agentName,
                instanceUuid: ctx.instanceUuid,
                log: opts.log,
                sapiClient: ctx.sapiClient
            }, cb);
        },
        function cleanupTempBits(ctx, cb) {
            var args = [
                '-rf',
                ctx.unpackDir
            ];
            var logLevel = 'debug';

            execFile('/bin/rm', args, function onRm(err, stdout, stderr) {
                if (err) {
                    logLevel = 'error';
                }
                opts.log[logLevel]({
                    err: err,
                    stderr: stderr,
                    stdout: stdout
                }, 'ran "rm %s"', args.join(' '));
                cb(err);
            });
        }
    ]}, function onAgentInstall(err) {
        var logLevel = 'debug';
        var msg = 'installed agent';

        if (err) {
            logLevel = 'fatal';
            msg = 'failed to install agent';
        }

        opts.log[logLevel]({
            agentFile: opts.agentFile,
            agentName: agentName,
            err: err,
            serverUuid: opts.serverUuid
        }, msg);

        callback(err);
    });
}


function _installAgentIfInstallable(opts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.dir, 'opts.dir');
    assert.string(opts.filename, 'opts.filename');
    assert.object(opts.log, 'opts.log');
    assert.uuid(opts.serverUuid, 'opts.serverUuid');
    assert.func(callback, 'callback');

    opts.log.info({
        dir: opts.dir,
        filename: opts.filename,
        serverUuid: opts.serverUuid
    }, 'trying to install agent');

    if (!opts.filename.match(/\.(tar\.gz|tgz|tar\.bz2)$/)) {
        opts.log.warn({filename: opts.filename},
            'File does not look like an agent tarball. Skipping.');
        callback();
        return;
    }

    if (opts.filename.match(/^(cabase|cainstsvc)/)) {
        opts.log.warn({filename: opts.filename},
            'Skipping deprecated CA agent.');
        callback();
        return;
    }

    installAgent({
        agentFile: path.join(opts.dir, opts.filename),
        log: opts.log,
        serverUuid: opts.serverUuid
    }, function onInstall(err) {
        if (err) {
            opts.log.error({
                dir: opts.dir,
                err: err,
                filename: opts.filename,
                serverUuid: opts.serverUuid
            }, 'failed to install agent');
        }
        callback(err);
    });
}


function installAgentsShar(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.uuid(opts.serverUuid, 'opts.serverUuid');
    assert.string(opts.sharFile, 'opts.sharFile');
    assert.optionalString(opts.tmpDir, 'opts.tmpDir');
    assert.func(callback, 'callback');

    var serverAgentsDir;
    var serverDir = path.join(SERVER_ROOT, opts.serverUuid);
    var tmpAgentsDir;
    var tmpDir;
    var tmpServerDir = path.join(opts.tmpDir || '/var/tmp', opts.serverUuid);

    serverAgentsDir = path.join(serverDir, 'agents');
    tmpDir = path.join(tmpServerDir, 'agentsshar');
    tmpAgentsDir = path.join(tmpDir, 'agents');

    // NOTE: we expect the caller to do any necessary locking to prevent
    // multiple simultaneous runs.

    vasync.pipeline({funcs: [
        function ensureServerDirExists(_, cb) {
            fs.stat(serverDir, function _onStat(err, stats) {
                var newErr;

                if (!err && !stats.isDirectory()) {
                    newErr = new Error(serverDir +
                        ' exists but is not a directory');
                    newErr.code = 'ENOTDIR';
                    cb(newErr);
                    return;
                }

                cb(err);
            });
        },
        function ensureSharSupportsUnpack(_, cb) {
            var chars = 512;  // number of characters to read from the head

            // TRITON-976 added support for AGENTSSHAR_UNPACK_DIR which we need
            // to be able to install the agents in mockcloud. So we read the
            // first bit of the file (since the file is big) to ensure this
            // feature is available in this shar before we attempt to run it.
            // Running a shar without this, would attempt to run the install.sh
            // within which wouldn't turn out well.

            fs.open(opts.sharFile, 'r', function onOpen(err, fd) {
                if (err) {
                    cb(err);
                    return;
                }

                fs.read(fd, new Buffer(chars), 0, chars, 0,
                    function onRead(readErr, _bytes, buffer) {
                        var data = (readErr ? '' : buffer.toString('utf8'));

                        if (readErr) {
                            fs.close(fd, function _onClose() {
                                // Ignore close error here.
                                cb(readErr);
                            });
                            return;
                        }

                        opts.log.debug({
                            data: data,
                            sharFile: opts.sharFile
                        }, 'loaded shar "head" data');

                        // Don't need the file open any more.
                        fs.close(fd, function onClose(closeErr) {
                            if (closeErr) {
                                cb(closeErr);
                                return;
                            }

                            if (!data.match(/AGENTSSHAR_UNPACK_DIR/)) {
                                cb(new Error('shar is missing ' +
                                    'AGENTSSHAR_UNPACK_DIR, probably too old'));
                                return;
                            }

                            cb();
                        });
                    });
            });
        },
        function removePreviousTmpDir(_, cb) {
            var args = [
                '-rf',
                tmpDir
            ];
            var logLevel = 'debug';

            execFile('/bin/rm', args, function onRm(err, stdout, stderr) {
                if (err) {
                    logLevel = 'error';
                }
                opts.log[logLevel]({
                    err: err,
                    stderr: stderr,
                    stdout: stdout
                }, 'ran "rm %s"', args.join(' '));
                cb(err);
            });
        },
        function makeTmpServerDir(_, cb) {
            var logLevel = 'debug';

            fs.mkdir(tmpServerDir, function onMkdir(err) {
                if (err) {
                    logLevel = 'error';
                }
                opts.log[logLevel]({
                    err: err
                }, 'ran "fs.mkdir(%s)"', tmpServerDir);
                cb(err);
            });
        },
        function makeTmpDir(_, cb) {
            var logLevel = 'debug';

            fs.mkdir(tmpDir, function onMkdir(err) {
                if (err) {
                    logLevel = 'error';
                }
                opts.log[logLevel]({
                    err: err
                }, 'ran "fs.mkdir(%s)"', tmpDir);
                cb(err);
            });
        },
        function unpackShar(_, cb) {
            // This should unpack the shar such that <tmpDir>/agents will be
            // created and contain the individual agents' tarballs.
            var args = [
                opts.sharFile
            ];
            var logLevel = 'debug';
            var execOpts = {
                env: {
                    AGENTSSHAR_UNPACK_DIR: tmpDir,
                    AGENTSSHAR_UNPACK_ONLY: 'true'
                }
            };

            execFile('/bin/bash', args, execOpts,
                function onUnpack(err, stdout, stderr) {
                    if (err) {
                        logLevel = 'error';
                    }
                    opts.log[logLevel]({
                        err: err,
                        sharFile: opts.sharFile,
                        stderr: stderr,
                        stdout: stdout,
                        tmpDir: tmpDir
                    }, 'ran shar to unpack');
                    cb(err);
                });
        },
        function ensureTmpAgentsDirCreated(_, cb) {
            // <tmpDir>/agents should have been created when we unpacked above.
            fs.stat(tmpAgentsDir, function _onStat(err, stats) {
                var newErr;

                if (!err && !stats.isDirectory()) {
                    newErr = new Error(tmpAgentsDir +
                        ' exists but is not a directory');
                    newErr.code = 'ENOTDIR';
                    cb(newErr);
                    return;
                }

                cb(err);
            });
        },
        function ensureServerAgentsDir(_, cb) {
            // Create <serverDir>/agents if it's missing. The agents will be
            // installed here.
            fs.mkdir(serverAgentsDir, function onMkdir(err) {
                if (err) {
                    if (err.code === 'EEXIST') {
                        // Fine, no need to create;
                        cb();
                        return;
                    }
                    cb(err);
                    return;
                }

                // Ok, we created it.
                opts.log.info({serverAgentsDir: serverAgentsDir},
                    'created agents dir for server');
                cb();
            });
        },
        function installAgents(_, cb) {
            fs.readdir(tmpAgentsDir, function onReaddir(err, files) {
                opts.log.debug({
                    err: err,
                    files: files,
                    tmpAgentsDir: tmpAgentsDir
                }, 'readdir(tmpAgentsDir)');

                if (err) {
                    cb(err);
                    return;
                }

                // TODO: in the future, it might be possible to do this in
                // parallel. However the "real" install.sh does it serially, so
                // we do too for now.
                vasync.forEachPipeline({
                    func: function _installIfInstallable(filename, next) {
                        _installAgentIfInstallable({
                            dir: tmpAgentsDir,
                            filename: filename,
                            log: opts.log,
                            serverUuid: opts.serverUuid
                        }, next);
                    },
                    inputs: files
                }, cb);
            });
        },
        function cleanupTmpDir(_, cb) {
            var args = [
                '-rf',
                tmpDir
            ];
            var logLevel = 'debug';

            execFile('/bin/rm', args, function onRm(err, stdout, stderr) {
                if (err) {
                    logLevel = 'error';
                }
                opts.log[logLevel]({
                    err: err,
                    stderr: stderr,
                    stdout: stdout
                }, 'ran "rm %s"', args.join(' '));
                cb(err);
            });
        }
    ]}, function onSharInstall(err) {
        var logLevel = 'debug';

        if (err) {
            logLevel = 'error';
        }

        opts.log[logLevel]({
            err: err,
            serverUuid: opts.serverUuid,
            sharFile: opts.sharFile,
            tmpDir: opts.tmpDir
        }, 'finished shar install');

        callback(err);
    });
}


function refreshAgents(opts, callback) {
    var log = opts.log;

    assert.object(opts, 'opts');
    assert.uuid(opts.serverUuid, 'opts.serverUuid');
    assert.func(callback, 'callback');

    var agents;
    var cnapiUrl;
    var serverUuid = opts.serverUuid;

    vasync.pipeline({funcs: [
        function findCnapiUrl(_, cb) {
            common.getSdcConfig(function onConfig(err, config) {
                if (err) {
                    cb(err);
                    return;
                }

                cnapiUrl = 'http://cnapi.' + config.datacenter_name + '.' +
                    config.dns_domain;

                log.info({
                    cnapiUrl: cnapiUrl
                }, 'cnapi URL');

                cb();
            });
        },
        function getAgents(_, cb) {
            common.getAgents({
                serverUuid: serverUuid
            }, function gotAgents(err, _agents) {
                if (!err) {
                    agents = _agents;
                    log.debug({
                        agents: agents,
                        serverUuid: serverUuid
                    }, 'loaded agents');
                }
                cb(err);
            });
        },
        function postAgentsToCnapi(_, cb) {
            var client;
            var url = cnapiUrl;

            var restifyOptions = {
                url: url,
                connectTimeout: 5000,
                requestTimeout: 5000
            };

            log.info(restifyOptions, 'cnapi URL was %s', cnapiUrl);

            client = restify.createJsonClient(restifyOptions);

            client.post('/servers/' + serverUuid, {
                agents: agents
            }, cb);
        }
    ]}, callback);
}


module.exports = {
    installAgent: installAgent,
    installAgentsShar: installAgentsShar,
    refreshAgents: refreshAgents
};
