/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var fs = require('fs');
var path = require('path');

var assert = require('assert-plus');
var vasync = require('vasync');

var common = require('../common');
var SysinfoGetter = require('../lib/sysinfo');
var Task = require('../../../task_agent/task');


var NicUpdateTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(NicUpdateTask);

function writeSysinfo(opts, sysinfo, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.serverRoot, 'opts.serverRoot');
    assert.object(sysinfo, 'sysinfo');
    assert.func(callback, 'callback');

    var fd;
    var filename;
    var tmpFilename;

    filename = path.join(opts.serverRoot, sysinfo.UUID, 'sysinfo.json');
    tmpFilename = filename + '.' + process.pid;

    vasync.pipeline({
        funcs: [
            function _openFile(_, cb) {
                fs.open(tmpFilename, 'wx', function _onOpen(err, openedFd) {
                    if (err) {
                        cb(err);
                        return;
                    }

                    fd = openedFd;
                    cb();
                });
            }, function _writeThenCloseFile(_, cb) {
                var buf = new Buffer(JSON.stringify(sysinfo, null, 2) + '\n');

                fs.write(fd, buf, 0, buf.length, null, function _onWrite(err) {
                    if (err) {
                        cb(err);
                        return;
                    }
                    fs.close(fd, function _onWritten() {
                        cb();
                    });
                });
            }, function _atomicReplace(_, cb) {
                if (!opts.atomicReplace) {
                    cb();
                    return;
                }

                fs.rename(tmpFilename, filename, cb);
            }
        ]
    }, function _onWroteSysinfo(err) {
        opts.log.debug({err: err, sysinfo: sysinfo}, 'wrote sysinfo');
        callback(err);
    })
}

function start() {
    var self = this;
    var filename;
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
            assert.string(nic['MAC Address'], "nic['MAC Address']");
            mac = nic['MAC Address'];
            macToIface[mac] = nicKeys[idx];
        }

        for (idx = 0; idx < self.req.params.nics.length; idx++) {
            nic = self.req.params.nics[idx];
            if (macToIface.hasOwnProperty(nic.mac)) {
                iface = macToIface[nic.mac];
                sysinfo['Network Interfaces'][iface]['NIC Names'] = nic.nic_tags_provided;
                modified = true;
            } else {
                self.log.error({nic: nic}, 'unknown NIC');
            }
        }

        if (modified) {
            writeSysinfo({
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
