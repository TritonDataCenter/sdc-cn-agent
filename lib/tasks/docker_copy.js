/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var Task = require('../task_agent/task');
var common = require('../common');
var fork = require('child_process').fork;
var getFirstAdminIp = require('../task_agent/smartdc-config').getFirstAdminIp;
var once = require('once');
var util = require('util');
var vmadm = require('vmadm');


var DockerExecTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(DockerExecTask);

DockerExecTask.setStart(start);

function start(callback) {
    var self = this;

    var binfn = __dirname + '/../../bin/docker-copy.js';

    var opts = {};
    var dockerCopy = fork(binfn, [], opts);

    var payload = self.req.params.payload;
    var path = self.req.params.path;
    var mode = self.req.params.mode || 'read';

    // Work around deprecated 'payload' option
    if (!path && payload) {
        path = payload.path;
        mode = payload.mode || 'read';
    }

    opts.log = self.log;
    opts.req_id = self.req.req_id;
    opts.uuid = self.req.params.uuid;
    opts.vmadmLogger = common.makeVmadmLogger(self);

    getFirstAdminIp(function (err, adminIp) {
        if (err) {
            self.fatal({ error: err });
            return;
        }

        dockerCopy.send({
            req_id: self.req.req_id,
            uuid: self.req.params.uuid,
            admin_ip: adminIp,
            path: path,
            mode: mode,
            no_overwrite_dir: self.req.params.no_overwrite_dir
        });

        dockerCopy.on('message', once(function (message) {
            if (message.error) {
                self.fatal(
                    message.error.message,
                    { restCode: message.error.restCode });
                return;
            }
            self.finish({
                host: adminIp,
                port: message.port,
                containerPathStat: message.containerPathStat
            });
        }));
    });
}
