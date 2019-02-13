/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * This task uninstalls the named Triton agents on this mock server.
 *
 * Params:
 * - 'agents' - An array of agent names to remove.
 *
 * This task will:
 * - remove SERVER_ROOT/<server_uuid>/agents/<agent> for each named agent
 * - refresh CNAPI's view of the agents
 */

var path = require('path');

var assert = require('assert-plus');
var rimraf = require('rimraf');
var vasync = require('vasync');

var common = require('../common');
var shared = require('./shared');
var Task = require('../../../task_agent/task');

function AgentsUninstallTask(req) {
    Task.call(this);
    this.req = req;
}

Task.createTask(AgentsUninstallTask);

function start() {
    var self = this;

    assert.arrayOfString(self.req.params.agents, 'self.req.params.agents');
    assert.object(self.sysinfo, 'self.sysinfo');
    assert.uuid(self.sysinfo.UUID, 'self.sysinfo.UUID');

    var agents = self.req.params.agents;
    var agentsDir = path.join(common.SERVER_ROOT, self.sysinfo.UUID, 'agents');

    vasync.forEachPipeline({
        inputs: agents,
        func: function rmOneAgent(agent, nextAgent) {
            var agentDir = path.join(agentsDir, agent);
            rimraf(agentDir, nextAgent);
        }
    }, function onRemoved(rmErr) {
        if (rmErr) {
            self.fatal('AgentsUninstallTask error: ' + rmErr.message);
            return;
        }

        shared.refreshAgents({
            log: self.log,
            serverUuid: self.sysinfo.UUID
        }, function (refreshErr) {
            if (refreshErr) {
                self.fatal('AgentsUninstallTask error: ' + refreshErr.message);
            } else {
                self.finish();
            }
        });
    });
}

AgentsUninstallTask.setStart(start);

module.exports = AgentsUninstallTask;
