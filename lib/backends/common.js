/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018 Joyent, Inc.
 */

/*
 * Common helpers for all backends.
 *
 */

var child_process = require('child_process');
var execFile = child_process.execFile;
var fs = require('fs');
var path = require('path');

var assert = require('assert-plus');
var vasync = require('vasync');

var CURL_CMD = '/usr/bin/curl';


//
// Download an agent image (<uuid>) to <output_prefix>.file and then rename to
// .tar.gz or .tar.bz2 depending on compression from manifest.
//
// Inputs:
//
//  imageUuid         -- the image UUID of the agent image to download
//  opts              -- a configuration object with:
//  opts.imgapiUrl    -- the URL of imgapi: e.g. http://imgapi.whatever.foo/
//  opts.log          -- a bunyan logger
//  opts.outputDir    -- the directory in which to write the downloaded file
//  opts.outputPrefix -- a filename prefix to use for the downloaded file
//
//  Note that opts.imgapiUrl must start with 'http(s)://' and end with a '/'.
//
//  The resulting filename will be /<opts.outputDir>/<opts.outputPrefix>.tar.gz
//  or .tar.bz2 depending on compression used.
//
function getAgentImage(imageUuid, opts, callback) {
    assert.uuid(imageUuid, 'imageUuid');
    assert.object(opts, 'opts');
    assert.string(opts.imgapiUrl, 'opts.imgapiUrl');
    /* JSSTYLED */
    assert.ok(opts.imgapiUrl.match(/^http.*\//),
        'imgapiUrl must start with ^http and end with a "/"');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.outputDir, 'opts.outputDir');
    assert.string(opts.outputPrefix, 'opts.outputPrefix');

    var agentName;
    var compression;
    var fileUrl;
    var log = opts.log;
    var manifestUrl;
    var manifest;
    var outputFilename;
    var outputFullBasename = path.join(opts.outputDir, opts.outputPrefix);

    fileUrl = opts.imgapiUrl + 'images/' + imageUuid + '/file';
    manifestUrl = opts.imgapiUrl + 'images/' + imageUuid;

    vasync.pipeline({funcs: [
        function getImgapiManifest(_, cb) {
            var args = ['-f', '-sS', manifestUrl];

            log.debug({cmdline: CURL_CMD + ' ' + args.join(' ')}, 'executing');
            execFile(CURL_CMD, args, function (err, stdout, stderr) {
                if (err) {
                    log.error({
                        err: err,
                        stdout: stdout,
                        stderr: stderr,
                        url: manifestUrl
                    }, 'failed to download manifest');
                    if (err.message.match(/404 Not Found/)) {
                        cb(new Error('Image not found at ' + manifestUrl));
                    } else {
                        cb(err);
                    }
                    return;
                }
                try {
                    manifest = JSON.parse(stdout);
                    agentName = manifest.name;
                    log.debug({
                        manifest: manifest,
                        url: manifestUrl
                    }, 'got imgapi manifest');
                } catch (e) {
                    log.error(e, 'failed to parse manifest');
                    cb(e);
                    return;
                }

                cb();
            });
        }, function getImgapiFile(_, cb) {
            var args = [
                '-f', '-sS',
                '-o', outputFullBasename + '.file',
                fileUrl
            ];

            log.debug({cmdline: CURL_CMD + ' ' + args.join(' ')}, 'executing');
            execFile(CURL_CMD, args, function (err, stdout, stderr) {
                if (err) {
                    log.error({
                        err: err,
                        stdout: stdout,
                        stderr: stderr,
                        url: fileUrl
                    }, 'failed to download file');
                    if (err.message.match(/404 Not Found/)) {
                        cb(new Error('Image not found at ' + fileUrl));
                    } else {
                        cb(err);
                    }
                    return;
                }
                log.debug({
                    filename: outputFullBasename + '.file',
                    url: fileUrl
                }, 'got imgapi file');
                cb();
            });
        }, function checkSize(_, cb) {
            var expected_size = manifest.files[0].size;
            var filename = outputFullBasename + '.file';
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
            var filename = outputFullBasename + '.file';

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
            var args = ['-b', outputFullBasename + '.file'];
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
            var oldname = outputFullBasename + '.file';
            var newname;

            if (compression === 'gzip') {
                newname = outputFullBasename + '.tar.gz';
            } else if (compression === 'bzip2') {
                newname = outputFullBasename + '.tar.bz2';
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
                outputFilename = newname;
                cb();
            });
        }, function checkIsAgentImage(_, cb) {
            // check that image_uuid exists as a heuristic to attempt to
            // ensure this is an agent image (since we don't have separate type)
            var args = [];
            var cmd = '/usr/bin/tar';
            var filename;
            var message;

            if (!agentName) {
                message = 'manifest is missing "name"';
                log.error({manifest: manifest}, message);
                cb(new Error(message));
                return;
            }
            filename = agentName + '/image_uuid';

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

            args.push(outputFilename);
            args.push(filename);

            log.debug({cmdline: cmd + ' ' + args.join(' ')}, 'executing');
            execFile(cmd, args, function (err, stdout) {
                var trimmed;

                if (err) {
                    log.error({err: err, file: outputFilename},
                        'failed to list file from image');
                    cb(err);
                    return;
                }

                trimmed = stdout.replace(new RegExp('[\\s]+$', 'g'), '');
                if (trimmed === filename) {
                    log.debug('found ' + filename + ' in ' + outputFilename);
                    cb();
                } else {
                    message = 'could not find ' + filename + ' in ' +
                        outputFilename;
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
        callback(null, outputFilename, agentName);
    });
}


module.exports = {
    getAgentImage: getAgentImage
};
