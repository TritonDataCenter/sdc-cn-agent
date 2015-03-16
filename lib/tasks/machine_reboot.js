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
var execFile = require('child_process').execFile;
var common = require('../common');

var MachineRebootTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineRebootTask);

function start(callback) {
    var self = this;
    var force = self.req.params.force;
    var opts = {};
    var timeout = self.req.params.timeout;
    var uuid = self.req.params.uuid;

    VM.logger = common.makeVmadmLogger(self);
    VM.logname = 'machine_reboot';

    if (force) {
        opts.force = true;
    }

    if (timeout) {
        if ((typeof (timeout) === 'string') && timeout.match(/^[0-9]+$/)) {
            opts.timeout = Number(timeout);
        } else if (typeof (timeout) === 'number') {
            opts.timeout = timeout;
        } else {
            self.fatal('Invalid type: "' + typeof (timeout) + '" for timeout');
            return;
        }
    }

    VM.reboot(uuid, opts, function (error) {
        if (error) {
            var msg = error instanceof Error ? error.message : error;
            self.fatal('VM.reboot error: ' + msg);
            return;
        }
        self.progress(100);
        self.finish();
    });
}

MachineRebootTask.setStart(start);
