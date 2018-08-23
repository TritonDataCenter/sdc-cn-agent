/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var assert = require('assert-plus');

var DummyVmadm = require('vmadm/lib/index.dummy');

var common = require('../common');
var Task = require('../../../task_agent/task');


var MachineLoadTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineLoadTask);

function start(callback) {
    var self = this;
    var opts = {};
    var vmadm;

    assert.object(self.log, 'self.log');
    assert.object(self.req, 'self.req');
    assert.string(self.req.req_id, 'self.req.req_id');
    assert.object(self.req.params, 'self.req.params');
    assert.uuid(self.req.params.uuid, 'self.req.params.uuid');
    assert.object(self.sysinfo, 'self.sysinfo');
    assert.uuid(self.sysinfo.UUID, 'self.sysinfo.UUID');

    opts.log = self.log;
    opts.req_id = self.req.req_id;
    opts.sysinfo = self.sysinfo;
    opts.uuid = self.req.params.uuid;

    // Create a new vmadm just for this server
    vmadm = new DummyVmadm({
        log: self.log,
        serverRoot: common.SERVER_ROOT,
        sysinfo: self.sysinfo,
        uuid: self.sysinfo.UUID
    });

    vmadm.load(opts, function _onLoad(error, vmobj) {
        var msg;

        if (error) {
            msg = error instanceof Error ? error.message : error;

            if (error.restCode) {
                self.fatal('VM.load error: ' + msg,
                    { restCode: error.restCode });
            } else {
                self.fatal('VM.load error: ' + msg);
            }
            return;
        }

        self.finish(vmobj);
    });
}

MachineLoadTask.setStart(start);
