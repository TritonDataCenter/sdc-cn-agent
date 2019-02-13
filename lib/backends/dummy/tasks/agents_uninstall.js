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
var VError = require('verror');

var common = require('../common');
var shared = require('./shared');
var Task = require('../../../task_agent/task');

// These constants can be manually tweaked for development to have this task
// randomly be slow or fail.
//
// - Set `DEV_DELAY_MAX_MS` to a maximum number of milliseconds to delay
//   the execution of removing the agents. The actual delay is a randomized
//   value up to this maximum
// - Set `DEV_FAIL_RATE` to a value between 0.0 and 1.0 for a probability that
//   this task executation will fail.
const DEV_DELAY_MAX_MS = 0;
const DEV_FAIL_RATE = 0;

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

    vasync.pipeline({funcs: [
        function handleDevDelay(_, next) {
            if (DEV_DELAY_MAX_MS) {
                var delay = Math.random() * DEV_DELAY_MAX_MS;
                setTimeout(next, delay);
            } else {
                next();
            }
        },

        function handleDevFail(_, next) {
            if (DEV_FAIL_RATE && Math.random() < DEV_FAIL_RATE) {
                next(new VError('random dev failure (DEV_FAIL_RATE=%f)',
                    DEV_FAIL_RATE));
            } else {
                next();
            }
        },

        function rmAgentDirs(_, next) {
            vasync.forEachPipeline({
                inputs: agents,
                func: function rmOneAgent(agent, nextAgent) {
                    var agentDir = path.join(agentsDir, agent);
                    rimraf(agentDir, nextAgent);
                }
            }, next);
        },

        function refreshTheAgentsInCnapi(_, next) {
            shared.refreshAgents({
                log: self.log,
                serverUuid: self.sysinfo.UUID
            }, next);
        }
    ]}, function finish(err) {
        if (err) {
            self.fatal('AgentsUninstallTask error: ' + err.message);
        } else {
            self.finish();
        }
    });
}

AgentsUninstallTask.setStart(start);

module.exports = AgentsUninstallTask;
