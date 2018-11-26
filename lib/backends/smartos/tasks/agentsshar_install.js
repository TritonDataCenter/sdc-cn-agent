/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018 Joyent, Inc.
 */

/*
 *
 */

var assert = require('assert-plus');

var refreshAgents = require('./shared').refreshAgents;
var smartdc_config = require('../smartdc-config');
var Task = require('../../../task_agent/task');

function AgentsSharInstallTask(req) {
    Task.call(this);
    this.req = req;
}

Task.createTask(AgentsSharInstallTask);

function start() {
    var self = this;

    assert.object(self.log, 'self.log');
    assert.object(self.req, 'self.req');
    assert.string(self.req.req_id, 'self.req.req_id');
    assert.object(self.req.params, 'self.req.params');
    assert.string(self.req.params.shar, 'self.req.params.shar');
    assert.object(self.sysinfo, 'self.sysinfo');
    assert.uuid(self.sysinfo.UUID, 'self.sysinfo.UUID');

    self.log.warn({
        server_uuid: self.sysinfo.UUID,
        shar: self.req.params.shar
    }, 'would try to install agentsshar');

    self.progress(100);
    return self.finish();
}

AgentsSharInstallTask.setStart(start);

module.exports = AgentsSharInstallTask;
