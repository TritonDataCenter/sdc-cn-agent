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
var VM  = require('/usr/vm/node_modules/VM');
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

    var binfn = __dirname + '/../../bin/docker-exec.js';

    var opts = {};
    var dockerExec = fork(binfn, [], opts);
    var command = self.req.params.command;

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

        dockerExec.send({
            command: command,
            uuid: self.req.params.uuid
        });

        dockerExec.on('message', once(function (message) {
            if (command.Detach) {
                self.finish();
                return;
            } else {
                self.finish({
                    host: adminIp,
                    port: message.port,
                });
            }
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
