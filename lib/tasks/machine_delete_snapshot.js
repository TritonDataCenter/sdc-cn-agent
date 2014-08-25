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

var MachineDeleteSnapshotTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineDeleteSnapshotTask);

function start(callback) {
    var self = this;

    VM.logger = common.makeVmadmLogger(self);
    VM.logname = 'machine_delete_snapshot';

    var uuid = self.req.params.uuid;
    var snapname = self.req.params.snapshot_name;

    VM.delete_snapshot(uuid, snapname, {}, function (error) {
        if (!error || (error &&
            error.message && error.message.match('No snapshot named')))
        {
            self.progress(100);
            self.finish();
        } else if (error) {
            var msg = error instanceof Error ? error.message : error;
            self.fatal('VM.delete_snapshot error: ' + msg);
            return;
        }
    });
}

MachineDeleteSnapshotTask.setStart(start);
