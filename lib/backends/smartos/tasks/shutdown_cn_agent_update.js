/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var Task = require('../../../task_agent/task');
var execFile = require('child_process').execFile;

var ShutdownCnAgentUpdate = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(ShutdownCnAgentUpdate);

function start(callback) {
    var self = this;
    var args = ['disable', 'cn-agent-update'];
    var cmd = '/usr/sbin/svcadm';
    self.log.debug({cmdline: cmd + ' ' + args.join(' ')}, 'executing');
    execFile(cmd, args, function (err, stdout, stderr) {
        if (err) {
            self.log.error({
                err: err
            }, 'failed to disable cn-agent-update service');
            var msg = err instanceof Error ? err.message : err;
            return self.fatal('Disable cn-agent-update error: ' + msg);
        }
        self.log.debug({
            stdout: stdout,
            stderr: stderr
        }, 'disable-cn-agent-update');
        self.progress(100);
        return self.finish();
    });
}

ShutdownCnAgentUpdate.setStart(start);
