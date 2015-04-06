/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var util = require('util');
var path = require('path');
var common = require('./common');
var TaskRunner = require('./task_runner');
var bunyan = require('bunyan');
var restify = require('restify');
var os = require('os');
var async = require('async');
var EventEmitter = require('events').EventEmitter;

function TaskAgent(config) {
    EventEmitter.call(this);

    this.tasklogdir = config.tasklogdir;
    this.log = bunyan.createLogger({ name: config.logname });
    config.log = this.log;

    if (config.tasksPath) {
        this.tasksPath = config.tasksPath;
    } else {
        this.log.warn(
            'Warning: no taskPaths specified when instantiating TaskAgent');
        this.tasksPath = path.join(__dirname, '..', 'tasks');
    }
    this.runner = new TaskRunner({
        log: this.log,
        logdir: this.tasklogdir,
        tasksPath: this.tasksPath
    });
}

util.inherits(TaskAgent, EventEmitter);

TaskAgent.prototype.start = function () {
    this.startHttpService();
};

TaskAgent.prototype.startHttpService = function (defns) {
    var self = this;

    var server = self.httpserver = restify.createServer({
        log: this.log,
        name: 'Compute Node Agent'
    });

    server.use(function (req, res, next) {
        // Time requests out after an hour
        req.connection.setTimeout(3600 * 1000);
        res.connection.setTimeout(3600 * 1000);
        next();
    });

    server.use(restify.requestLogger());
    server.use(restify.acceptParser(server.acceptable));
    server.use(restify.authorizationParser());
    server.use(restify.queryParser());
    server.use(restify.bodyParser());

    server.on('after', function auditReq(req, res, route, err) {
        var method = req.method;
        var reqpath = req.path();
        if (method === 'GET' || method === 'HEAD') {
            if (reqpath === '/ping') {
                return;
            }
        }
        // Successful GET res bodies are uninteresting and *big*.
        var body = method !== 'GET' &&
                   res.statusCode !== 404 &&
                   Math.floor(res.statusCode/100) !== 2;

        restify.auditLogger({
            log: req.log.child({ route: route && route.name }, true),
            body: body
        })(req, res, route, err);
    });

    server.use(function addHeaders(req, res, next) {
        res.on('header', function onHeader() {
            var now = Date.now();
            res.header('Date', new Date());
            res.header('Server', server.name);
            res.header('x-request-id', req.getId());
            var t = now - req.time();
            res.header('x-response-time', t);
            res.header('x-server-name', os.hostname());
        });
        next();
    });

    server.on('uncaughtException', function (req, res, route, err) {
        req.log.error(err);
        res.send(err);
    });

    // Need a proper "model" in which to track the administrative details of
    // executing taks (status, progress, history, etc).

    server.post('/tasks', function createTask(req, res, next) {
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

        self.queueDefns.forEach(function (i) {
            i.tasks.forEach(function (j) {
                dispatch[j] = i.onhttpmsg;
            });
        });

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
    });

    server.get('/tasks', function listTasks(req, res, next) {
        var opts = {};

        if (req.params.status) {
            opts.status = req.params.status;
        }
        var history = getHistory(opts);
        res.send(200, history);
        next();
    });

    function getHistory(opts) {
        var history = self.runner.taskHistory;
        var i;

        for (i = history.length; i--; ) {
            var entry = history[i];
            if (opts.status && opts.status !== entry.status) {
                continue;
            }
            var started_at = new Date(entry.started_at);
            var finished_at = entry.finished_at
                ? new Date(entry.finished_at)
                : new Date();
            entry.elapsed_seconds = (finished_at - started_at) / 1000;
        }

        return history;
    }

    server.get('/history', function (req, res, next) {
        var history = self.runner.taskHistory;
        var i;

        for (i = history.length; i--; ) {
            var entry = history[i];
            if (entry.status !== 'active') {
                continue;
            }
            var started_at = new Date(entry.started_at);
            var finished_at = entry.finished_at
                ? new Date(entry.finished_at)
                : new Date();
            entry.elapsed_seconds = (finished_at - started_at) / 1000;
        }

        res.send(200, history);
        next();
    });

    var port = process.env.PORT ? process.env.PORT : 5309;
    self.httpserver.listen(port, function () {
        self.log.info(
            '%s listening at %s', self.httpserver.name, self.httpserver.url);
    });
};


TaskAgent.prototype.useQueues = function (defns) {
    var self = this;
    self.queueDefns = defns;
};


module.exports = TaskAgent;
