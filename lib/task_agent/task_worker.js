/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var path = require('path');
var sprintf = require('sprintf').sprintf;
var taskModule = process.argv[2];
var TaskClass = require(taskModule + '.js');
var tritonTracer = require('triton-tracer');

var logOpts = {
    name: taskModule,
    req_id: process.env.req_id
};

var logname = sprintf(
        '%s-%s-%s.log',
        process.env.logtimestamp,
        process.pid,
        process.env.task);

var span;
var spanCtx;
var spanLog;

// These were stringified when coming through the environment, we've got to fix
// them back up to their former glory.
function fixString(str) {
    if (str === 'undefined') {
        return undefined;
    } else if (str === 'true') {
        return true;
    } else if (str === 'false') {
        return false;
    }
    return str;
}

if (process.env.hasOwnProperty('tritontracer_trace_id')) {
    spanCtx = {
        _traceId: process.env.tritontracer_trace_id
    };

    if (process.env.hasOwnProperty('tritontracer_enabled')) {
        spanCtx._traceEnabled = fixString(process.env.tritontracer_enabled);
    }

    if (process.env.hasOwnProperty('tritontracer_extra')) {
        spanCtx._traceExtra = fixString(process.env.tritontracer_extra);
    }

    if (process.env.hasOwnProperty('tritontracer_span_id')) {
        spanCtx._spanId = process.env.tritontracer_span_id;
    }

    assert.optionalBool(spanCtx._traceEnabled, 'spanCtx._traceEnabled');
    assert.optionalBool(spanCtx._traceExtra, 'spanCtx._traceExtra');
    assert.optionalUuid(spanCtx._spanId, 'spanCtx._spanId');
    assert.uuid(spanCtx._traceId, 'spanCtx._traceId');

    spanLog = bunyan.createLogger({
        name: 'cn-agent-worker',
        level: 'debug'
    });

    // Init tracing now that we have a logger
    tritonTracer.init({
        log: spanLog
    });

    span = tritonTracer.tracer().startSpan(path.basename(taskModule), {
        childOf: spanCtx
    });
    span.log({event: 'local-begin'});

    // spanLog.error({span: spanCtx}, 'IM IN YOUR THING BREAKING YOUR STUFF');
}

if (process.env.logging !== '0') {
    logOpts.streams = [
        {
            path: process.env.logdir + '/' + logname,
            level: 'debug'
        }
    ];
} else {
    console.log('Not logging ' + process.env.logging);
}

var log = bunyan.createLogger(logOpts);
var isString = function (obj) {
    return Object.prototype.toString.call(obj) === '[object String]';
};

// XXX log.begin(process.env.task);

log.debug('Child ready to start, sending ready event to parent');
process.send({ type: 'ready' });

function finishSpan(err, reason) {
    if (span) {
        span.addTags({
            error: err ? true : undefined,
            errorCode: err ? err.code : undefined,
            errorMsg: err ? err.message : undefined,
            reason: err ? undefined : reason
        });
        span.log({event: 'local-end'});
        span.finish();
    }
}

process.on('SIGTERM', function () {
    // XXX log.end(process.env.task);
    finishSpan(null, 'SIGTERM');
    log.info('Task processes terminated. Exiting.');
    process.exit(0);
});

process.on('uncaughtException', function (err) {
    process.send({ type: 'exception', error: {
            message: err.message,
            stack: err.stack
        }
    });
    err.code = err.code || 'uncaughtException';
    finishSpan(err);
    // XXX log.end(process.env.task);
    log.error('Uncaught exception in task child process: ');
    log.error(err.message);
    log.error(err);
    process.exit(1);
});


process.on('message', function (msg) {
    log.debug('Child received hydracp message from parent:');
    log.debug(msg);
    switch (msg.action) {
        case 'start':
            start(msg.req, msg.taskspath);
            break;
        case 'subtask':
            var fn = task.subTaskCallbacks[msg.id];
            fn.apply(task, [msg.name, msg.event]);
            break;
        default:
            log.warn('Unknown task action, %s', msg.action);
            break;
    }
});

var task;

function start(req, taskspath) {
    log.info({
        task_id: req.params.task_id,
        client_id: req.params.client_id
    }, 'Instantiating ' + taskModule);

    if (span) {
        span.addTags({
            // task name?
            client_id: req.params.client_id,
            task_id: req.params.task_id
        });
    }

    task = new TaskClass(req);

    // add the span to the task so it can be used in the task bodies
    if (span) {
        task.setSpan(span);
    }
    tritonTracer.cls().bindEmitter(task);

    task.req = req;
    task.taskspath = taskspath;
    task.sysinfo = req.sysinfo;

    task.on('event', function (name, event) {
        log.info({
            event: event
        }, 'Received event (%s) from task instance', name);
        process.send({ type: 'event', name: name, event: event });
    });

    task.on('log', function (entry) {
        log[entry.level].apply(log, entry.message);
    });

    task.on('subtask', function (event) {
        log.info('Received a subtask event from task instance:');
        log.debug(event);
        process.send({
            type: 'subtask',
            resource: event.resource,
            task: event.task,
            msg: event.msg,
            id: event.id
        });
    });

    task.start();
}
