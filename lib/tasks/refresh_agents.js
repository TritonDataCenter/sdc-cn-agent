/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */

/*
 * This task updates the information regarding agents installed on this CN
 * into CNAPI.
 */

var Task = require('../task_agent/task');
var refreshAgents = require('./shared').refreshAgents;

function RefreshAgentsTask(req) {
    Task.call(this);
    this.req = req;
}

Task.createTask(RefreshAgentsTask);

function start() {
    var self = this;

    // We will not fail here in case of error:
    refreshAgents({log: self.log}, function (err) {
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
