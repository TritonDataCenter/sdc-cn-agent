/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var Task = require('../task_agent/task');
var vmadm = require('/usr/vm/node_modules/VM');
var execFile = require('child_process').execFile;
var common = require('../common');

var MachineInfoTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineInfoTask);

function start(callback) {
    var self = this;

    // VM.logger = common.makeVmadmLogger(self);
    // VM.logname = 'machine_info';
    self.vmadmLogger = common.makeVmadmLogger(self);

    if (!self.req.params.types) {
        self.req.params.types = [];
    }

    self.req.params.log = self.log;

    vmadm.info(self.req.params, function (error, info) {
        if (error) {
            var msg = error instanceof Error ? error.message : error;
            self.fatal('VM.info error: ' + msg);
            return;
        }
        self.finish(info);
    });
}

MachineInfoTask.setStart(start);
