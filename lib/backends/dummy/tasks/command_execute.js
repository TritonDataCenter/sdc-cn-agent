/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

var assert = require('assert-plus');
var verror = require('verror');

var Task = require('../../../task_agent/task');


var CommandExecuteTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(CommandExecuteTask);

function start(callback) {
    var self = this;
    var msg = 'command_execute not implemented for mockcloud servers';
    var opts = {};
    var req = self.req;

    assert.object(req, 'req');
    assert.object(req.params, 'req.params');
    assert.optionalArray(req.params.args, 'req.params.args');
    assert.optionalObject(req.params.env, 'req.params.env');
    assert.string(req.params.script, 'req.params.script');
    assert.optionalNumber(req.params.timeout, 'req.params.timeout');

    opts.log = self.log;
    opts.req_id = self.req.req_id;

    opts.log.warn({params: req.params, req_id: opts.req_id}, msg);

    // NOTE: no point implementing timeout here, because we always return
    // immediately.

    // Pretend we executed the script and then got this error.
    self.finish({
        err: new verror.VError(msg),
        exitCode: 666,
        signal: null,
        stderr: 'cn-agent: ' + msg + '\n',
        stdout: ''
    });
}

CommandExecuteTask.setStart(start);
