/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var Task = require('../task_agent/task');
var sysinfo = require('../task_agent/smartdc-config').sysinfo;
var VM = require('/usr/vm/node_modules/VM');
var async = require('async');
var common = require('../common');
var fork = require('child_process').fork;
var once = require('once');
var util = require('util');


var DockerExecTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(DockerExecTask);

DockerExecTask.setStart(start);

function start(callback) {
    var self = this;

    var command = self.req.params.command;
    var uuid = self.req.params.uuid;
    var ready_to_exec = false;

    /*
     * We want to check first that the VM is actually running. If not and the
     * VM is < 60s old, we wait. If it's 60s+ old, we fail immediately.
     *
     * TODO: use vminfod instead of polling when it's available
     */
    async.until(function _testReadyToExec() {
        if (ready_to_exec) {
            self.log.info('VM is now ready to exec');
            return true;
        }
        return false;
    }, function _checkVM(cb) {
        var vmopts = { fields: ['create_timestamp', 'zone_state'] };

        if (command.Logs && (command.Cmd[0] === 'Logs')) {
            ready_to_exec = true;
            cb();
            return;
        }

        VM.load(uuid, vmopts, function (err, vmobj) {
            var create_time;
            var msg;
            var now = (new Date()).getTime() / 1000;

            if (err) {
                self.log.error({err: err}, 'VM.load error');
                cb(err);
                return;
            }

            if (vmobj.zone_state === 'running') {
                ready_to_exec = true;
                cb();
                return;
            }

            if (!command.AttachConsole) {
                // it's only AttachConsole that ever waits for the VM to start
                msg = 'docker_exec: VM is not running, cannot exec';
                self.log.error(msg);
                cb(new Error(msg));
                return;
            }

            create_time = (new Date(vmobj.create_timestamp)).getTime() / 1000;

            if ((now - create_time) > 60) {
                // VM is more than 60 seconds old, don't wait any longer.
                msg = 'docker_exec: VM is ' + (now - create_time)
                    + 'seconds old and is not running, not waiting';
                self.log.error(msg);
                cb(new Error(msg));
                return;
            }

            // If the VM is new and not running, we'll try again soon.
            self.log.info('VM is %d seconds old and not running, waiting',
                (now - create_time));

            setTimeout(cb, 5000);
        });
    }, function _doExec(err) {
        var binfn = __dirname + '/../../bin/docker-exec.js';
        var dockerExec;
        var opts = {};

        if (err) {
            self.fatal(err.message);
            return;
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
    });
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
