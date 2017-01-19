/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */

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
 *  "SELF-UPDATING" cn-agent:
 *
 *  Installing cn-agent is different than installing any other agent into the
 *  CN, given the setup process will remove the cn-agent service and, therefore
 *  make the cn-agent process exit.
 *
 *  To avoid such problem, we'll perform the install of cn-agent using an
 *  auxilary service called 'cn-agent-update', which will "live" only for the
 *  duration of the setup process. This service is exactly the same thing than
 *  cn-agent, but with a different FMRI and with the HTTP server listening to
 *  a different port.
 *
 *  The task performed by cn-agent-update in order to install a new copy of
 *  cn-agent is exactly the same one described above for the other agents.
 *
 *  What it's different is the behavior of cn-agent when it detects that the
 *  agent we're trying to setup is another copy of itself. In order to do this
 *  we check:
 *
 *  * what is the name of the agent we are trying to install. If we are trying
 *    to install cn-agent, we'll figure out if we're running our code from
 *    'cn-agent' or 'cn-agent-update' services using application port.
 *  * which port the service is running at. cn-agent listens to 5309, while
 *    cn-agent-update does to 5310.
 *  * If we are running code from 'cn-agent': we'll import and enable
 *    cn-agent-update service manifest and, once this service is up and running
 *    we'll send it a message to run the install-agent task with exactly the
 *    same arguments we've received.
 *  * If we're running code from 'cn-agent-update': we'll run the install-agent
 *    task as we do for any other agent and, once the process is done, we'll
 *    send a new task to cn-agent to verify cn-agent-update service is disabled
 *    and, from the cn-agent-service, exit the current process.
 *
 */


var APM = require('../apm').APM;
var assert = require('assert');
var async = require('async');
var child_process = require('child_process');
var execFile = child_process.execFile;
var fs = require('fs');
var dns = require('dns');
var Task = require('../task_agent/task');
var sdcconfig = require('../smartdc-config');
var restify = require('restify');
var bunyan = require('bunyan');
var CURL_CMD = '/usr/bin/curl';

function AgentInstallTask(req) {
    Task.call(this);
    this.req = req;
}

var config;
var logger = bunyan.createLogger({
    name: 'apm',
    stream: process.stderr,
    level: 'debug',
    serializers: bunyan.stdSerializers
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
    var agent_name;

    file_url = 'http://' + imgapi_domain + '/images/' + uuid + '/file';
    manifest_url = 'http://' + imgapi_domain + '/images/' + uuid;

    async.waterfall([
        function getImgapiManifest(cb) {
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
        }, function getImgapiFile(cb) {
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
        }, function checkSize(cb) {
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

        }, function checkSha1(cb) {
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
        }, function identifyCompression(cb) {
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
        }, function renameBasedOnFileType(cb) {
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
        }, function checkIsAgentImage(cb) {
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
                    message = 'could not find ' + filename + ' in ' +
                        output_file;
                    log.error({stdout: stdout}, message);
                    cb(new Error(message));
                }
            });
        }
    ], function waterfallCb(err) {
        if (err) {
            callback(err);
            return;
        }

        callback(null, output_file, agent_name);
    });
}

// TODO: This is pretty much duplicated code from app.js, moving to a common
// path would be much better
function updateAgents(opts, cb) {
    var log = opts.log;

    var cnapiaddr;
    var uuid;
    var agents;

    async.waterfall([
        function retrieveCnapiAddresses(callback) {
            sdcconfig.sdcConfig(function (error, cfg) {
                if (error) {
                    return callback(error);
                }

                var domainName = 'cnapi.' + cfg.datacenter_name + '.' +
                    cfg.dns_domain;

                log.info({
                    domainName: domainName
                }, 'cnapi domain name');

                return dns.resolve(domainName, function (dnserror, addrs) {
                    if (dnserror) {
                        return callback(dnserror);
                    }

                    if (!addrs.length) {
                        return callback('No CNAPI addresses found');
                    }

                    cnapiaddr = addrs[0];
                    return callback();
                });
            });
        },
        function getSysinfo(callback) {
            execFile('/usr/bin/sysinfo', ['-f'], function (err, stdo, stde) {
                if (err) {
                    return callback(Error(stde.toString()));
                }
                var obj = JSON.parse(stdo.toString());
                agents = obj['SDC Agents'];
                uuid = obj.UUID;
                return callback();
            });
        },
        function getAgentsImages(callback) {
            var agents_dir = '/opt/smartdc/agents/lib/node_modules';
            return fs.readdir(agents_dir, function (err, files) {
                if (err) {
                    return callback(err);
                }
                return async.each(files, function getImageAndUUID(name, _cb) {
                    var uuid_path = '/opt/smartdc/agents/etc/' + name;
                    var uuidFileExists;
                    var agentUuid;
                    var image_uuid;
                    async.series([
                        function getImage(next) {
                            var fpath = agents_dir + '/' + name + '/image_uuid';
                            fs.readFile(fpath, {
                                encoding: 'utf8'
                            }, function (er2, img_uuid) {
                                if (er2) {
                                    return next(er2);
                                }
                                image_uuid = img_uuid.trim();
                                return next();
                            });
                        },
                        function agentUuidFileExists(next) {
                            fs.exists(uuid_path, function (exists) {
                                if (exists) {
                                    uuidFileExists = true;
                                }
                                next();
                            });
                        },
                        function getUUID(next) {
                            if (!uuidFileExists) {
                                return next();
                            }
                            return fs.readFile(uuid_path, {
                                encoding: 'utf8'
                            }, function (er2, agent_uuid) {
                                if (er2) {
                                    return next(er2);
                                }
                                agentUuid = agent_uuid.trim();
                                return next();
                            });
                        }
                    ], function seriesCb(er2, results) {
                        if (er2) {
                            return _cb(er2);
                        }
                        agents.forEach(function (a) {
                            if (a.name === name) {
                                a.image_uuid = image_uuid;
                                if (agentUuid) {
                                    a.uuid = agentUuid;
                                }
                            }
                        });
                        return _cb();
                    });
                }, function (er3) {
                    if (er3) {
                        return callback('Cannot get agents image versions');
                    }
                    return callback();
                });
            });
        },
        function postAgentsToCnapi(callback) {
            var url = 'http://' + cnapiaddr;

            var restifyOptions = {
                url: url,
                connectTimeout: 5000,
                requestTimeout: 5000
            };

            log.info('cnapi ip was %s', cnapiaddr);
            var client = restify.createJsonClient(restifyOptions);

            client.post('/servers/' + uuid, {
                agents: agents
            }, function (err) {
                if (err) {
                    log.warn({
                        error: err
                    }, 'posting agents to cnapi');
                } else {
                    log.info('posted agents info to cnapi');
                }
                return callback();
            });
        }
    ], function waterfallCb(err) {
        return cb(err);
    });
}

Task.createTask(AgentInstallTask);

function start(callback) {
    var self = this;
    var apm = new APM({log: self.log});
    var image_uuid = self.req.params.image_uuid;
    var opts = {
        imgapi_domain: self.sdcConfig.imgapi_domain,
        log: self.log,
        output_prefix: '/var/tmp/' + image_uuid
    };
    var package_file;
    var package_name;
    var self_update = process.env.PORT &&
        String(process.env.PORT) === '5310';

    // We only proceed to install package if the agent is not cn-agent or,
    // in case it is cn-agent, when we are running the code from
    // cn-agent-update service (self_update = true):
    var do_update;

    // In case we're installing the first instance of an agent, instead
    // of updating an existing one:
    var is_update = true;

    // If the task has been created by cn-agent and sent to cn-agent-update,
    // it will contain both, package_file and package_name from the previous
    // iteration:
    if (self.req.params.package_file && self.req.params.package_name) {
        package_name = self.req.params.package_name;
        package_file = self.req.params.package_file;
    }

    async.waterfall([
        function getImage(cb) {
            // If we already got these from cn-agent sending the task to
            // cn-agent-update, we can safely skip this step:
            if (package_file && package_name) {
                return cb();
            }
            return getAgentImage(image_uuid, opts, function (err, file, name) {
                if (err) {
                    return cb(err);
                }

                self.log.debug('downloaded agent %s image %s to %s',
                        name, image_uuid, file);

                package_file = file;
                package_name = name;
                return cb();
            });
        },
        function enableCNAgentUpdate(cb) {
            do_update = (package_name !== 'cn-agent') ||
                ((package_name === 'cn-agent') && self_update);

            if (do_update) {
                return cb();
            }
            var args = ['enable', 'cn-agent-update'];
            var cmd = '/usr/sbin/svcadm';
            self.log.debug({cmdline: cmd + ' ' + args.join(' ')}, 'executing');
            return execFile(cmd, args, function (err, stdout, stderr) {
                if (err) {
                    self.log.error({
                        err: err
                    }, 'failed to enable cn-agent-update service');
                    return cb(err);
                }
                self.log.debug({
                    stdout: stdout,
                    stderr: stderr
                }, 'enable-cn-agent');
                return cb();
            });
        },
        function sendCNUpdateAgentTask(cb) {
            if (do_update) {
                return cb();
            }
            function sendTask() {
                var client = restify.createJsonClient({
                    url: 'http://' + self.req.req_host.split(':')[0] + ':5310',
                    log: logger
                });
                self.log.trace({client: client}, 'restify client');
                client.post('/tasks', {
                    task: 'agent_install',
                    params: {
                        image_uuid: image_uuid,
                        package_name: package_name,
                        package_file: package_file
                    }
                }, function cliCb(err, req, res, obj) {
                    self.log.trace({res: res}, 'restify client response');
                    if (err) {
                        self.log.error({
                            err: err
                        }, 'failed to send task to cn-agent-update');
                        return cb(err);
                    }
                    self.log.debug({
                        res: res
                    }, 'send-cn-agent-update-task');
                    return cb();
                });
            }

            // We need to give time to the cn-agent-update service to come up:
            return setTimeout(sendTask, 5 * 1000);
        },
        function isUpdate(cb) {
            var agent_dir = '/opt/smartdc/agents/lib/node_modules/' +
                            package_name;
            fs.stat(agent_dir, function (er, st) {
                if (er && er.code === 'ENOENT') {
                    is_update = false;
                }
                return cb();
            });
        },
        function backupAgent(cb) {
            if (!do_update || !is_update) {
                return cb();
            }
            var prefix = '/opt/smartdc/agents/lib/node_modules/';
            var cmd = '/usr/bin/cp';
            var args = [
                '-rP',
                prefix + package_name,
                prefix + package_name + '.updating-to.' + image_uuid
            ];
            self.log.debug({cmdline: cmd + ' ' + args.join(' ')}, 'executing');
            return execFile(cmd, args, function (err, stdout, stderr) {
                if (err) {
                    self.log.error({
                        err: err
                    }, 'failed to backup agent');
                    return cb(err);
                }
                self.log.debug({
                    stdout: stdout,
                    stderr: stderr
                }, 'backup agent');
                return cb();
            });
        },
        function installPackage(cb) {
            if (!do_update) {
                return cb();
            }
            // In the case we have an error during the installPackages phase,
            // we'll restore the agent backup before we bubble the error up:
            return apm.installPackages([package_file], function (err) {
                if (err) {
                    self.log.error({
                        err: err
                    }, 'failed to install agent package');
                    if (!is_update) {
                        return cb(err);
                    }
                    self.log.info('restoring agent backup');
                    var prefix = '/opt/smartdc/agents/lib/node_modules/';
                    var cmd = '/usr/bin/cp';
                    var args = [
                        '-rP',
                        prefix + package_name + '.updating-to.' + image_uuid,
                        prefix + package_name
                    ];
                    self.log.debug({
                        cmdline: cmd + ' ' + args.join(' ')
                    }, 'executing');
                    return execFile(cmd, args, function (er2, stdout, stderr) {
                        if (er2) {
                            self.log.error({
                                err: er2
                            }, 'failed to restore agent backup');
                            // Still, we'll return the previous error here:
                            return cb(err);
                        }
                        self.log.debug({
                            stdout: stdout,
                            stderr: stderr
                        }, 'restore agent backup');
                        return cb(err);
                    });
                }
                return cb();
            });
        },
        function cleanupBackup(cb) {
            if (!do_update || !is_update) {
                return cb();
            }
            // All good, update done, let's cleanup the backup:
            var cmd = '/usr/bin/rm';
            var args = [
                '-rf',
                '/opt/smartdc/agents/lib/node_modules/' + package_name +
                     '.updating-to.' + image_uuid
            ];
            self.log.debug({cmdline: cmd + ' ' + args.join(' ')}, 'executing');
            return execFile(cmd, args, function (err2, stdout, stderr) {
                // We will not fail the operation anyway, backup directory will
                // not affect normal operation and can be removed later:
                if (err2) {
                    self.log.error({
                        err: err2
                    }, 'failed to remove agent backup');
                }
                self.log.debug({
                    stdout: stdout,
                    stderr: stderr
                }, 'remove agent backup');
                return cb();
            });

        },
        function sendAgentsToCNAPI(cb) {
            if (!do_update) {
                return cb();
            }
            // We will not fail here in case of error:
            return updateAgents({log: self.log}, function (err) {
                if (err) {
                    self.log.error({
                        err: err
                    }, 'Error posting agents to CNAPI');
                } else {
                    self.log.info('Agents updated into CNAPI');
                }
                return cb();
            });
        },
        function sendCNAgentTask(cb) {
            if (!do_update || package_name !== 'cn-agent') {
                return cb();
            }
            // Once we've updated the CN Agent from cn-agent-update, we'll send
            // a message to cn-agent to run a new task to disable
            // cn-agent-update service, "shutdown_cn_agent_update":
            function sendTask() {
                var client = restify.createJsonClient({
                    url: 'http://' + self.req.req_host.split(':')[0] + ':5309',
                    log: logger
                });

                client.post('/tasks', {
                    task: 'shutdown_cn_agent_update',
                    params: {}
                }, function cliCb(err, req, res, obj) {
                    if (err) {
                        self.log.error({
                            err: err
                        }, 'failed to send task to cn-agent');
                        return cb(err);
                    }
                    self.log.debug({
                        res: res
                    }, 'send-cn-agent-task');
                    return cb();
                });
            }
            // We need to give time to the cn-agent service to come up:
            return setTimeout(sendTask, 5 * 1000);

        }
    ], function agentInstallTaskCb(err) {
        if (err) {
            return self.fatal('AgentInstall error: ' + err.message);
        }

        self.progress(100);
        return self.finish();

    });
}

AgentInstallTask.setStart(start);

module.exports = AgentInstallTask;
