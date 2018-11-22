/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018 Joyent, Inc.
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


var child_process = require('child_process');
var execFile = child_process.execFile;
var fs = require('fs');

var async = require('async');
var bunyan = require('bunyan');
var restify = require('restify');

var APM = require('../../../apm').APM;
var backendCommon = require('../../common');
var refreshAgents = require('./shared').refreshAgents;
var smartdc_config = require('../smartdc-config');
var Task = require('../../../task_agent/task');


function AgentInstallTask(req) {
    Task.call(this);
    this.req = req;
}

var logger = bunyan.createLogger({
    name: 'apm',
    stream: process.stderr,
    level: 'debug',
    serializers: bunyan.stdSerializers
});


Task.createTask(AgentInstallTask);

function start() {
    var self = this;
    var apm = new APM({log: self.log});
    var image_uuid = self.req.params.image_uuid;
    var imgapiUrl;
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

    // If install/update fails we want to remove the new agent directory and
    // eventually restore a previous backup
    var install_failed = false;

    // Also, on these cases we want to return the original install error
    // instead of any eventual errors removing the failed agent directory
    // or restoring the backup:
    var install_failed_err;

    // If the task has been created by cn-agent and sent to cn-agent-update,
    // it will contain both, package_file and package_name from the previous
    // iteration:
    if (self.req.params.package_file && self.req.params.package_name) {
        package_name = self.req.params.package_name;
        package_file = self.req.params.package_file;
    }

    async.waterfall([
        function getSdcConfigImgapiDomain(cb) {
            smartdc_config.sdcConfig(function (configError, config) {
                if (configError) {
                    cb(configError);
                    return;
                }

                imgapiUrl = 'http://' + config.imgapi_domain;
                cb();
            });
        },
        function getImage(cb) {
            // If we already got these from cn-agent sending the task to
            // cn-agent-update, we can safely skip this step:
            if (package_file && package_name) {
                cb();
                return;
            }

            backendCommon.getAgentImage(image_uuid, {
                imgapiUrl: imgapiUrl,
                log: self.log,
                outputDir: '/var/tmp',
                outputPrefix: image_uuid
            }, function _onAgentImage(err, file, name) {
                if (err) {
                    cb(err);
                    return;
                }

                self.log.debug('downloaded agent %s image %s to %s',
                        name, image_uuid, file);

                package_file = file;
                package_name = name;
                cb();
            });
        },
        function enableCNAgentUpdate(cb) {
            var args = ['enable', 'cn-agent-update'];
            var cmd = '/usr/sbin/svcadm';

            do_update = (package_name !== 'cn-agent') ||
                ((package_name === 'cn-agent') && self_update);

            if (do_update) {
                return cb();
            }

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
                }, function cliCb(err, req, res) {
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
            fs.stat(agent_dir, function (er) {
                if (er && er.code === 'ENOENT') {
                    is_update = false;
                }
                return cb();
            });
        },
        function cleanupPreviousBackup(cb) {
            var backup_dir = '/opt/smartdc/agents/lib/node_modules/' +
                package_name + '.updating-to.' + image_uuid;
            fs.stat(backup_dir, function (er) {
                if (er) {
                    if (er.code === 'ENOENT') {
                        cb();
                    } else {
                        cb(er);
                    }
                    return;
                }

                var cmd = '/usr/bin/rm';
                var args = [
                    '-rf',
                    backup_dir
                ];

                self.log.debug({
                    backup_dir: backup_dir,
                    cmdline: cmd + ' ' + args.join(' ')
                }, 'Removing backup dir from previous execution');

                execFile(cmd, args, function (err, stdout, stderr) {
                    if (err) {
                        self.log.error({
                            err: err
                        }, 'failed to remove backup');
                        cb(err);
                        return;
                    }
                    self.log.debug({
                        stdout: stdout,
                        stderr: stderr
                    }, 'backup removed');
                    cb();
                    return;
                });
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
                cb();
                return;
            }
            // In the case we have an error during the installPackages phase,
            // we'll restore the agent backup before we bubble the error up:
            apm.installPackages([package_file], function (err) {
                if (err) {
                    self.log.error({
                        err: err
                    }, 'failed to install agent package');
                    install_failed = true;
                    install_failed_err = err;
                }
                cb();
            });
        },
        function cleanupFailedInstall(cb) {
            if (!install_failed) {
                cb();
                return;
            }
            var cmd = '/usr/bin/rm';
            var args = [
                '-rf',
                '/opt/smartdc/agents/lib/node_modules/' + package_name
            ];

            self.log.debug({
                cmdline: cmd + ' ' + args.join(' ')
            }, 'Removing failed install dir');

            execFile(cmd, args, function (err, stdout, stderr) {
                if (err) {
                    self.log.error({
                        err: err
                    }, 'failed to remove failed install dir');
                    cb(err);
                    return;
                }
                self.log.debug({
                    stdout: stdout,
                    stderr: stderr
                }, 'failed install dir removed');
                cb();
                return;
            });
        },
        function restoreBackup(cb) {
            if (!install_failed || !is_update) {
                cb();
                return;
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
            execFile(cmd, args, function (er2, stdout, stderr) {
                if (er2) {
                    self.log.error({
                        err: er2
                    }, 'failed to restore agent backup');
                    // Still, we'll return the previous error here:
                    if (install_failed_err) {
                        cb(install_failed_err);
                    } else {
                        cb(er2);
                    }
                    return;
                }
                self.log.debug({
                    stdout: stdout,
                    stderr: stderr
                }, 'restore agent backup');
                cb(install_failed_err);
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
            return refreshAgents({log: self.log}, function (err) {
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
            if (!do_update || package_name !== 'cn-agent') {
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
                }, function cliCb(err, req, res) {
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
