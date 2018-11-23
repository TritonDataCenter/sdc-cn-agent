/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018 Joyent, Inc.
 */

/*
 * This task updates the information regarding agents installed on this CN
 * into CNAPI.
 */

var assert = require('assert-plus');

var refreshAgents = require('./shared').refreshAgents;
var Task = require('../../../task_agent/task');

function RefreshAgentsTask(req) {
    Task.call(this);
    this.req = req;
}

Task.createTask(RefreshAgentsTask);

function start() {
    var self = this;

    assert.object(self.log, 'self.log');
    assert.object(self.sysinfo, 'self.sysinfo');
    assert.uuid(self.sysinfo.UUID, 'self.sysinfo.UUID');

    // We ignore errors here because the smartos backend does.
    refreshAgents({
        log: self.log,
        serverUuid: self.sysinfo.UUID
    }, function (err) {
        if (err) {
            self.fatal('AgentInstall error: ' + err.message);
            return;
        }
        self.log.info('Agents updated into CNAPI');

        self.progress(100);
        self.finish();
    });
}


RefreshAgentsTask.setStart(start);

module.exports = RefreshAgentsTask;
