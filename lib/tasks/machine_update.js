/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var Task = require('../task_agent/task');
var vmadm = require('vmadm');
var execFile = require('child_process').execFile;
var common = require('../common');

var MachineUpdateTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineUpdateTask);

function start(callback) {
    var self = this;
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

    vmadm.update(_addVmadmOpts(self.req.params), function (error) {
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

        vmadm.load(_addVmadmOpts({ uuid: uuid }), function (error2, vm) {
            if (error2) {
                if (error2.restCode) {
                    self.fatal('vmadm.load error: ' + error2.message,
                        { restCode: error2.restCode });
                } else {
                    self.fatal('vmadm.load error: ' + error2.message);
                }
                return;
            }

            if (!self.req.params.hasOwnProperty('add_nics') &&
                !self.req.params.hasOwnProperty('remove_nics')) {
                self.progress(100);
                self.finish({ vm: vm });
                return;
            }

            if (vm.state !== 'running') {
                self.progress(100);
                self.finish({ vm: vm });
                return;
            }

            self.progress(75);
            vmadm.reboot(_addVmadmOpts({ uuid: uuid }), function (error3) {
                if (error3) {
                    if (error3.restCode) {
                        self.fatal('vmadm.reboot error: ' + error3.message,
                            { restCode: error3.restCode });
                    } else {
                        self.fatal('vmadm.reboot error: ' + error3.message);
                    }
                    return;
                }

                self.progress(100);
                self.finish({ vm: vm });
            });
        });
    });
}

MachineUpdateTask.setStart(start);
