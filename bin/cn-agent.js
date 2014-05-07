#!/usr/node/bin/node

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
