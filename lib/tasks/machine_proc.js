/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var execFile = require('child_process').execFile;
var procread = require('procread');
var Task = require('../task_agent/task');

var MachineProcTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineProcTask);

function start(callback) {
    var self = this;
    var uuid = self.req.params.uuid;

    if (!uuid) {
        self.fatal('missing uuid for machine_proc');
        return;
    }

    procread.getZoneProcs(uuid, function (err, procs) {
        if (err) {
            self.fatal('failed to get processes: ' + err.message);
            return;
        }
        self.progress(100);
        self.finish(procs);
        return;
    });
}

MachineProcTask.setStart(start);
