/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var Task = require('../task_agent/task');
var vmadm = require('vmadm');
var execFile = require('child_process').execFile;
var common = require('../common');

var MachineLoadTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineLoadTask);

function start(callback) {
    var self = this;
    var uuid = self.req.params.uuid;

    vmadm.logger = common.makeVmadmLogger(self);
    vmadm.logname = 'machine_load';

    vmadm.load({ uuid: uuid, log: self.log }, function (error, machine) {
        if (error) {
            var msg = error instanceof Error ? error.message : error;
            self.fatal('vmadm.load error: ' + msg);
            return;
        }
        self.finish(machine);
    });
}

MachineLoadTask.setStart(start);
