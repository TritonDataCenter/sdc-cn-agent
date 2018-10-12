/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var common = require('../common');
var DummyVmadm = require('vmadm/lib/index.dummy_vminfod');
var Task = require('../../../task_agent/task');

var MachineRollbackSnapshotTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineRollbackSnapshotTask);

function start(callback) {
    var self = this;
    var opts = {};
    var vmadm;

    opts = self.req.params;
    opts.log = self.log;
    opts.req_id = self.req.req_id;

    // Create a new vmadm just for this server
    vmadm = new DummyVmadm({
        log: self.log,
        serverRoot: common.SERVER_ROOT,
        sysinfo: self.sysinfo,
        uuid: self.sysinfo.UUID
    });

    vmadm.rollback_snapshot(opts, function (error) {
        var loadOpts = {};

        if (error) {
            var msg = error instanceof Error ? error.message : error;
            if (error.restCode) {
                self.fatal('vmadm.rollback_snapshot error: ' + msg,
                    { restCode: error.restCode });
            } else {
                self.fatal('vmadm.rollback_snapshot error: ' + msg);
            }
            return;
        }

        loadOpts.log = self.log;
        loadOpts.req_id = self.req.req_id;
        loadOpts.uuid = self.req.params.uuid;

        vmadm.load(
            loadOpts,
            function (loadError, machine)
        {
            if (loadError) {
                if (loadError.restCode) {
                    self.fatal('vmadm.load error: ' + loadError.message,
                        { restCode: loadError.restCode });
                } else {
                    self.fatal('vmadm.load error: ' + loadError.message);
                }
                return;
            }

            self.finish({ vm: machine });
        });
    });
}

MachineRollbackSnapshotTask.setStart(start);
