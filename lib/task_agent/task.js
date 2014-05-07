var EventEmitter = require('events').EventEmitter;
var util = require('util');
var fs = require('fs');
var path = require('path');
var JSV = require('JSV').JSV;
var smartdc_config = require('./smartdc-config');
var common = require('./common');
var spawn = require('child_process').spawn;

function Task(request) {
    EventEmitter.call(this);
    this.subTaskCallbacks = {};
    this.log = new Log(this);
    this.req = request;
}

util.inherits(Task, EventEmitter);

Task.prototype.validate = function (callback) {
    callback();
};


function Log(task) {
    this.task = task;
    this.entries = [];
}

Log.LOG_LEVELS = {
    'all': 0,
    'debug': 1,
    'info': 2,
    'warn': 3,
    'error': 4
};

function toArray(args) {
    return Array.prototype.slice.call(args, 0);
}

Log.prototype.dir = function () {
    return this.logMessage('debug', toArray(arguments));
};


Log.prototype.debug = function () {
    return this.logMessage('debug', toArray(arguments));
};


Log.prototype.info = function () {
    return this.logMessage('info', toArray(arguments));
};


Log.prototype.warn = function () {
    return this.logMessage('warn', toArray(arguments));
};


Log.prototype.trace = function () {
    return this.logMessage('trace', toArray(arguments));
};


Log.prototype.error = function () {
    return this.logMessage('error',  toArray(arguments));
};


Log.prototype.process
= function (process, args, env, exitstatus, stdout, stderr) {
    var item = {
        timestamp:   new Date().toISOString(),
        level:       'debug',
        process:     process,
        args:        args,
        env:         env,
        exitstatus:  exitstatus,
        stdout:      stdout,
        stderr:      stderr,
        type:        'process'
    };
    this.entries.push(item);
    this.task.emit('log', item);
    return item;
};


Log.prototype.logMessage = function (level, args) {
    var timestamp = new Date().toISOString();

    var item = {
        timestamp: timestamp,
        message:   args,
        level:     level,
        type:      'message'
    };
    this.entries.push(item);
    this.task.emit('log', item);
    return item;
};


Task.prototype.start = function (callback) {
    this.finish();
};


Task.prototype.finish = function (value, callback) {
    if (this.progress_ < 100) {
      this.progress(100);
    }
    this.event('finish', value);
};


Task.prototype.event = function (eventName, payload) {
    payload = payload || {};
    payload.req_id = this.req.params.req_id;
    this.emit('event', eventName, payload);
};


Task.prototype.error = function (errorMsg, details) {
    var msg = { error: errorMsg };
    if (details) {
        msg.details = details;
    }
    this.event('error', msg);
};


Task.prototype.fatal = function (errorMsg, details) {
    var self = this;
    self.error(errorMsg, details);
    self.finish();
};


Task.prototype.progress = function (value) {
    this.progress_ = value;
    this.event('progress', { value: value });
};


Task.prototype.run = function (binpath, args, env, callback) {
    var child = spawn(binpath, args, { encoding: 'utf8', env: env });

    var entry = this.log.process(binpath, args, env, undefined, '', '');
    child.stdout.on('data', function (data) {
        entry.stdout += data.toString();
    });

    child.stderr.on('data', function (data) {
        entry.stderr += data.toString();
    });

    child.on('exit', function (exitstatus) {
        entry.exitstatus = exitstatus;
        callback(exitstatus, entry.stdout, entry.stderr);
    });
};


Task.prototype.subTask = function (resource, task, msg, callback) {
    var id = common.genId();
    this.subTaskCallbacks[id] = callback;
    this.emit(
        'subtask',
        {
            resource: resource,
            task: task,
            msg: msg,
            id: id
        });
};


Task.createSteps = function (steps) {
    for (var k in steps) {
        var step = steps[k];
        var options = {
            description: step.description,
            progress: step.progress
        };
        this.createStep(k, step.fn, options);
    }
};


/**
 * Use this 'decorator' to ensure when step functions are called they emit
 * events on start/end of execution.
 *
 * Returns a function that emits an event when executed, and wraps the step
 * functions callback with a funcition that emits an 'end' event.
 */

Task.createStep = function (stepName, fn, options) {
    this.prototype[stepName] = function () {
        var self = this;

        self.emit(
            'event',
            ['start', stepName].join(':'),
            {
                timestamp: (new Date).toISOString(),
                description: options.description
            });

        /**
         * Partition the step function's received arguments into args and
         * callback
         */
        var args = Array.prototype.slice.apply(arguments, [0, -1]);
        var stepCallback = Array.prototype.slice.call(arguments, -1)[0];

        args.push(function () {
            if (options.progress)
            self.progress(options.progress);

            self.emit(
                'event',
                ['end', stepName].join(':'),
                { timestamp: (new Date).toISOString() });
            return stepCallback.apply(this, arguments);
        });

        return fn.apply(this, args);
    };
};


Task.setStart = function (fn) {
    this.prototype.start = function () {
        var self = this;
        self.validate(function (error, report) {
            if (error) {
                self.error('Task parameters failed validation', report);
                self.finish();
                return;
            }
            smartdc_config.sdcConfig(function (configError, config) {
                self.sdcConfig = config;
                self.progress(0);
                self.event('start', {});
                fn.apply(self, arguments);
            });
        });
    };
};


Task.setFinish = function (fn) {
    this.prototype.finish = function () {
        this.finish();
        fn.apply(this, arguments);
    };
};


Task.setValidate = function (fn) {
    this.prototype.validate = function () {
        this.event('task_validated', {});
        fn.apply(this, arguments);
    };
};


Task.createTask = function (task) {
    util.inherits(task, Task);
    task.setStart = Task.setStart;
    task.setFinish = Task.setFinish;
    task.createStep = Task.createStep;
    task.createSteps = Task.createSteps;
    task.setValidate = Task.setValidate;
};

module.exports = Task;
