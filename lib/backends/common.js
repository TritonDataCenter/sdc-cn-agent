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
// Download a file from a given `url` to outputFilename.
//
// Inputs:
//
//  url            -- http(s) URL of the file to download
//  outputFilename -- the absolue path in which to write the output (dir must
//                    exist)
//  opts           -- a configuration object with:
//  opts.log       -- a bunyan logger
//
// Note that url must currently start with 'http(s)://'.
//
// On completion callback will be called:
//
//   callback(err);
//
// where err will either be `undefined` (success) or an Error object indicating
// the reason for failure.
//
function downloadFile(url, outputFilename, opts, callback) {
    assert.string(url, 'url');
    assert.ok(url.match(/^http.*$/), 'url must start with ^http');
    assert.string(outputFilename, 'outputFilename');
    assert.ok(path.isAbsolute(outputFilename),
        'outputFilename must be absolute path');
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.func(callback, 'callback');

    var args = [
        '-f', '-sS',
        '-o', outputFilename,
        url
    ];

    opts.log.debug({
        cmdline: CURL_CMD + ' ' + args.join(' ')
    }, 'executing');

    execFile(CURL_CMD, args, function _onCurl(err, stdout, stderr) {
        if (err) {
            opts.log.error({
                err: err,
                stdout: stdout,
                stderr: stderr,
                url: url
            }, 'failed to download file');

            if (err.message.match(/404 Not Found/)) {
                callback(new Error('File not found at ' + url));
            } else {
                callback(err);
            }
            return;
        }

        opts.log.debug({
            filename: outputFilename,
            url: url
        }, 'downloaded file');

        callback();
    });
}


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
// This function was pulled with minimal modifications from:
//
//    lib/backends/smartos/tasks/agent_install.js
//
// where it used to live, but could stand a fairly major refactor.
//
function getAgentImage(imageUuid, opts, callback) {
    assert.uuid(imageUuid, 'imageUuid');
    assert.object(opts, 'opts');
    assert.string(opts.imgapiUrl, 'opts.imgapiUrl');
    assert.ok(opts.imgapiUrl.match(/^http.*$/),
        'imgapiUrl must start with ^http');
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

    fileUrl = opts.imgapiUrl + '/images/' + imageUuid + '/file';
    manifestUrl = opts.imgapiUrl + '/images/' + imageUuid;

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
            downloadFile(fileUrl, outputFullBasename + '.file', {
                log: log
            }, cb);
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


//
// "adopt" an agent instance into SAPI.
//
// Inputs:
//
//   "opts" object that includes:
//
//     agentName    -- name of the agent service in SAPI (e.g. 'cn-agent')
//     instanceUuid -- uuid of the agent instance we're trying to adopt
//     log          -- bunyan logger object
//     retries      -- optional number of retries [default: 10]
//     sapiClient   -- a restify JsonClient object pointed at a SAPI service
//
// It will first attempt to determine the service UUID for the specified
// agentName. It will then use that to build and send a AdoptInstance request to
// SAPI. If it fails after retrying 'retries' times, it will call:
//
//   callback(err);
//
// with 'err' being an Error object describing the most recent failure. It will
// log all failures. On success, the callback will be called with no arguments.
//
function adoptInstanceInSapi(opts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.agentName, 'opts.agentName');
    assert.uuid(opts.instanceUuid, 'opts.instanceUuid');
    assert.object(opts.log, 'opts.log');
    assert.optionalNumber(opts.retries, 'opts.retries');
    assert.object(opts.sapiClient, 'opts.sapiClient');

    // This code was ported from cn-agent's postinstall.sh script which had 10
    // retries hardcoded. Whether and how many retries we should do is something
    // that should probably be revisited at some point.
    var retries = opts.retries || 10;
    var sapiClient = opts.sapiClient;
    var sapiServiceUuid;
    var skipAdoption = false;

    function attemptAdoption() {
        vasync.pipeline({funcs: [
            function findSapiServiceUuid(_, cb) {
                if (sapiServiceUuid !== undefined) {
                    cb();
                    return;
                }

                sapiClient.get('/services?type=agent&name=' + opts.agentName,
                    function gotAgentServices(err, req, res, services) {
                        var service;

                        if (err) {
                            opts.log.error({
                                agentName: opts.agentName,
                                err: err
                            }, 'failed to get SAPI service');

                            cb(err);
                            return;
                        }

                        assert.array(services, 'services');

                        if (services.length === 0) {
                            opts.log.warn({
                                agentName: opts.agentName,
                                sapiServiceUuid: sapiServiceUuid
                            }, 'SAPI has no service for agent, skipping ' +
                                'adoption');
                            skipAdoption = true;
                            cb();
                            return;
                        }

                        // Something's broken if we have more than one service
                        // for this agent.
                        assert.equal(services.length, 1,
                            'expected exactly 1 service');

                        service = services[0];

                        assert.uuid(service.uuid, 'service.uuid');

                        sapiServiceUuid = service.uuid;
                        opts.log.info({
                            agentName: opts.agentName,
                            sapiServiceUuid: sapiServiceUuid
                        }, 'got SAPI service');

                        cb();
                    });
            },
            function adoptInstance(_, cb) {
                if (skipAdoption) {
                    cb();
                    return;
                }

                /* JSSTYLED */
                // See: https://github.com/joyent/sdc-sapi/blob/master/docs/index.md#adoptinstance-post-instances
                sapiClient.post('/instances', {
                    exists: true,
                    name: opts.agentName,
                    service_uuid: sapiServiceUuid,
                    uuid: opts.instanceUuid
                }, function onPost(err, req, res) {
                    var logLevel = 'info';

                    if (err) {
                        logLevel = 'error';
                    }

                    opts.log[logLevel]({
                        err: err,
                        instanceUuid: opts.instanceUuid,
                        name: opts.agentName,
                        serviceUuid: sapiServiceUuid
                    }, 'POST /instances');

                    cb(err);
                });
            }
        ]}, function attemptComplete(err) {
            if (!err) {
                callback();
                return;
            }

            opts.log.warn({
                retriesRemaining: retries
            }, 'failed to adopt instance in SAPI');

            if (retries <= 0) {
                callback(err);
                return;
            }

            // Try again in 5s
            setTimeout(attemptAdoption, 5000);
            retries--;
        });
    }

    // Kick off the first attempt
    attemptAdoption();
}

module.exports = {
    adoptInstanceInSapi: adoptInstanceInSapi,
    downloadFile: downloadFile,
    getAgentImage: getAgentImage
};
