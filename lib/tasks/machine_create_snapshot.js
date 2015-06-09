/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var Task = require('../task_agent/task');
var VM = require('/usr/vm/node_modules/VM');
var vmadm = require('vmadm');
var execFile = require('child_process').execFile;
var common = require('../common');

var MachineCreateSnapshotTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineCreateSnapshotTask);

function start(callback) {
    var self = this;

    // VM.logger = common.makeVmadmLogger(self);
    // VM.logname = 'machine_create_snapshot';
    self.vmadmLogger = common.makeVmadmLogger(self);

    self.req.params.log = self.log;

    vmadm.create_snapshot(self.req.params, function (error) {
        if (error) {
            var msg = error instanceof Error ? error.message : error;
            self.fatal('vmadm.create_snapshot error: ' + msg);
            return;
        }
        self.finish();
    });
}

MachineCreateSnapshotTask.setStart(start);
