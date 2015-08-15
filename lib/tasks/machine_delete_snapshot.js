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

var MachineDeleteSnapshotTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineDeleteSnapshotTask);

function start(callback) {
    var self = this;
    var opts = {};

    opts = self.req.params;
    opts.log = self.log;
    opts.req_id = self.req.req_id;
    opts.vmadmLogger = common.makeVmadmLogger(self);

    vmadm.delete_snapshot(opts, function (error) {
        var loadOpts = {};

        if (error &&
            !(error.message && error.message.match('No snapshot named'))) {

            var msg = error instanceof Error ? error.message : error;
            self.fatal('vmadm.delete_snapshot error: ' + msg);
            return;
        }

        loadOpts.log = self.log;
        loadOpts.req_id = self.req.req_id;
        loadOpts.uuid = self.req.params.uuid;
        loadOpts.vmadmLogger = self.vmadmLogger;

        vmadm.load(
            loadOpts,
            function (loadError, machine)
        {
            if (loadError) {
                self.fatal('vmadm.load error: ' + loadError.message);
                return;
            }

            self.finish({ vm: machine });
        });
    });
}

MachineDeleteSnapshotTask.setStart(start);
