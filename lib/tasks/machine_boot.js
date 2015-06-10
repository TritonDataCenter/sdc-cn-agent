/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var Task = require('../task_agent/task');
var VM  = require('/usr/vm/node_modules/VM');
var vmadm = require('vmadm');
var execFile = require('child_process').execFile;
var common = require('../common');

var MachineBootTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineBootTask);

function ignoreError(err, log) {
    if (err && err.code) {
        switch (err.code) {
            case 'EALREADYRUNNING':
                log.warn({err: err},
                    'ignoring vmadm.start() failure, idempotent flag set');
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
    var uuid = self.req.params.uuid;

    // VM.logger = common.makeVmadmLogger(self);
    // VM.logname = 'machine_boot';
    self.vmadmLogger = common.makeVmadmLogger(self);

    if (self.req.params.idempotent === true ||
        self.req.params.idempotent === 'true') {

        idempotent = true;
    }

    function startVM() {
        self.req.params.log = self.log;
        vmadm.start(self.req.params,  function (error) {
            if (error && (!idempotent || !ignoreError(error, self.log))) {
                var msg = error instanceof Error ? error.message : error;
                self.fatal('vmadm.start error: ' + msg);
                return;
            }

            vmadm.load(
                { uuid: uuid, log: self.log },
                function (loadError, machine)
            {
                if (loadError) {
                    self.fatal('vmadm.load error: ' + loadError.message);
                    return;
                }

                self.finish({ vm: machine });
            });
        });
    }

    // If 'update' param exists, update before starting the vm.
    if (self.req.params.hasOwnProperty('update')) {
        self.log.info('updating vm before starting');
        self.req.params.update.uuid = self.req.params.uuid;
        self.req.params.update.log = self.log;
        vmadm.update(self.req.params.update, function (error) {
            if (error) {
                var msg = error instanceof Error ? error.message : error;
                self.fatal('vmadm.update error: ' + msg);
                return;
            }
            startVM();
        });

    } else {
        startVM();
    }
}

MachineBootTask.setStart(start);
