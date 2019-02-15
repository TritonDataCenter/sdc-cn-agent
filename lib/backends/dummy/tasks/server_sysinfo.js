/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

var common = require('../common');
var SysinfoGetter = require('../lib/sysinfo');
var Task = require('../../../task_agent/task');

var ServerSysinfoTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(ServerSysinfoTask);

function start(callback) {
    var self = this;

    assert.object(self.req, 'self.req');
    assert.object(self.req.sysinfo, 'self.req.sysinfo');
    assert.object(self.req.serverAddress, 'self.req.serverAddress');

    var serverRoot = common.SERVER_ROOT;

    (new SysinfoGetter()).get({
        serverAddress: self.req.serverAddress,
        serverUuid: self.req.sysinfo.UUID
    }, function _onSysinfo(err, sysinfoObj) {
        if (err) {
            self.fatal({error: err});
            return;
        }

        self.finish({
            sysinfo: sysinfoObj
        });
    });
}

ServerSysinfoTask.setStart(start);
