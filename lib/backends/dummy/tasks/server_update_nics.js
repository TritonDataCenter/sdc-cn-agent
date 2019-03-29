/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

var fs = require('fs');
var path = require('path');

var assert = require('assert-plus');
var vasync = require('vasync');

var common = require('../common');
var shared = require('./shared');
var SysinfoGetter = require('../lib/sysinfo');
var Task = require('../../../task_agent/task');


var NicUpdateTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(NicUpdateTask);


function start() {
    var self = this;
    var serverRoot = common.SERVER_ROOT;

    assert.object(self.req, 'self.req');
    assert.object(self.req.sysinfo, 'self.req.sysinfo');
    assert.object(self.req.serverAddress, 'self.req.serverAddress');

    (new SysinfoGetter()).get({
        serverAddress: self.req.serverAddress,
        serverUuid: self.req.sysinfo.UUID
    }, function _onSysinfo(getErr, sysinfo) {
        var idx;
        var iface;
        var mac;
        var macToIface = {};
        var modified = false;
        var nic;
        var nicKeys;

        if (getErr) {
            self.fatal(getErr.message);
            return;
        }

        self.progress(20);

        nicKeys = Object.keys(sysinfo['Network Interfaces']);

        for (idx = 0; idx < nicKeys.length; idx++) {
            nic = sysinfo['Network Interfaces'][nicKeys[idx]];
            assert.string(nic['MAC Address'], 'nic[\'MAC Address\']');
            mac = nic['MAC Address'];
            macToIface[mac] = nicKeys[idx];
        }

        for (idx = 0; idx < self.req.params.nics.length; idx++) {
            nic = self.req.params.nics[idx];
            if (macToIface.hasOwnProperty(nic.mac)) {
                iface = macToIface[nic.mac];
                sysinfo['Network Interfaces'][iface]['NIC Names'] =
                    nic.nic_tags_provided;
                modified = true;
            } else {
                self.log.error({nic: nic}, 'Unknown NIC');
            }
        }

        if (modified) {
            shared.writeSysinfo({
                log: self.log,
                serverRoot: serverRoot
            },
            sysinfo,
            function _onWroteSysinfo(err) {
                if (err) {
                    self.fatal(err.message);
                    return;
                }

                self.finish({sysinfo: sysinfo});
            });
        } else {
            self.finish({sysinfo: sysinfo});
        }
    });
}

NicUpdateTask.setStart(start);
