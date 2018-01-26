/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var Task = require('../../../task_agent/task');
var vmadm  = require('vmadm');
var execFile = require('child_process').execFile;
var common = require('../common');

var MachineKillTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineKillTask);

function ignoreError(err, log) {
    if (err && err.code) {
        switch (err.code) {
            case 'ESRCH':
            case 'ENOTRUNNING':
                log.warn({err: err},
                    'ignoring vmadm.kill() failure, idempotent flag set');
                return (true);
            default:
                break;
        }
    }

    return (false);
}

function start(callback) {
    var idempotent = false;
    var self = this;
    var opts = {};

    if (self.req.params.idempotent === true ||
        self.req.params.idempotent === 'true') {

        idempotent = true;
    }

    opts = self.req.params;
    opts.log = self.log;
    opts.req_id = self.req.req_id;
    opts.vmadmLogger = common.makeVmadmLogger(self);

    vmadm.kill(opts, function (error) {
        if (error && (!idempotent || !ignoreError(error, self.log))) {
            var msg = error instanceof Error ? error.message : error;
            if (error.restCode) {
                self.fatal('vmadm.kill error: ' + msg,
                    { restCode: error.restCode });
            } else {
                self.fatal('vmadm.kill error: ' + msg);
            }
            return;
        }

        vmadm.load(opts, function _load(loadError, machine) {
            if (loadError) {
                self.fatal('vmadm.load error: ' + loadError.message);
                return;
            }

            self.finish({ vm: machine });
        });
    });
}

MachineKillTask.setStart(start);
