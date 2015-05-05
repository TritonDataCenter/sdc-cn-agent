/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
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

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

    self.setupImageRoutes();

    var port = process.env.PORT ? process.env.PORT : 5309;
    self.httpserver.listen(port, function () {
        self.log.info(
            '%s listening at %s', self.httpserver.name, self.httpserver.url);
    });
};

TaskAgent.prototype.setupImageRoutes = function () {
    var self = this;
    var server = self.httpserver;

    /**
     * Ensure the 'uuid' request param is valid, else this is a 404.
     */
    function reqValidUuid(req, res, next) {
        var uuid = req.params.uuid;
        if (!UUID_RE.test(uuid)) {
            var message = req.url + ' does not exist';
            return next(
                new restify.ResourceNotFoundError(format('%s', message)));
        }
        return next();
    }

    function getImage(req, res, next) {
        imgadm.getImage({
            log: self.log,
            uuid: req.params.uuid
        }, function (err, image) {
            if (err) {
                return next(
                    new restify.ResourceNotFoundError(err.message));
            }

            req.image = image;
            return next();
        });
    }

    function sendImageManifest(req, res, next) {
        res.send(req.image);
        return next();
    }

    function getImageFile(req, res, next) {
        res.header('Content-Type', 'application/octet-stream');
        // Cleanup snapshot if it was created at all
        var snapshot = false;
        var snapName = format('cn-agent-send-%s', req.getId());

        function snapshotImage(cb) {
            imgadm.snapshotImage({
                log: self.log,
                name: snapName,
                uuid: req.params.uuid
            }, cb);
        }

        function sendImage(cb) {
            snapshot = true;

            imgadm.sendImage({
                log: self.log,
                name: snapName,
                stream: res,
                uuid: req.params.uuid
            }, cb);
        }

        // 'zfs destroy' is not exposed in lib/imgadm.js for security reasons
        function deleteSnapshot(cb) {
            var fullSnapName = format('zones/%s@%s', req.params.uuid, snapName);
            var argv = ['/usr/sbin/zfs', 'destroy', fullSnapName];

            self.log.info('calling: ' + argv.join(' '));

            execFile(argv[0], argv.slice(1), function (err, stdout, stderr) {
                if (err) {
                    cb(new Error(format(
                        'Error destroying snapshot %s: %s', fullSnapName,
                        stderr.trim())));
                    return;
                }

                cb(null);
            });
        }

        // Can't send a response body at this point if were streaming
        // the image data back
        function finish(anError) {
            if (anError) {
                res.statusCode = 500;
                self.log.error(anError, 'error getting image file');
                res.end();
            }
            next();
        }

        function cleanup(err) {
            if (err || !snapshot) {
                finish(err);
                return;
            }

            deleteSnapshot(function (deleteEr) {
                finish(deleteEr);
                return;
            });
        }

        async.series([
            snapshotImage,
            sendImage
        ], cleanup);
    }

    server.use(function (req, res, next) {
        console.log(req);
        next();
    });

    /**
     * Retrieves an imgadm image manifest
     */
    server.get({
        path: '/images/:uuid',
        version: '2.0.0'
    }, reqValidUuid, getImage, sendImageManifest);

    /**
     * Retrieves an imgadm image file
     */
    server.get({
        path: '/images/:uuid/file',
        version: '2.0.0'
    }, reqValidUuid, getImage, getImageFile);
};


TaskAgent.prototype.useQueues = function (defns) {
    var self = this;
    self.queueDefns = defns;
};


module.exports = TaskAgent;
