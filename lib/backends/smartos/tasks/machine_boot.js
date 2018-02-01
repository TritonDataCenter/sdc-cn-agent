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
    var vmadmOpts = {};

    vmadmOpts.log = self.log;
    vmadmOpts.req_id = self.req.req_id;
    vmadmOpts.vmadmLogger = common.makeVmadmLogger(self);

    if (self.req.params.idempotent === true ||
        self.req.params.idempotent === 'true') {

        idempotent = true;
    }

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

    function startVM() {
        vmadm.start(_addVmadmOpts(self.req.params),  function (error) {
            if (error && (!idempotent || !ignoreError(error, self.log))) {
                var msg = error instanceof Error ? error.message : error;
                if (error) {
                    if (error.restCode) {
                        self.fatal('vmadm.start error: ' + msg,
                            { restCode: error.restCode });
                    } else {
                        self.fatal('vmadm.start error: ' + msg);
                    }
                    return;
                }
                return;
            }

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

    /*
     * Try to unmount the zone first. `vmadm` does not like booting or
     * destroying mounted zones. If the unmount fails, it probably means it was
     * already unmounted. In any case, we should proceed with destruction.
     */

    // If 'update' param exists, update before starting the vm.
    if (self.req.params.hasOwnProperty('update')) {
        self.log.info('updating vm before starting');
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
            common.zoneadm(uuid, ['unmount'], {log: self.log},
            function _onZoneadmUnmountUpdate(err) {
                if (err) {
                    self.log.info({ err: err }, 'zoneadm unmount error');
                }
                startVM();
            });
        });

    } else {
        common.zoneadm(uuid, ['unmount'], {log: self.log},
        function _onZoneAdmUnmount(err) {
            if (err) {
                self.log.info({ err: err }, 'zoneadm unmount error');
            }
            startVM();
        });
    }
}

MachineBootTask.setStart(start);
