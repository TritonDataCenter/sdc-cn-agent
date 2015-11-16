/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var Task = require('../task_agent/task');
var vmadm = require('vmadm');
var execFile = require('child_process').execFile;
var common = require('../common');
var async = require('async');

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
    vmadmOpts.vmadmLogger = common.makeVmadmLogger(self);

    common.ensureProvisionComplete(self.req.uuid, function () {
        /*JSSTYLED*/
        vmadm.delete(vmadmOpts, function (error) {
            var errlines = [];

            if (error && error.stderrLines) {
                errlines = error.stderrLines.split('\n');
            }
            if (!error || (error && errlines.length > 0 &&
                errlines[errlines.length - 1].match(': No such zone')))
            {
                self.finish();
            } else if (error) {
                var msg = error instanceof Error ? error.message : error;
                self.fatal('vmadm.delete error: ' + msg);
                return;
            }
        });
    });
}

MachineDestroyTask.setStart(start);
