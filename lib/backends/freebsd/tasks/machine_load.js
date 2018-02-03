/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var assert = require('assert-plus');
var vmadm = require('vmadm');

var Task = require('../../../task_agent/task');

var MachineLoadTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineLoadTask);

function start(callback) {
    var self = this;
    var opts = {};

    assert.object(self.log, 'self.log');
    assert.object(self.req, 'self.req');
    assert.string(self.req.req_id, 'self.req.req_id');
    assert.object(self.req.params, 'self.req.params');
    assert.uuid(self.req.params.uuid, 'self.req.params.uuid');

    opts.log = self.log;
    opts.req_id = self.req.req_id;
    opts.uuid = self.req.params.uuid;

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
