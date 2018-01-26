/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var Task = require('../../../task_agent/task');
var execFile = require('child_process').execFile;

var Sleep = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(Sleep);

Sleep.setStart(start);

function start(callback) {
    var self = this;
    var params = self.req.params;

    var random = Math.floor((Math.random() * 1000)%1000);
    var subTaskParams = {random:random};
    subTaskParams.sleep = params.sleep;

    var cb = function (error) {
        console.dir(arguments);
        self.finish();
    };

    self.subTask(
        'provisioner-v2',
        'nop',
        subTaskParams,
        cb);
}
