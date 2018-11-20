/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018 Joyent, Inc.
 */

/*
 * This task installs agents on this mock CN. The only parameter accepted is
 * 'image_uuid' which is expected to be an image that exists in the local
 * DC's imgapi.
 *
 * The task will:
 *
 *  * download the manifest (to memory)
 *  * download the file (to /var/tmp/<server_uuid>/)
 *  * check vs. the sha1 and size from the manifest
 *  * name the file according to the compression
 *  * confirm the file contains image_uuid (it's an agent image)
 *  * extract image_uuid and package.json into place in
 *    (SERVER_ROOT/<server_uuid>/agents/<agent>/)
 *  * delete the temporary file from /var/tmp/<server_uuid>/
 *  * refresh CNAPI's view of the agents
 *
 * if there are errors at any point in this process, it will leave things as
 * they are for investigation.
 *
 * This task should be idempotent as running multiple times with the same
 * image_uuid should result in that version of the agent being installed.
 *
 *  "SELF-UPDATING" cn-agent:
 *
 *  Since updating agents here does not actually modify the running cn-agent,
 *  updating cn-agent works the same as every other agent. In the future we may
 *  want to make this behave slightly differently with cn-agent in order to
 *  mimick the real update behavior.
 *
 */


var child_process = require('child_process');
var execFile = child_process.execFile;
var fs = require('fs');
var path = require('path');

var assert = require('assert-plus');
var vasync = require('vasync');

var common = require('../common');
var refreshAgents = require('./shared').refreshAgents;
var Task = require('../../../task_agent/task');

var CURL_CMD = '/usr/bin/curl';
var SERVER_ROOT = common.SERVER_ROOT;


function AgentInstallTask(req) {
    Task.call(this);
    this.req = req;
}

function getAgentImage(uuid, options, callback) {
    var imgapi_domain = options.imgapi_domain;
    var log = options.log;
    var output_prefix = options.output_prefix;
    var server_uuid = options.server_uuid;

    // Ensure required options were passed
    assert.string(imgapi_domain, 'imgapi_domain');
    assert.object(log, 'log');
    assert.string(output_prefix, 'output_prefix');
    assert.uuid(server_uuid, 'server_uuid');

    var compression;
    var file_url;
    var manifest_url;
    var manifest;
    var output_file;
    var agent_name;

    file_url = 'http://imgapi.' + imgapi_domain + '/images/' + uuid + '/file';
    manifest_url = 'http://imgapi.' + imgapi_domain + '/images/' + uuid;

    vasync.pipeline({funcs: [
        function getImgapiManifest(_, cb) {
            var args = ['-f', '-sS', manifest_url];

            log.debug({cmdline: CURL_CMD + ' ' + args.join(' ')}, 'executing');
            execFile(CURL_CMD, args, function (err, stdout, stderr) {
                if (err) {
                    log.error({
                        err: err,
                        stdout: stdout,
                        stderr: stderr,
                        url: manifest_url
                    }, 'failed to download manifest');
                    if (err.message.match(/404 Not Found/)) {
                        cb(new Error('Image not found at ' + manifest_url));
                    } else {
                        cb(err);
                    }
                    return;
                }
                try {
                    manifest = JSON.parse(stdout);
                    agent_name = manifest.name;
                    log.debug({
                        manifest: manifest,
                        url: manifest_url
                    }, 'got imgapi manifest');
                } catch (e) {
                    log.error(e, 'failed to parse manifest');
                    cb(e);
                    return;
                }

                cb();
            });
        }, function getImgapiFile(_, cb) {
            var args = ['-f', '-sS', '-o', output_prefix + '.file', file_url];

            log.debug({cmdline: CURL_CMD + ' ' + args.join(' ')}, 'executing');
            execFile(CURL_CMD, args, function (err, stdout, stderr) {
                if (err) {
                    log.error({
                        err: err,
                        stdout: stdout,
                        stderr: stderr,
                        url: file_url
                    }, 'failed to download file');
                    if (err.message.match(/404 Not Found/)) {
                        cb(new Error('Image not found at ' + file_url));
                    } else {
                        cb(err);
                    }
                    return;
                }
                log.debug({
                    filename: output_prefix + '.file',
                    url: file_url
                }, 'got imgapi file');
                cb();
            });
        }, function checkSize(_, cb) {
            var expected_size = manifest.files[0].size;
            var filename = output_prefix + '.file';
            var message;

            fs.stat(filename, function (err, stat) {
                if (err) {
                    log.error('failed to stat ' + filename);
                    cb(err);
                    return;
                }
                if (stat.size !== expected_size) {
                    message = 'unexpected file size (' + expected_size +
                        ' vs ' + stat.size + ')';
                    log.error({
                        actual: stat.size,
                        expected: expected_size,
                        filename: filename
                    }, message);
                    cb(new Error(message));
                    return;
                }
                log.debug({
                    actual: stat.size,
                    expected: expected_size,
                    filename: filename
                }, 'file size ok');
                cb();
            });

        }, function checkSha1(_, cb) {
            var args;
            var cmd = '/usr/bin/openssl';
            var expected_sha1 = manifest.files[0].sha1;
            var filename = output_prefix + '.file';

            args = ['sha1', filename];

            log.debug({cmdline: cmd + ' ' + args.join(' ')}, 'executing');
            execFile(cmd, args, function (err, stdout, stderr) {
                var parts;
                var sha1;

                if (err) {
                    log.error({
                        err: err,
                        stdout: stdout,
                        stderr: stderr
                    }, 'failed to identify sha1');
                    cb(err);
                    return;
                }

                parts = stdout.split(' ');
                if (parts.length === 2) {
                    sha1 = parts[1].split(/\s/)[0];
                } else {
                    log.error({
                        stdout: stdout,
                        stderr: stderr
                    }, 'unable to parse sha1');
                    cb(new Error('unable to parse sha1: ' + stdout));
                    return;
                }

                if (sha1 !== expected_sha1) {
                    log.error({
                        actual_sha1: sha1,
                        expected_sha1: expected_sha1,
                        filename: filename
                    }, 'invalid sha1');
                    cb(new Error('sha1 does not match: (' + sha1 + ' vs ' +
                                    expected_sha1 + ')'));
                    return;
                }

                log.debug({
                    actual_sha1: sha1,
                    expected_sha1: expected_sha1,
                    filename: filename
                }, 'sha1 ok');
                cb();
            });
        }, function identifyCompression(_, cb) {
            var args = ['-b', output_prefix + '.file'];
            var cmd = '/usr/bin/file';
            var expected_compression = manifest.files[0].compression;

            if (expected_compression) {
                // manifest has a compression type, use that.
                compression = expected_compression;
                cb();
                return;
            }

            log.debug({cmdline: cmd + ' ' + args.join(' ')}, 'executing');
            execFile(cmd, args, function (err, stdout, stderr) {
                if (err) {
                    log.error({
                        err: err,
                        stdout: stdout,
                        stderr: stderr
                    }, 'failed to identify file magic');
                    cb(err);
                    return;
                }

                if (stdout.match(/^gzip compressed data/)) {
                    compression = 'gzip';
                    cb();
                } else if (stdout.match(/^bzip2 compressed data/)) {
                    compression = 'bzip2';
                    cb();
                } else {
                    log.error({
                        stdout: stdout,
                        stderr: stderr
                    }, 'unhandled file type');
                    cb(new Error('unhandled file type: ' + stdout));
                }
            });
        }, function renameBasedOnFileType(_, cb) {
            var oldname = output_prefix + '.file';
            var newname;

            if (compression === 'gzip') {
                newname = output_prefix + '.tar.gz';
            } else if (compression === 'bzip2') {
                newname = output_prefix + '.tar.bz2';
            } else {
                log.error('unknown compression: ' + compression);
                cb(new Error('unknown compression: ' + compression));
                return;
            }

            log.debug({oldname: oldname, newname: newname}, 'renaming file');
            fs.rename(oldname, newname, function (err) {
                if (err) {
                    cb(err);
                    return;
                }
                output_file = newname;
                cb();
            });
        }, function checkIsAgentImage(_, cb) {
            // check that image_uuid exists as a heuristic to attempt to
            // ensure this is an agent image (since we don't have separate type)
            var args = [];
            var cmd = '/usr/bin/tar';
            var filename;
            var message;

            if (!agent_name) {
                message = 'manifest is missing "name"';
                log.error({manifest: manifest}, message);
                cb(new Error(message));
                return;
            }
            filename = agent_name + '/image_uuid';

            if (compression === 'gzip') {
                args.push('-ztf');
            } else if (compression === 'bzip2') {
                args.push('-jtf');
            } else {
                message = 'invalid compression type: ' + compression;
                log.error({manifest: manifest, compression: compression},
                    message);
                cb(new Error(message));
                return;
            }

            args.push(output_file);
            args.push(filename);

            log.debug({cmdline: cmd + ' ' + args.join(' ')}, 'executing');
            execFile(cmd, args, function (err, stdout) {
                var trimmed;

                if (err) {
                    log.error({err: err, file: output_file},
                        'failed to list file from image');
                    cb(err);
                    return;
                }

                trimmed = stdout.replace(new RegExp('[\\s]+$', 'g'), '');
                if (trimmed === filename) {
                    log.debug('found ' + filename + ' in ' + output_file);
                    cb();
                } else {
                    message = 'could not find ' + filename + ' in ' +
                        output_file;
                    log.error({stdout: stdout}, message);
                    cb(new Error(message));
                }
            });
        }
    ]}, function pipelineCb(err) {
        if (err) {
            callback(err);
            return;
        }
        callback(null, output_file, agent_name);
    });
}


Task.createTask(AgentInstallTask);

function start() {
    var self = this;

    assert.object(self.sysinfo, 'self.sysinfo');
    assert.uuid(self.sysinfo.UUID, 'self.sysinfo.UUID');

    var image_uuid = self.req.params.image_uuid;
    var opts;
    var tmpdir = path.join('/var/tmp/', self.sysinfo.UUID);

    opts = {
        log: self.log,
        output_prefix: path.join(tmpdir, image_uuid),
        server_uuid: self.sysinfo.UUID
    };

    vasync.pipeline({ arg: { server_uuid: self.sysinfo.UUID }, funcs: [
        function getImgapiAddress(ctx, cb) {
            common.getSdcConfig(function onConfig(err, config) {
                if (!err) {
                    opts.imgapi_domain = config.datacenter_name + '.' +
                        config.dns_domain;
                }
                cb(err);
            });
        },
        function mkTempDir(ctx, cb) {
            fs.mkdir(tmpdir, function onMkdir(err) {
                if (err && err.code !== 'EEXIST') {
                    cb(err);
                    return;
                }

                cb();
            });
        },
        function getImage(ctx, cb) {
            getAgentImage(image_uuid, opts,
                function _gotAgentImage(err, file, name) {
                    if (err) {
                        return cb(err);
                    }

                    self.log.debug('downloaded agent %s image %s to %s',
                            name, image_uuid, file);

                    ctx.package_file = file;
                    ctx.package_name = name;
                    return cb();
               });
        },
        function cleanupPreviousUpdate(ctx, cb) {
            var logLevel = 'debug';
            var unpackDir = path.join(tmpdir, ctx.package_name);

            ctx.unpackDir = unpackDir;
            execFile('/bin/rm', [
                '-rf', unpackDir
            ], function onRm(err, stdout, stderr) {
                if (err) {
                    logLevel = 'error';
                }
                self.log[logLevel]({
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
                '-zxvf', ctx.package_file,
                '-C', tmpdir + '/',
                ctx.package_name + '/image_uuid',
                ctx.package_name + '/package.json'
            ];
            var logLevel = 'debug';

            // When we download the file we ensure it's either named .tar.gz or
            // .tar.bz2. We detect which here so we can make sure we have the
            // correct tar args.
            if (ctx.package_file.match(/.tar.bz2$/)) {
                args[0] = '-jxvf';
            }

            execFile('/usr/sbin/tar', args,
                function onTar(err, stdout, stderr) {

                if (err) {
                    logLevel = 'error';
                }
                self.log[logLevel]({
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
                self.sysinfo.UUID,
                'agents',
                ctx.package_name);

            ctx.targetDir = targetDir;

            execFile('/bin/mkdir', [
                '-p',
                targetDir
            ], function onMkdir(err, stdout, stderr) {
                if (err) {
                    logLevel = 'error';
                }
                self.log[logLevel]({
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
                self.log[logLevel]({
                    err: err,
                    stderr: stderr,
                    stdout: stdout
                }, 'ran "mv %s"', args.join(' '));
                cb(err);
            });
        },
        function cleanupTempBits(ctx, cb) {
            var args = [
                '-rf',
                ctx.unpackDir,
                ctx.package_file
            ];
            var logLevel = 'debug';

            execFile('/bin/rm', args, function onRm(err, stdout, stderr) {
                if (err) {
                    logLevel = 'error';
                }
                self.log[logLevel]({
                    err: err,
                    stderr: stderr,
                    stdout: stdout
                }, 'ran "rm %s"', args.join(' '));
                cb(err);
            });
        },
        function sendAgentsToCNAPI(ctx, cb) {
            // Since the agent has been updated at this point, the task will
            // return success. So any failure to tell CNAPI is logged only.
            refreshAgents({
                log: self.log,
                serverUuid: self.sysinfo.UUID
            }, function (err) {
                if (err) {
                    self.log.error({
                        err: err
                    }, 'Error posting agents to CNAPI');
                } else {
                    self.log.info('Agents info updated in CNAPI');
                }
                return cb();
            });
        }
    ]}, function agentInstallTaskCb(err) {
        if (err) {
            self.fatal('AgentInstall error: ' + err.message);
            return;
        }

        self.progress(100);
        self.finish();
    });
}

AgentInstallTask.setStart(start);

module.exports = AgentInstallTask;
