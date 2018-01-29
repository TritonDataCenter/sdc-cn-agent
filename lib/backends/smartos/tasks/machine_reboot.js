/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var Task = require('../../../task_agent/task');
var vmadm = require('vmadm');
var execFile = require('child_process').execFile;
var common = require('../common');

var MachineRebootTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineRebootTask);

function ignoreError(err, log) {
    if (err && err.code) {
        switch (err.code) {
            case 'ENOTRUNNING':
                log.warn({err: err},
                    'ignoring vmadm.reboot() failure, idempotent flag set');
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
    var force = self.req.params.force;
    var opts = {};
    var timeout = self.req.params.timeout;
    var uuid = self.req.params.uuid;
    var vmadmOpts = {};

    vmadmOpts.log = self.log;
    vmadmOpts.req_id = self.req.req_id;
    vmadmOpts.vmadmLogger = common.makeVmadmLogger(self);

    function _addVmadmOpts(obj) {
        var newobj = obj;

        for (var prop in vmadmOpts) {
            if (!vmadmOpts.hasOwnProperty(prop)) {
                continue;
            }
            newobj[prop] = vmadmOpts[prop];
        }

        return newobj;
    }

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

    if (self.req.params.idempotent === true ||
        self.req.params.idempotent === 'true') {

        idempotent = true;
    }

    function rebootVM() {
        var rebootopts = _addVmadmOpts({ uuid: uuid });
        if (opts.force) {
            rebootopts.force = true;
        }

        vmadm.reboot(rebootopts, function (error) {
            if (error && (!idempotent || !ignoreError(error, self.log))) {
                var msg = error instanceof Error ? error.message : error;
                if (error.restCode) {
                    self.fatal('vmadm.reboot error: ' + msg,
                        { restCode: error.restCode });
                } else {
                    self.fatal('vmadm.reboot error: ' + msg);
                }
                return;
            }
            self.progress(100);
            vmadm.load(
                _addVmadmOpts({ uuid: uuid }),
                function (loadError, machine)
            {
                if (loadError) {
                    if (loadError.restCode) {
                        self.fatal('vmadm.load error: ' + loadError.message,
                            { restCode: loadError.restCode });
                    } else {
                        self.fatal('vmadm.load error: ' + loadError.message);
                    }
                    return;
                }

                self.finish({ vm: machine });
            });
        });
    }

    // If 'update' param exists, update before rebooting the vm.
    if (self.req.params.hasOwnProperty('update')) {
        self.log.info('updating vm before rebooting');
        self.req.params.update.uuid = self.req.params.uuid;
        vmadm.update(_addVmadmOpts(self.req.params.update), function (error) {
            if (error) {
                var msg = error instanceof Error ? error.message : error;
                if (error.restCode) {
                    self.fatal('vmadm.update error: ' + msg,
                        { restCode: error.restCode });
                } else {
                    self.fatal('vmadm.update error: ' + msg);
                }
                return;
            }
            rebootVM();
        });

    } else {
        rebootVM();
    }
}

MachineRebootTask.setStart(start);
