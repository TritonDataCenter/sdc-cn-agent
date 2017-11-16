/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 *
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var events = require('events');
var pty = require('pty.js');
var restify = require('restify');
var util = require('util');
var vasync = require('vasync');
var watershed = require('watershed');

// --- Globals

var WATERSHED = new watershed.Watershed();

// --- Internals

function NullShed() {
    events.EventEmitter.call(this);
}
util.inherits(NullShed, events.EventEmitter);


function spawnChild(opts) {
    var cmd = '/usr/sbin/zlogin';
    var args = [ '-dCQ', opts.uuid ];

    return pty.spawn(cmd, args);
}

function spawnProcess(opts, shed) {
    var log = opts.log;
    var child = spawnChild(opts);

    child.on('data', function (buf) {
        shed.send(new Buffer(buf));
    });

    child.on('exit', function (code, signal) {
        shed.send(JSON.stringify({
            event: 'exited',
            code: code,
            signal: signal || null
        }));
        shed.end('process exited');
    });

    shed.once('error', function (err) {
        child.end();
    });

    shed.once('connectionReset', function (err) {
        log.error('connection reset');
        child.end();
    });

    shed.once('end', function (reason) {
        log.info({
            reason: reason
        }, 'connection ended');
        child.end();
    });

    shed.on('text', function (msg) {
        var obj;

        try {
            obj = JSON.parse(msg);
        } catch (e) {
            log.error({
                err: e,
                msg: msg
            }, 'failed to parse incoming message');
            return;
        }

        if (obj === null || typeof (obj) !== 'object') {
            log.error({ obj: obj },
                'expected incoming message to be an object');
            return;
        }

        log.error({ obj: obj }, 'received message');

        switch (obj.event) {
        case 'resize':
            if (typeof (obj.height) === 'number' &&
                typeof (obj.width) === 'number') {
                child.resize(obj.width, obj.height);
            }
            break;
        default:
            log.warn({ obj: obj },
                'received unrecognized event type: %j', obj.event);
            break;
        }
    });

    shed.on('binary', function (buf) {
        child.write(buf);
    });
}

// --- Exports

function createZoneExecutorServer(opts) {
    assert.object(opts.log, 'opts.log');
    var log = opts.log;

    var server = restify.createServer({
        log: log,
        name: 'Zone Executor Server',
        version: '1.0.0',
        handleUncaughtExceptions: false,
        handleUpgrades: true
    });

    server.use(restify.acceptParser(server.acceptable));
    server.use(restify.queryParser());
    server.use(restify.bodyParser({ 'mapParams': false }));

    server.on('after', restify.auditLogger({
        log: log.child({ component: 'AuditLog' })
    }));

    server.get('/test', function (req, res, next) {
        log.debug('in test endpoint');
        res.send('hello world\n');
    });

    server.get('/attach', doUpgrade);

    function doUpgrade(req, res, next) {
        var upgrade, shed;

        upgrade = res.claimUpgrade();
        upgrade.socket.setNoDelay(true);

        try {
            shed = WATERSHED.accept(req, upgrade.socket, upgrade.head);
        } catch (e) {
            log.error(e, 'websocket upgrade failed');
            res.send(500, e);
            return;
        }

        spawnProcess(opts, shed);

        next(false);
    }

    server.listen(8080);

    return server;
}


function setupTritonExecution(opts, callback) {
    assert.object(opts, 'opts');

    var command = opts.command;

    opts.log = bunyan.createLogger({
        name: 'zone-executor',
        req_id: opts.req_id,
        level: 'debug'
    });

    if (command.detached) {
        spawnProcess(opts, new NullShed());
        callback(null, {});
        return;
    }

    opts.log.info('starting');

    var server = createZoneExecutorServer(opts);

    callback(null, {
        port: server.address().port
    });
}


module.exports = {
    setupTritonExecution: setupTritonExecution
};
