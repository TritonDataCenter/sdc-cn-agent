/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

var Task = require('../../../task_agent/task');
var fork = require('child_process').fork;
var once = require('once');


/**
 * Build task.
 */
var DockerBuildTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(DockerBuildTask);

DockerBuildTask.setStart(start);

function start(callback) {
    var self = this;

    self.log.debug('Starting docker-build.js child process');
    var binfn = __dirname + '/../bin/docker-build.js';
    var opts = { silent: true };
    var payload = self.req.params.payload;

    var dockerBuild = fork(binfn, [], opts);

    dockerBuild.on('message', once(function (message) {
        if (message.error) {
            self.fatal(message.error.message);
            return;
        }
        self.log.debug('Got response:', message);
        self.finish({
            host: message.host,
            port: message.port
        });
    }));

    dockerBuild.stdout.on('data', function (buf) {
        self.log.warn('docker-build.js stdout: ' + String(buf));
    });

    dockerBuild.stderr.on('data', function (buf) {
        self.log.warn('docker-build.js stderr: ' + String(buf));
    });

    dockerBuild.on('exit', function (code, signal) {
        self.log.error('docker-build.js exit: ' + code + ', signal: ' + signal);
    });

    dockerBuild.on('disconnect', function () {
        self.log.error('docker-build.js disconnect');
    });

    dockerBuild.on('error', function (err) {
        self.log.error('docker-build.js error: ' + err);
    });

    dockerBuild.send({
        logname: self.log.name,
        payload: payload,
        req_id: self.req.req_id,
        uuid: self.req.params.uuid
    });

    self.log.debug('Waiting for child process to message back');
}
