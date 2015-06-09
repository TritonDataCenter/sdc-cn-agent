/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var Task = require('../task_agent/task');
var VM = require('/usr/vm/node_modules/VM');
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

    //VM.logger = common.makeVmadmLogger(self);
    //VM.logname = 'machine_destroy';

    common.ensureProvisionComplete(self.req.uuid, function () {
        /*JSSTYLED*/
        vmadm.delete({ uuid: uuid, log: self.log }, function (error) {
            if (!error || (error &&
                error.message && error.message.match(': No such zone')))
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
