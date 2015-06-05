/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var Task = require('../task_agent/task');
var sysinfo = require('../task_agent/smartdc-config').sysinfo;
var common = require('../common');
var fork = require('child_process').fork;
var once = require('once');
var util = require('util');


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

    sysinfo(function (err, sysinfoObj) {
        if (err) {
            self.fatal({ error: err });
            return;
        }

        var adminIp = firstAdminIp(sysinfoObj);

        if (!adminIp) {
            self.fatal({ error: 'No admin NIC found in compute node sysinfo' });
            return;
        }

        dockerCopy.send({
            req_id: self.req.req_id,
            payload: payload,
            uuid: self.req.params.uuid
        });

        dockerCopy.on('message', once(function (message) {
            if (message.error) {
                self.fatal(message.error.message);
                return;
            }
            self.finish({
                host: adminIp,
                port: message.port
            });
        }));
    });
}


function firstAdminIp(sysinfoObj) {
    var interfaces = sysinfoObj['Network Interfaces'];

    var adminifaces = Object.keys(interfaces).filter(function (iface) {
        return interfaces[iface]['NIC Names'].indexOf('admin') !== -1;
    });

    if (adminifaces && adminifaces.length) {
        return interfaces[adminifaces[0]]['ip4addr'];
    } else {
        return null;
    }
}
