/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * This class, TaskRunner, is responsible for starting the child process
 * (found in task_worker). It also propagates events to and from the child
 * process.
 */

var EventEmitter = require('events');
var fork = require('child_process').fork;
var fs = require('fs');
var path = require('path');
var util = require('util');

var assert = require('assert-plus');
var jsprim = require('jsprim');
var mkdirp = require('mkdirp');
var sprintf = require('sprintf').sprintf;
var tritonTracer = require('triton-tracer');


function isString(obj) {
    return Object.prototype.toString.call(obj) === '[object String]';
}


function TaskRunner(options) {
    this.backend = options.backend;
    this.children = {};
    this.env = options.env;
    this.log = options.log;
    this.logdir = options.logdir;
    this.taskHistory = [];
    this.taskspath = options.taskspath;
    this.timeoutSeconds = options.timeoutSeconds;
    this.sysinfo = options.sysinfo;

    if (!fs.existsSync(this.logdir)) {
        mkdirp.sync(this.logdir, parseInt('0755', 8));
    }
}


util.inherits(TaskRunner, EventEmitter);

var MAXIMUM_MESSAGE_STRING_LENGTH = 1000;

function cloneTruncated(obj, length) {
    var i, out;
    if (Array.isArray(obj)) {
        out = [];
        var len = obj.length;
        for (i = 0; i < len; i++) {
            out[i] = arguments.callee(obj[i], length);
        }
        return out;
    }
    if (typeof (obj) === 'object') {
        out = {};
        for (i in obj) {
            if (isString(obj) && obj.length > length) {
                out[i] = obj[i].substr(0, length);
            } else {
                out[i] = arguments.callee(obj[i], length);
            }
        }
        return out;
    }
    return obj;
}


TaskRunner.prototype.dispatch = function (req) {
    var self = this;
    var span = tritonTracer.getCurrentSpan();

    var i;
    var env = jsprim.deepCopy(process.env);
    var logtimestamp = (new Date()).getTime().toString();
    var taskModule = path.join(self.taskspath, req.task);

    if (typeof (req.logging) !== 'undefined') {
        env.logging = req.logging ? '1' : '0';
    }

    for (i in this.env) {
        env[i] = this.env[i];
    }

    env.logdir = self.logdir;
    env.logtimestamp = logtimestamp;
    env.req_id = req.req_id;
    env.task = req.task;
    env.EXPERIMENTAL_VMJS_TRACING = 'true';
    var startTime = new Date();

    self.log.info({span: span._context},
        'have a span at TaskRunner.prototype.dispatch');

    if (span) {
        env.tritontracer_enabled = span._context._traceEnabled;
        env.tritontracer_extra = span._context._traceExtra;
        env.tritontracer_trace_id = span._context._traceId;
        // we pass in *our* spanId which it should treat as parentSpanId
        env.tritontracer_span_id = span._context._spanId;
    }

    var child = fork(
        __dirname + '/task_worker.js',
        [taskModule],
        { env: env });

    var pid = child.pid;
    var timeout = setTimeout(onTimeout, self.timeoutSeconds * 1000);

    function onTimeout() {
        child.kill();

        var timeoutMsg = sprintf(
                'child task process timed out after %s seconds',
                ((new Date()) - startTime) / 1000);
        child.emit('event', 'error', { error: timeoutMsg });
        child.emit('event', 'finish', {});
        child.emit('finish');
    }

    // Reformat logname here so we can log.info 'Child logging to %s...'
    // which matches what the task_worker will generate.
    var logname = sprintf('%s-%s-%s.log', logtimestamp, pid, req.task);

    self.log.info({ logging: req.logging, req_id: req.params.req_id },
                  'Child logging to %s', env.logdir + '/' + logname);

    function logForChild(level, message) {
        message = cloneTruncated(message, MAXIMUM_MESSAGE_STRING_LENGTH);
        var firstArgs = {
            pid: pid,
            req_id: req.params.req_id
        };

        var args = [ firstArgs ];

        // Check if first argument is a string. If it's not, merge the contents
        // of first argument with the ones we have already created.
        if (Array.isArray(message) && message.length && isString(message[0])) {
            args = args.concat(message);
        } else if (Array.isArray(message) && message.length) {
            for (i in message[0]) {
                firstArgs[i] = message[0][i];
            }
            args = args.concat(message.slice(1));
        }

        self.log[level].apply(self.log, args);
    }

    function info(message) {
        var level = 'info';
        var args = [level, Array.prototype.slice.call(arguments)];
        logForChild.apply(null, args);
    }

    function debug(message) {
        var level = 'debug';
        var args = [level].concat(Array.prototype.slice.call(arguments));
        logForChild.apply(null, args);
    }

    function error(message) {
        var level = 'error';
        var args = [level].concat(Array.prototype.slice.call(arguments));
        logForChild.apply(null, args);
    }

    function warn(message) {
        var level = 'warn';
        var args = [level].concat(Array.prototype.slice.call(arguments));
        logForChild.apply(null, args);
    }

    info('Executing task module: ' + taskModule);

    var entry = {};
    this.children[pid] = child;

    var maxHistory = 16;
    this.taskHistory.push(entry);

    if (this.taskHistory.length > maxHistory) {
        this.taskHistory.splice(0, this.taskHistory.length - maxHistory);
    }

    entry.started_at = (new Date().toISOString());
    entry.task = req.task;
    entry.pid = pid;
    entry.params = req.params;
    entry.status = 'active';
    entry.errorCount = 0;
    entry.messages = [];
    entry.log = [];

    child.on('message', function (msg) {
        debug('Parent received hydracp ' + msg.type
            + ' message from child process.');
        if (msg.type !== 'log') {
            debug(msg);
        }

        msg.timestamp = new Date();

        switch (msg.type) {
            case 'ready':
                info('Received "ready" event.');
                info('Sending "start" event with payload to child.');
                child.send({
                    action: 'start',
                    req: req,
                    taskspath: self.taskspath
                });
                break;

            case 'event':
                entry.messages.push(msg);
                info('Received a task event from child task process: '
                    + msg.name);
                debug(msg.event);

                if (msg.name === 'error') {
                    entry.errorCount++;
                }

                switch (msg.name) {
                    case 'progress':
                        child.emit('progress', msg.event.value);
                        break;

                    case 'finish':
                        entry.finished_at = (new Date().toISOString());
                        entry.status = 'finished';
                        child.emit('finish');
                        child.emit('event', msg.name, msg.event);
                        child.kill();
                        break;

                    default:
                        child.emit('event', msg.name, msg.event);
                        break;
                }
                break;

            case 'subtask':
                entry.messages.push(msg);
                child.emit('subtask', msg.id, msg.resource, msg.task, msg.msg);
                break;

            case 'exception':
                entry.messages.push(msg);
                self.log.error('Uncaught exception in child: ');
                self.log.error(msg.error.stack);
                break;

            case 'log':
                entry.log.push(msg.entry);
                logForChild(msg.entry.level, msg.entry.message);
                break;

            default:
                warn('Unknown message type, %s', msg.type);
                break;
        }
    });


    child.on('exit', function (code) {
        clearTimeout(timeout);
        if (code !== 0) {
            info('Child terminated with code = ' + code);
            entry.finished_at = (new Date().toISOString());
            entry.status = 'failed';
            child.emit(
                'event', 'error',
                {
                    error: 'Child task process ' + req.task
                    + ' did not terminate cleanly. ('+code+')'
                });
            child.emit('event', 'finish', {});
            child.emit('finish');
        } else {
            info('Child terminated cleanly.');
        }

        delete self.children[pid];
    });

    return child;
};


TaskRunner.prototype.reapChildren = function (req) {
    var self = this;
    for (var pid in self.children) {
        if (!self.children.hasOwnProperty(pid)) {
            continue;
        }
        self.children[pid].kill();
    }
};


module.exports = TaskRunner;
