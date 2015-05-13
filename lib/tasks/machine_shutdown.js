/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var Task = require('../task_agent/task');
var VM = require('/usr/vm/node_modules/VM');
var execFile = require('child_process').execFile;
var common = require('../common');

var MachineShutdownTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineShutdownTask);

function ignoreError(err, log) {
    if (err && err.code) {
        switch (err.code) {
            case 'ESRCH':
            case 'ENOTRUNNING':
                log.warn({err: err},
                    'ignoring VM.stop() failure, idempotent flag set');
                return (true);
        }
    }

    return (false);
}

function start(callback) {
    var idempotent = false;
    var self = this;
    var uuid = self.req.params.uuid;
    var force = self.req.params.force;
    var timeout = self.req.params.timeout;
    var opts = {};

    VM.logger = common.makeVmadmLogger(self);
    VM.logname = 'machine_shutdown';

    if (force) {
        opts.force = true;
    }

    if (timeout) {
        if ((typeof (timeout) === 'string') && timeout.match(/^[0-9]+$/)) {
            opts.timeout = Number(timeout);
        } else if (typeof (timeout) === 'number') {
            opts.timeout = timeout;
        } else {
            self.fatal('Invalid type: "' + typeof (timeout) + '" for timeout');
            return;
        }
    }

    if (self.req.params.idempotent === true
        || self.req.params.idempotent === 'true') {

        idempotent = true;
    }

    VM.stop(uuid, opts, function (error) {
        if (error && (!idempotent || !ignoreError(error, self.log))) {
            var msg = error instanceof Error ? error.message : error;
            self.fatal('VM.shutdown error: ' + msg);
            return;
        }
        self.progress(100);
        self.finish();
        return;
    });
}

MachineShutdownTask.setStart(start);
