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

var app = new App(options);
app.start();
