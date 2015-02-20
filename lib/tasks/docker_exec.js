/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var Task = require('../task_agent/task');
var sysinfo = require('../task_agent/smartdc-config').sysinfo;
var VM = require('/usr/vm/node_modules/VM');
var async = require('async');
var common = require('../common');
var fork = require('child_process').fork;
var once = require('once');
var path = require('path');
var wait_flag = require('../update-wait-flag');

var RUNNING_CHECK_INTERVAL = 200; // ms (how long to wait between VM.load's)
var WAIT_TIMEOUT = 60;            // seconds

// GLOBAL!
var timeout_at;

var DockerExecTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(DockerExecTask);

DockerExecTask.setStart(start);

function execWhenRunning(uuid, command, log, callback)
{
    var loops = 0;
    var ready_to_exec = false;
    var _vmobj;

    /*
     * TODO: use vminfod instead of polling when it's available
     */
    async.until(function _testReadyToExec() {
        if (ready_to_exec) {
            log.info('VM is now ready to exec');
            return true;
        }
        return false;
    }, function _checkVM(cb) {
        var vmopts = { fields: ['brand', 'create_timestamp', 'zone_state'] };

        loops++;

        // We're always ready for logs.
        if (command.Logs && (command.Cmd[0] === 'Logs')) {
            ready_to_exec = true;
            cb();
            return;
        }

        VM.load(uuid, vmopts, function (err, vmobj) {
            var msg;
            var now = (new Date()).getTime();

            if (err) {
                log.error({err: err}, 'VM.load error');
                cb(err);
                return;
            }

            _vmobj = vmobj;

            if (vmobj.zone_state === 'running') {
                ready_to_exec = true;
                cb();
                return;
            }

            if (!command.AttachConsole) {
                // It's only AttachConsole that ever waits for the VM to start.
                // This must have been a regular `docker exec` which cannot work
                // when the VM is stopped.
                msg = 'docker_exec: VM is not running, cannot exec';
                log.error(msg);
                cb(new Error(msg));
                return;
            }

            // If we got this far, we're an AttachConsole and we'll get back
            // here again in a loop until either we've timed out or the VM has
            // gone running.
            if (now > timeout_at) {
                msg = 'timed out waiting for container to be attachable';
                log.error({vm: vmobj.uuid}, msg);
                cb(new Error(msg));
                return;
            }

            // If the VM is new and not running, we'll try again soon.
            if ((loops % Math.ceil(1000 / RUNNING_CHECK_INTERVAL)) === 0) {
                log.info('VM is not running, waiting up to ',
                    (timeout_at - now) + ' ms');
            }

            setTimeout(cb, RUNNING_CHECK_INTERVAL);
        });
    }, function (err) {
        callback(err, _vmobj);
    });
}

function start(callback) {
    var self = this;

    var command = self.req.params.command;
    var mdata_filename;
    var uuid = self.req.params.uuid;

    timeout_at = (new Date()).getTime() + (WAIT_TIMEOUT * 1000);

    function _spawnExec(err, vmobj) {
        var binfn = __dirname + '/../../bin/docker-exec.js';
        var brand;
        var dockerExec;
        var opts = {};

        if (err) {
            self.fatal(err.message);
            return;
        }

        if (vmobj && vmobj.brand) {
            brand = vmobj.brand;
        } else {
            brand = 'unknown';
        }

        dockerExec = fork(binfn, [], opts);

        sysinfo(function (si_err, sysinfoObj) {
            if (si_err) {
                self.fatal({ error: si_err });
                return;
            }

            var adminIp = firstAdminIp(sysinfoObj);

            if (!adminIp) {
                self.fatal({
                    error: 'No admin NIC found in compute node sysinfo'
                });
                return;
            }

            dockerExec.send({
                req_id: self.req.req_id,
                brand: brand,
                command: command,
                uuid: uuid
            });

            dockerExec.on('message', once(function (message) {
                if (command.Detach) {
                    self.finish();
                    return;
                } else {
                    self.finish({
                        host: adminIp,
                        port: message.port
                    });
                    return;
                }
            }));
        });
    }

    /*
     * We do this (setting the metadata) here ourselves because we need to be as
     * fast as possible so that we get the best possible chance of winning the
     * race with start. If we used vmadm, we'd have extra overhead for process
     * startup, etc.
     */
    if (command.AttachConsole) {
        // XXX: should use vmobj.zonepath here instead when we have vminfod.
        mdata_filename = path.normalize('/zones/' + uuid
            + '/config/metadata.json');
        wait_flag.setWaitFlag(uuid, mdata_filename, timeout_at, self.log,
            function (err) {

            if (err) {
                _spawnExec(err);
                return;
            }
            execWhenRunning(uuid, command, self.log, _spawnExec);
        });
    } else {
        execWhenRunning(uuid, command, self.log, _spawnExec);
    }
}

function firstAdminIp(sysinfoObj) {
    var interfaces = sysinfoObj['Network Interfaces'];

    var adminifaces = Object.keys(interfaces).filter(function (iface) {
        return interfaces[iface]['NIC Names'].indexOf('admin') !== -1;
    });

    if (adminifaces && adminifaces.length) {
        return interfaces[adminifaces[0]]['ip4addr'];
    } else {
        return null;
    }
}
