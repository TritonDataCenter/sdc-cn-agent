/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

var spawn = require('child_process').spawn;

var shared = require('./shared');
var SysinfoGetter = require('../lib/sysinfo');
var Task = require('../../../task_agent/task');

var ServerRebootTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(ServerRebootTask);

function start() {
    var self = this;

    assert.object(self.req, 'self.req');
    assert.object(self.req.sysinfo, 'self.req.sysinfo');
    assert.object(self.req.serverAddress, 'self.req.serverAddress');

    (new SysinfoGetter()).get({
        serverAddress: self.req.serverAddress,
        serverUuid: self.req.sysinfo.UUID
    }, function _onSysinfo(getErr, sysinfo) {
        if (getErr) {
            self.fatal(getErr.message);
            return;
        }

        self.progress(50);

        sysinfo['Boot Time'] = Math.floor(Date.now() / 1000);

        shared.writeSysinfo({
            log: self.log,
            serverRoot: common.SERVER_ROOT
        },
        sysinfo,
        function _onWroteSysinfo(err) {
            if (err) {
                self.fatal(err.message);
                return;
            }

            self.finish({sysinfo: sysinfo});
        });
    });
}

ServerRebootTask.setStart(start);
