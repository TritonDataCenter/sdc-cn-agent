/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var vasync = require('vasync');

var common = require('../common');
var Task = require('../../../task_agent/task');
var vmadm = require('../lib/vmadm');


var MachineDestroyTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineDestroyTask);

function start() {
    var self = this;
    var uuid = self.req.params.uuid;
    var vmadmOpts = {};

    vmadmOpts.log = self.log;
    vmadmOpts.req_id = self.req.req_id;
    vmadmOpts.uuid = uuid;
    vmadmOpts.sysinfo = self.req.sysinfo;

    vasync.pipeline({
        funcs: [
            function ensureProvisionComplete(_, cb) {
                common.ensureProvisionComplete(self.req.uuid, cb);
            },
            function deleteVm(_, cb) {
                /* this will pass the error (if any) to _pipelineCompleted */
                vmadm.delete(vmadmOpts, cb);
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
