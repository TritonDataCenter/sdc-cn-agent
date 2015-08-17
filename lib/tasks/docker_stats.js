/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var Task = require('../task_agent/task');
var fork = require('child_process').fork;
var once = require('once');


/**
 * Stats task.
 */
var DockerStatsTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(DockerStatsTask);

DockerStatsTask.setStart(start);

function start(callback) {
    var self = this;

    var binfn = __dirname + '/../../bin/docker-stats.js';

    var opts = {};
    var dockerStats = fork(binfn, [], opts);
    var payload = self.req.params.payload;

    dockerStats.send({
        logname: self.log.name,
        payload: payload,
        req_id: self.req.req_id,
        uuid: self.req.params.uuid
    });

    dockerStats.on('message', once(function (message) {
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
}
