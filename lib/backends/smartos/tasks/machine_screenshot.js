/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

var Task = require('../../../task_agent/task');
var vmadm = require('vmadm');
var execFile = require('child_process').execFile;
var fs = require('fs');

var MachineLoadTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineLoadTask);

function start(callback) {
    var self = this;
    var sysrqopts = {};

    sysrqopts.log = self.log;
    sysrqopts.req_id = self.req.req_id;
    sysrqopts.req = 'screenshot';
    sysrqopts.uuid = self.req.params.uuid;

    vmadm.sysrq(sysrqopts, function (error, response) {
        if (error) {
            var msg = error instanceof Error ? error.message : error;
            if (error.restCode) {
                self.fatal('vmadm.sysrq error: ' + msg,
                    { restCode: error.restCode });
            } else {
                self.fatal('vmadm.sysrq error: ' + msg);
            }
            return;
        }

        var ssFilename = '/zones/' + self.req.params.uuid + '/root/tmp/vm.ppm';
        self.log.info('vmadm screenshot success: ' + ssFilename);
        var ssContents = fs.readFileSync(ssFilename);
        self.log.info('File: ' + ssContents.length + ' bytes');

        self.event('screenshot', ssContents.toString('base64'));

        self.progress(100);
        self.finish();
    });
}

MachineLoadTask.setStart(start);
