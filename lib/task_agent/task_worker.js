/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var bunyan = require('bunyan');
var taskModule = process.argv[2];
var TaskClass = require(taskModule + '.js');
var trace_event = require('trace-event');
var sprintf = require('sprintf').sprintf;

var logOpts = {
    name: taskModule,
    req_id: process.env.req_id
};

var logname = sprintf(
        '%s-%s-%s.log',
        process.env.logtimestamp,
        process.pid,
        process.env.task);

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

process.on('SIGTERM', function () {
    // XXX log.end(process.env.task);
    log.info('Task processes terminated. Exiting.');
    process.exit(0);
});

process.on('uncaughtException', function (err) {
    process.send({ type: 'exception', error: {
            message: err.message,
            stack: err.stack
        }
    });
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
    task = new TaskClass(req);
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
