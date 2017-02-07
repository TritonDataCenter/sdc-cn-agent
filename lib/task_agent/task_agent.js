/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var util = require('util');
var format = util.format;
var path = require('path');
var common = require('./common');
var TaskRunner = require('./task_runner');
var imgadm = require('../imgadm');
var bunyan = require('bunyan');
var restify = require('restify');
var os = require('os');
var async = require('async');
var EventEmitter = require('events').EventEmitter;
var cp = require('child_process');
var execFile = cp.execFile;
var assert = require('assert-plus');

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function TaskAgent(opts) {
    EventEmitter.call(this);
    assert.string(opts.tasklogdir, 'opts.tasklogdir');
    assert.string(opts.uuid, 'opts.uuid');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.taskspath, 'opts.taskspath');
    assert.object(opts.agentserver, 'opts.agentserver');
    assert.optionalObject(opts.env, 'opts.env');

    this.tasklogdir = opts.tasklogdir;
    this.taskspath = opts.taskspath;

    this.log = bunyan.createLogger({ name: opts.logname });
    opts.log = this.log;

    this.agentserver = opts.agentserver;
    this.env = opts.env || {};

    if (opts.taskspath) {
        this.taskspath = opts.taskspath;
    } else {
        this.log.warn(
            'Warning: no taskPaths specified when instantiating TaskAgent');
        this.taskspath = path.join(__dirname, '..', 'tasks');
    }
    this.uuid = opts.uuid;
    this.runner = new TaskRunner({
        log: this.log,
        logdir: this.tasklogdir,
        taskspath: this.taskspath,
        env: this.env
    });
}

util.inherits(TaskAgent, EventEmitter);

TaskAgent.prototype.start = function () {
    var self = this;
    self.setupTaskRoutes(self.queueDefns);
    self.setupTaskHistory();
};


TaskAgent.prototype.setupTaskRoutes = function (defns) {
    var self = this;

    self.log.info('setting up task route for %s', self.uuid);
    this.agentserver.registerTaskHandler(self.uuid, handler);

    function handler(req, res, next) {
        if (!req.params.hasOwnProperty('task')) {
            next(new restify.InvalidArgumentError(
                'Missing key \'task\''));
            return;
        }

        if (!req.params.hasOwnProperty('params')) {
            next(new restify.InvalidArgumentError(
                'Missing key \'params\''));
            return;
        }

        var dispatch = {};
        var taskName = req.params.task;
        var logParams = true;

        self.queueDefns.forEach(function (i) {
            i.tasks.forEach(function (j) {
                if (j === taskName && i.log_params === false) {
                    logParams = false;
                }

                dispatch[j] = i.onhttpmsg;
            });
        });

        if (logParams) {
            req.log.info({ task: req.params }, '%s task params', taskName);
        } else {
            req.log.info(
                'not logging task params for %s (log_params=false)', taskName);
        }

        var value, error;

        var cbcount = 0;
        function fcb() {
            cbcount++;

            if (cbcount === 2) {
                if (error) {
                    res.send(500, error);
                    next();
                    return;
                }
                res.send(200, value);
                next();
            }
        }

        var params = {
            req_id: req.getId(),
            req_host: req.headers.host,
            task: req.params.task,
            params: req.params.params,
            finish: function () {
                fcb();
            },
            progress: function (v) {
            },
            event: function (name, message) {
                self.log.trace(
                    { name: name, message: message }, 'Received event');
                if (name === 'finish') {
                    value = message;
                    fcb();
                } else if (name === 'error') {
                    error = message;
                }
            }
        };

        // NEED TO CALL DISPATCH FN WITH A "REQ" OBJECT
        var taskfn = dispatch[req.params.task];
        if (taskfn) {
            dispatch[req.params.task](params);
        } else {
            next(new restify.ResourceNotFoundError(
                'Unknown task, \'%s\'', req.params.task));
        }
    }
};


TaskAgent.prototype.useQueues = function (defns) {
    var self = this;
    self.queueDefns = defns;
};


TaskAgent.prototype.setupTaskHistory = function () {
    var self = this;
    self.agentserver.setTaskHistory(self.runner.taskHistory);
};


module.exports = TaskAgent;
