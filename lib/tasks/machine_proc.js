/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var common = require('../common');
var execFile = require('child_process').execFile;
var procread = require('procread');
var Task = require('../task_agent/task');
var vmadm = require('vmadm');
var VM  = require('/usr/vm/node_modules/VM');

var MachineProcTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineProcTask);

function start(callback) {
    var log;
    var self = this;
    var uuid = self.req.params.uuid;
    var vmadmOpts = {};

    log = self.log;
    self.vmadmLogger = common.makeVmadmLogger(self);

    vmadmOpts.log = self.log;
    vmadmOpts.req_id = self.req.req_id;
    vmadmOpts.uuid = uuid;
    vmadmOpts.vmadmLogger = common.makeVmadmLogger(self);

    if (!uuid) {
        self.fatal('missing uuid for machine_proc');
        return;
    }

    vmadm.load(vmadmOpts, { fields: [
        'brand',
        'pid',
        'zone_state'
    ]}, function (err, vmobj) {
        if (err) {
            var msg = err instanceof Error ? err.message : err;
            self.fatal('vmadm.load error: ' + msg);
            return;
        }

        if (vmobj.zone_state !== 'running') {
            self.fatal('VM is not running', { restCode: 'VmNotRunning' });
            return;
        }

        procread.getZoneProcs(uuid, function (proc_err, procs) {
            var init_pid = vmobj.pid;
            var zsched_pid;

            if (proc_err) {
                self.fatal('failed to get processes: ' + proc_err.message);
                return;
            }

            if (vmobj.brand === 'lx') {
                // first find zched PID by looking at init's parent
                Object.keys(procs).forEach(function (p) {
                    if (procs[p].psinfo.pr_pid === init_pid) {
                        zsched_pid = procs[p].psinfo.pr_ppid;
                        log.debug({zsched: zsched_pid}, 'found zsched PID');
                    }
                });

                // now replace all instances of init_pid and zsched_pid
                Object.keys(procs).forEach(function (p) {
                    ['pr_pid', 'pr_ppid'].forEach(function (pid_field) {
                        var psinfo = procs[p].psinfo;

                        if (psinfo[pid_field] === init_pid) {
                            log.debug('replacing %s(%s), old: %d new: %d',
                                pid_field, psinfo.pr_fname, init_pid, 1);
                            psinfo[pid_field] = 1;
                        } else if (psinfo[pid_field] === zsched_pid) {
                            if (pid_field === 'pr_pid') {
                                // we also want to set PPID to zero for zsched
                                log.debug('replacing %s(%s), old: %d new: %d',
                                    'pr_ppid', psinfo.pr_fname, zsched_pid, 0);
                                psinfo.pr_ppid = 0;
                            }
                            log.debug('replacing %s(%s), old: %d new: %d',
                                pid_field, psinfo.pr_fname, zsched_pid, 0);
                            psinfo[pid_field] = 0;
                        }
                    });
                });
            }

            self.finish(procs);
            return;
        });
    });
}

MachineProcTask.setStart(start);
