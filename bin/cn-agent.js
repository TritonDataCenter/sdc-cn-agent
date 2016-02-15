/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var bunyan = require('bunyan');
var exec = require('child_process').exec;
var fs = require('fs');
var once = require('once');
var os = require('os');
var path = require('path');
var tty = require('tty');
var util = require('util');
var vasync = require('vasync');
var verror = require('verror');

var AgentHttpServer = require('../lib/server');
var App = require('../lib/app');
var TaskAgent = require('../lib/task_agent/task_agent');
var dispatch = require('../lib/task_agent/dispatch');
var sdcconfig = require('../lib/smartdc-config');

var createHttpTaskDispatchFn = dispatch.createHttpTaskDispatchFn;
var createTaskDispatchFn = dispatch.createTaskDispatchFn;

main();

function main() {
    var logname = 'cn-agent';

    var log = bunyan.createLogger({ name: logname });
    var sysinfo;
    var sdc_config;


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

    if (!agentConfig.no_rabbit) {
        log.warn('"no_rabbit" flag is not true, cn-agent will now sleep');
        // http://nodejs.org/docs/latest/api/all.html#all_settimeout_cb_ms
        // ...The timeout must be in the range of 1-2,147,483,647 inclusive...
        setInterval(function () {}, 2000000000);
    }


    vasync.waterfall([
        function (next) {
            sdcconfig.sysinfo(function (err, sysinfoObj) {
                if (err) {
                    next(new verror.VError(err, 'fetching sysinfo'));
                    return;
                }

                sysinfo = sysinfoObj;
                next();
            });
        },
        function (next) {
            sdcconfig.sdcConfig(function (error, configObj) {
                if (error) {
                    next(new verror.VError(error, 'fetching SDC config'));
                    return;
                }
                sdc_config = configObj;
                next();
            });
        }
    ],
    function (e) {
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
            agentserver: agentServer,
            sdc_config: sdc_config
        };

        var app = new App(options);

        // EXPERIMENTAL
        if (agentConfig.fluentd_host) {
            process.env.FLUENTD_HOST = agentConfig.fluentd_host;
        }

        app.start();
    });
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
