/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * Functionalities shared between two or more cn-agent tasks
 */

var child_process = require('child_process');
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
    assert.string(opts.agentName, 'opts.agentName');
    assert.object(opts.log, 'opts.log');
    assert.uuid(opts.serverUuid, 'opts.serverUuid');
    assert.func(callback, 'callback');

    var tmpdir = path.join('/var/tmp/', opts.serverUuid);

    vasync.pipeline({ arg: {
        server_uuid: opts.serverUuid
    }, funcs: [
        function mkTempDir(ctx, cb) {
            fs.mkdir(tmpdir, function onMkdir(err) {
                if (err && err.code !== 'EEXIST') {
                    cb(err);
                    return;
                }

                cb();
            });
        },
        function cleanupPreviousInstallFiles(ctx, cb) {
            var logLevel = 'debug';
            var unpackDir = path.join(tmpdir, opts.agentName);

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
                '-C', tmpdir + '/',
                opts.agentName + '/image_uuid',
                opts.agentName + '/package.json'
            ];
            var logLevel = 'debug';

            // When we download the file we ensure it's either named .tar.gz or
            // .tar.bz2. We detect which here so we can make sure we have the
            // correct tar args.
            if (opts.agentFile.match(/.tar.bz2$/)) {
                args[0] = '-jxvf';
            }

            execFile('/usr/sbin/tar', args,
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
        function makeTargetDir(ctx, cb) {
            var logLevel = 'debug';
            var targetDir = path.join(SERVER_ROOT,
                opts.serverUuid,
                'agents',
                opts.agentName);

            ctx.targetDir = targetDir;

            execFile('/bin/mkdir', [
                '-p',
                targetDir
            ], function onMkdir(err, stdout, stderr) {
                if (err) {
                    logLevel = 'error';
                }
                opts.log[logLevel]({
                    err: err,
                    stderr: stderr,
                    stdout: stdout
                }, 'ran "mkdir -p %s"', targetDir);
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

            fs.stat(instanceFile, function onStat(err) {
                if (!err || err.code !== 'ENOENT') {
                    // No error, or any error other than ENOENT means we don't
                    // need to create a new instance_uuid file.
                    cb(err);
                    return;
                }

                // Here there's no instance_uuid, so we'll create one and write
                // it out for next time.
                ctx.instanceUuid = uuid.v4();
                fs.writeFile(instanceFile, ctx.instanceUuid, 'utf8', cb);
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

            // TODO: rather than always adopting into SAPI, can we do that only
            //       when we create the instance_uuid?

            backendCommon.adoptInstanceInSapi({
                agentName: ctx.agentName,
                instanceUuid: ctx.instanceUuid,
                log: opts.log,
                sapiClient: ctx.sapiClient
            }, cb);
        },
        function cleanupTempBits(ctx, cb) {
            var args = [
                '-rf',
                ctx.unpackDir,
                opts.agentFile
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
            agentName: opts.agentName,
            err: err,
            serverUuid: opts.serverUuid
        }, msg);

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
    refreshAgents: refreshAgents
};
