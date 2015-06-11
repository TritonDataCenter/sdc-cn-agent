/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var Task = require('../task_agent/task');
var fw = require('fw');
var vmadm = require('vmadm');
var common = require('../common');

var FwAddTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(FwAddTask);

function start(callback) {
    var self = this;
    var opts = {};

    opts.full = true;
    opts.log = self.log;
    opts.req_id = self.req.req_id;
    opts.vmadmLogger = common.makeVmadmLogger(self);

    return vmadm.lookup({}, opts, function (err, vms) {
        if (err) {
            var msg = err instanceof Error ? err.message : err;
            return self.fatal('vmadm.lookup error: ' + msg);
        }

        self.progress(50);

        var fwOpts = self.req.params;
        fwOpts.vms = vms;
        fwOpts.logName = 'provisioner_fw_add';

        return fw.add(fwOpts, function (err2, res) {
            if (err2) {
                return self.fatal('fw.add error: ' + err2.message);
            }

            self.progress(100);
            return self.finish();
        });
    });
}

FwAddTask.setStart(start);
