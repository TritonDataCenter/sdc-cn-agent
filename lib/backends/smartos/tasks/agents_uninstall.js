/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * This task uninstalls the named Triton agents on this server.
 */

var assert = require('assert-plus');
var VError = require('verror');
var vasync = require('vasync');

var APM = require('../../../apm').APM;
var refreshAgents = require('./shared').refreshAgents;
var Task = require('../../../task_agent/task');


function AgentsUninstallTask(req) {
    Task.call(this);
    this.req = req;
}

Task.createTask(AgentsUninstallTask);

function start() {
    var self = this;
    var apm = new APM({log: self.log});
    var log = self.log;
    var agents = self.req.params.agents;

    assert.arrayOfString(agents, 'params.agents');

    // `apm.uninstallPackages` logs errors as they happen.
    apm.uninstallPackages(agents, function onUninstalled(uninstallErr) {
        self.progress(90);

        // An error might indicate that *some* `agents` could not be installed.
        // Therefore we still want to refresh agent info in CNAPI.
        refreshAgents({log: log}, function onRefreshed(refreshErr) {
            if (refreshErr) {
                log.error(refreshErr, 'Error refreshing agent info in CNAPI');
            } else {
                log.info('Refreshed agent info in CNAPI');
            }

            // Current cn-agent task error reporting will only look at
            // `err.message`. For a more complete error message, we will
            // build up the messages from all relevant errors here.
            var errMsgs = [];
            if (uninstallErr) {
                VError.errorForEach(uninstallErr,
                    function pushMsg(e) { errMsgs.push(e.message); });
            }
            if (refreshErr) {
                errMsgs.push('Error refreshing agent info in CNAPI: '
                    + refreshErr.message);
            }

            if (errMsgs.length > 0) {
                self.fatal('AgentsUninstallTask error: ' + errMsgs.join('; '));
            } else {
                self.finish();
            }
        });
    });
}

AgentsUninstallTask.setStart(start);

module.exports = AgentsUninstallTask;
