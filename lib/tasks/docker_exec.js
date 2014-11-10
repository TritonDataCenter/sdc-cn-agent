/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var Task = require('../task_agent/task');
var VM  = require('/usr/vm/node_modules/VM');
var common = require('../common');
var fork = require('child_process').fork;
var once = require('once');


var DockerExecTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(DockerExecTask);

DockerExecTask.setStart(start);

function start(callback) {
    var self = this;

    var binfn = __dirname + '/../../bin/docker-exec.js';

    var opts = {};
    var dockerRun = fork(binfn, [], opts);

    dockerRun.send({
        command: this.req.params.command,
        uuid: this.req.params.uuid
    });

    dockerRun.on('message', once(function (message) {
        self.progress(100);
        self.finish({ port: message.port });
    }));
}
