/*
 * This task installs agents on this CN. The only parameter accepted is
 * 'image_uuid' which is expected to be an image that exists in the local
 * DC's imgapi.
 *
 * The task will:
 *
 *  * download the manifest (to memory)
 *  * download the file (to /var/tmp)
 *  * check vs. the sha1 and size from the manifest
 *  * name the file according to the compression
 *  * confirm the file contains <agent name>/image_uuid (it's an agent image)
 *  * backup the existing /opt/smartdc/agents/
 *  * pass the file into apm.installPackages to install to /opt/smartdc/agents
 *  * delete the temporary file from /var/tmp
 *
 * if there are errors at any point in this process, it will leave things as
 * they are for investigation.
 *
 * This task should be idempotent as running multiple times with the same
 * image_uuid should result in that version of the agent being installed.
 *
 * TODO:
 *
 *  If an error occurs while downloading the manifest or file, this should
 *  retry up to 6 times (10 seconds apart). If the download is still failing
 *  at that point, it will give up.
 *
 */


var APM = require('../apm').APM;
var assert = require('assert');
var async = require('async');
var bunyan = require('bunyan');
var child_process = require('child_process');
var execFile = child_process.execFile;
var fs = require('fs');
var Task = require('../task_agent/task');
var execFile = require('child_process').execFile;

var CURL_CMD = '/usr/bin/curl';

function AgentInstallTask(req) {
    Task.call(this);
    this.req = req;
}

var apm;
var config;
var log = bunyan.createLogger({
    name: 'apm',
    stream: process.stderr,
    level: 'debug'
});

function getAgentImage(uuid, options, callback)
{
    var imgapi_domain = options.imgapi_domain;
    var log = options.log;
    var output_prefix = options.output_prefix;

    // Ensure required options were passed
    assert(imgapi_domain, 'missing imgapi_domain');
    assert(log, 'missing log');
    assert(output_prefix, 'missing output_prefix');

    var compression;
    var file_url;
    var manifest_url;
    var manifest;
    var output_file;

    file_url = 'http://' + imgapi_domain + '/images/' + uuid + '/file';
    manifest_url = 'http://' + imgapi_domain + '/images/' + uuid;

    async.waterfall([
        function (cb) {
            /* grab the imgapi manifest for this uuid */
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
        }, function (cb) {
            // TODO(?):
            //
            //   check if image is already the currently installed one for
            //   this agent. In which case install is a no-op unless there's
            //   a "force".
            //
            cb();
        }, function (cb) {
            /* grab the actual image file */
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
        }, function (cb) {
            // check size
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
                    message = 'unexpected file size (' + expected_size
                        + ' vs ' + stat.size + ')';
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

        }, function (cb) {
            // check sha1
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
                        stderr: stderr,
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
                        stderr: stderr,
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
                    cb(new Error('sha1 does not match: (' + sha1 + ' vs ' + expected_sha1 + ')'));
                    return;
                }

                log.debug({
                    actual_sha1: sha1,
                    expected_sha1: expected_sha1,
                    filename: filename
                }, 'sha1 ok');
                cb();
            });
        }, function (cb) {
            // Identify compression
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
                        stderr: stderr,
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
        }, function (cb) {
            // rename based on file type
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
        }, function (cb) {
            // check that image_uuid exists as a heuristic to attempt to
            // ensure this is an agent image (since we don't have separate type)
            var agent_name = manifest.name;
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
            execFile(cmd, args, function (err, stdout, stderr) {
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
                    message = 'could not find ' + filename + ' in '
                        + output_file;
                    log.error({stdout: stdout}, message);
                    cb(new Error(message));
                }
            });
        }
    ], function (err) {
        if (err) {
            callback(err);
            return;
        }

        callback(null, output_file);
    });
}

Task.createTask(AgentInstallTask);

function start(callback) {
    var self = this;

    var apm;
    var image_uuid = self.req.params.image_uuid;
    var options = {};
    var package_file;

    apm = new APM({log: self.log});
    options = {
        imgapi_domain: self.sdcConfig.imgapi_domain,
        log: self.log,
        output_prefix: '/var/tmp/' + image_uuid
    };

    async.waterfall([
        function (cb) {
            getAgentImage(image_uuid, options, function (err, output_file) {
                if (err) {
                    cb(err);
                    return;
                }

                log.debug('downloaded image ' + image_uuid + ' to + '
                    + output_file);

                package_file = output_file;

                cb();
            });
        }, function (cb) {
            apm.installPackages([package_file], cb);
        }
    ], function (err) {
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
