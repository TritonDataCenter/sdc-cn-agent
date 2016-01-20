/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var util = require('util');
var TaskAgent = require('../lib/task_agent/task_agent');
var fs = require('fs');
var path = require('path');
var dispatch = require('../lib/task_agent/dispatch');
var createTaskDispatchFn = dispatch.createTaskDispatchFn;
var createHttpTaskDispatchFn = dispatch.createHttpTaskDispatchFn;
var os = require('os');
var exec = require('child_process').exec;
var tty = require('tty');
var once = require('once');
var bunyan = require('bunyan');
var AgentHttpServer = require('../lib/server');
var App = require('../lib/app');

main();

function main() {
    var logname = 'cn-agent';
    var smartdcconfig = require('../lib/smartdc-config');

    var log = bunyan.createLogger({ name: logname });


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
        smartdcconfig.sysinfo(function (err, sysinfo) {
            if (err) {
                throw err;
            }

            var ip = firstAdminIp(sysinfo);

            var agentServer = new AgentHttpServer({
                bindip: ip,
                log: log,
                uuid: sysinfo.UUID
            });
            agentServer.start();

            var options = {
                uuid: sysinfo.UUID,
                log: log,
                tasklogdir: '/var/log/' + logname + '/logs',
                logname: logname,
                taskspath: path.join(__dirname, '..', 'lib/tasks'),
                agentserver: agentServer
            };

            var app = new App(options);

            // EXPERIMENTAL
            if (agentConfig.fluentd_host) {
                process.env.FLUENTD_HOST = agentConfig.fluentd_host;
            }

            app.start();
        });

    } else {
        log.warn('"no_rabbit" flag is not true, cn-agent will now sleep');
        // http://nodejs.org/docs/latest/api/all.html#all_settimeout_cb_ms
        // ...The timeout must be in the range of 1-2,147,483,647 inclusive...
        setInterval(function () {}, 2000000000);
    }
}

function firstAdminIp(sysinfo) {
    var interfaces;

    interfaces = sysinfo['Network Interfaces'];

    for (var iface in interfaces) {
        if (!interfaces.hasOwnProperty(iface)) {
            continue;
        }

        var nic = interfaces[iface]['NIC Names'];
        var isAdmin = nic.indexOf('admin') !== -1;
        if (isAdmin) {
            var ip = interfaces[iface].ip4addr;
            return ip;
        }
    }

    throw new Error('No NICs with name "admin" detected.');
}
