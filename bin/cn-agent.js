#!/usr/node/bin/node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var TaskAgent = require('../lib/task_agent/task_agent');
var fs = require('fs');
var path = require('path');
var createTaskDispatchFn = require('../lib/task_agent/dispatch').createTaskDispatchFn;
var createHttpTaskDispatchFn = require('../lib/task_agent/dispatch').createHttpTaskDispatchFn;
var os = require('os');
var exec = require('child_process').exec;
var tty = require('tty');
var once = require('once');
var bunyan = require('bunyan');

var App = require('../lib/app');

var logname = 'cn-agent';

var log = bunyan.createLogger({ name: logname });

var options = {
    log: log,
    tasklogdir: '/var/log/' + logname + '/logs',
    logname: logname,
    tasksPath: path.join(__dirname, '..', 'lib/tasks')
};

// The plan is to migrate to using this file as the entire configuration
// needed for the cn-agent. For now we rely on the presence of this file
// to detect if we are intending to run the agent, which is why no_rabbit
// is false by default
var agentConfigPath = '/opt/smartdc/agents/etc/cn-agent.config.json';
var agentConfig;

try {
    agentConfig = JSON.parse(fs.readFileSync(agentConfigPath, 'utf-8'));
} catch (e) {
    log.error(e, 'Could not parse agent config: "%s", '
        + 'setting no_rabbit flag to false', e.message);
    agentConfig = { no_rabbit: false };
}

if (agentConfig.no_rabbit) {
    var app = new App(options);

    // EXPERIMENTAL
    if (agentConfig.fluentd_host) {
        process.env.FLUENTD_HOST = agentConfig.fluentd_host;
    }

    app.start();
} else {
    log.warn('"no_rabbit" flag is not true, cn-agent will now sleep');
    // http://nodejs.org/docs/latest/api/all.html#all_settimeout_cb_ms
    // ...The timeout must be in the range of 1-2,147,483,647 inclusive...
    setInterval(function () {}, 2000000000);
}
