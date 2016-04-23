/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * The compute node agent uses the restify http server defined within
 * this file to fulfill incoming requests. One of these servers can
 * potentially front requests for multiple agents.
 *
 */

var restify = require('restify');
var EventEmitter = require('events').EventEmitter;
var os = require('os');
var util = require('util');
var assert = require('assert-plus');
var monitor = require('./monitor-agent');

function AgentHttpServer(opts) {
    var self = this;

    assert.string(opts.bindip, 'opts.bindip');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.uuid, 'opts.uuid');

    if (opts.uuid) {
        self.uuid = opts.uuid;
    }
    self.bindip = opts.bindip;
    self.log = opts.log;

    this.server = restify.createServer({
        log: opts.log,
        name: 'Compute Node Agent'
    });

    this.promServer = restify.createServer({
        log: opts.log,
        name: 'Container Monitor Hack'
    });

    this.monitorAgent = new monitor();


    self.init();
}
util.inherits(AgentHttpServer, EventEmitter);


AgentHttpServer.prototype.start = function (register) {
    var port = process.env.PORT ? process.env.PORT : 5309;
    var self = this;
    self.server.listen(port, self.bindip, function () {
        self.log.info(
            '%s listening at %s', self.server.name, self.server.url);
    });
    self.promServer.listen(8080, self.bindip, function () {
        self.log.info(
            '%s Container Monitor Hack listening at %s',
            self.promServer.name,
            self.promServer.url);
    });
};


AgentHttpServer.prototype.init = function () {
    var self = this;

    self.handleTasks = {};

    self.log.info('cn-agent binding to IP address %s', self.bindip);

    self.server.use(function (req, res, next) {
        // Time requests out after an hour
        req.connection.setTimeout(3600 * 1000);
        res.connection.setTimeout(3600 * 1000);
        next();
    });

    self.server.use(restify.requestLogger());
    self.server.use(restify.acceptParser(self.server.acceptable));
    self.server.use(restify.authorizationParser());
    self.server.use(restify.queryParser());
    self.server.use(restify.bodyParser());

    self.promServer.use(restify.requestLogger());
    self.promServer.use(restify.queryParser());
    self.promServer.use(restify.bodyParser());

    self.server.on('after', function auditReq(req, res, route, err) {
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

    self.server.use(function addHeaders(req, res, next) {
        res.on('header', function onHeader() {
            var now = Date.now();
            res.header('Date', new Date());
            res.header('Server', self.server.name);
            res.header('x-request-id', req.getId());
            var t = now - req.time();
            res.header('x-response-time', t);
            res.header('x-server-name', os.hostname());
        });
        next();
    });

    self.server.on('uncaughtException', function (req, res, route, err) {
        req.log.error(err);
        res.send(err);
    });

    self.promServer.get('/metrics', function (req, res, next) {
        self.log.warn('Metric request: %s', req);
        res.header('content-type', 'text/plain');
        res.send(self.monitorAgent.getMetrics());
    });

    self.server.post('/tasks', function (req, res, next) {
        // Should we periodically refresh the CNAPI IP address we have?
        if ([self.cnapiAddr, self.bindip].indexOf(
                req.connection.remoteAddress) === -1) {
            next(new restify.NotAuthorizedError(
                'requests must originate from CNAPI address'));
            return;
        }

        var uuid = req.headers['x-server-uuid'];


        if (!uuid) {
            uuid = self.uuid;
        }

        self.log.warn('desired uuid was %s', uuid);
        assert.string(uuid, 'uuid');

        if (!self.handleTasks.hasOwnProperty(uuid)) {
            self.log.warn('agent not hooked up for uuid %s', uuid);
            self.log.info({ handleTasks: self.handleTasks }, 'handle Tasks');

            res.send(404);
            next();
            return;
        }
        self.handleTasks[uuid](req, res, next);
        return;
    });
};

AgentHttpServer.prototype.registerTaskHandler = function (uuid, handler) {
    var self = this;
    self.log.info('registering handler for %s', uuid);
    self.handleTasks[uuid] = handler;
};


AgentHttpServer.prototype.setCnapiAddress = function (ip) {
    var self = this;
    assert.string(ip, 'ip');
    self.cnapiAddr = ip;
};

module.exports = AgentHttpServer;
