/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var common = require('../common');
var execFile = require('child_process').execFile;
var fs = require('fs');
var path = require('path');
var smartdcconfig = require('../smartdc-config');
var Task = require('../task_agent/task');
var vasync = require('vasync');
var vmadm = require('vmadm');

/*
 * We'll try to work around logadm bugs (See OS-6053) for platforms older than
 * this. 20171125T020845Z is the first Jenkins platform that had the "fix".
 */
var LOGADM_WORKAROUND_PLATFORM = '20171125T020845Z.';

var MachineDestroyTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineDestroyTask);

function start() {
    var self = this;
    var uuid = self.req.params.uuid;
    var vmadmOpts = {};
    var workaroundLogadm = false;
    var workaroundLogFile = path.join('/zones', uuid, '/root/tmp/vm.log');

    vmadmOpts.log = self.log;
    vmadmOpts.req_id = self.req.req_id;
    vmadmOpts.uuid = uuid;
    vmadmOpts.vmadmLogger = common.makeVmadmLogger(self);

    vasync.pipeline({
        funcs: [
            function ensureProvisionComplete(_, cb) {
                common.ensureProvisionComplete(self.req.uuid, cb);
            },
            function detectLogadmBugWorkaroundRequired(_, cb) {
                /*
                 * This can go away when the fix to OS-6053 is older than the
                 * minimum supported platform for Triton.
                 *
                 */
                fs.access(workaroundLogFile, function _onAccess(accessErr) {
                    if (accessErr) {
                        /* on any error, we assume we don't need workaround */
                        cb();
                        return;
                    }

                    /* no error, so file exists and VM is probably KVM VM */
                    smartdcconfig.sysinfo(function (sysinfoErr, sysinfo) {
                        if (sysinfoErr) {
                            /*
                             * If we failed to load sysinfo, we'll just skip KVM
                             * log cleanup. This is best-effort and the log will
                             * get cleaned up when the system is updated to
                             * OS-6053 anyway.
                             */
                            cb();
                            return;
                        }

                        /*
                         * 'Live Image' should be something like:
                         *
                         *   20170922T193941Z
                         */
                        if (sysinfo['Live Image'] <
                            LOGADM_WORKAROUND_PLATFORM) {

                            workaroundLogadm = true;
                            self.log.warn({uuid: uuid}, 'VM appears to be ' +
                                'KVM: will try to work around logadm');
                        }

                        cb();
                        return;
                    });
                });
            },
            function deleteVm(_, cb) {
                /* this will pass the error (if any) to _pipelineCompleted */
                vmadm.delete(vmadmOpts, cb);
            },
            function cleanupKvmLogs(_, cb) {
                var args = ['-r', workaroundLogFile];

                /*
                 * This can go away when the fix to OS-6053 is older than the
                 * minimum supported platform for Triton.
                 *
                 */
                if (!workaroundLogadm) {
                    cb();
                    return;
                }

                execFile('/usr/sbin/logadm', args, function _onExec(err) {
                    if (err) {
                        /*
                         * We only log here, because this is a best-effort
                         * attempt to work around a bug, it's not considered
                         * fatal if it doesn't work.
                         */
                        self.log.debug({uuid: uuid}, 'Failed to cleanup ' +
                            'after logadm bugs: ignoring');
                    }
                    cb();
                });
            }
        ]
    }, function _pipelineComplete(err) {
        var errLines = [];
        var lastErrLine = '';
        var msg;

        if (!err) {
            /* Success! */
            self.finish();
            return;
        }

        if (err.stderrLines) {
            errLines = err.stderrLines.split('\n');
            if (errLines.length > 0) {
                lastErrLine = errLines[errLines.length - 1];
            }
        }

        if (lastErrLine.match(': No such zone') ||
            (err.restCode && (err.restCode === 'VmNotFound'))) {

            /*
             * The zone doesn't exist, so consider the delete a success (so
             * we're idempotent)
             */
            self.finish();
            return;
        }

        msg = err instanceof Error ? err.message : err;
        self.fatal('delete error: ' + msg);
    });
}

MachineDestroyTask.setStart(start);
