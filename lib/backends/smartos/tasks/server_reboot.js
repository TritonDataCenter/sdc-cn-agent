/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

var spawn = require('child_process').spawn;

var Task = require('../../../task_agent/task');

var ServerRebootTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(ServerRebootTask);

function start() {
    var self = this;

    var child;
    var rebooter = path.join(__dirname, '/../bin/reboot-server.js');

    // Use ctrun so that rebooter doesn't get killed when this task does.
    child = spawn('/usr/bin/ctrun', [rebooter], {
        cwd: '/',
        detached: true,
        env: {},
        stdio: 'ignore'
    });

    child.on('error', function (err) {
        self.log.error({err: err}, 'failed to spawn rebooter child');
        self.fatal({error: err});
    });

    self.log.info({
        pid: child.pid
    }, 'attempted to spawn rebooter child');

    if (child.pid) {
        // If child.pid is undefined, we'll get to:
        //
        //   child.on('error', ...);
        //
        // above because we'll have failed to spawn.
        self.finish();
    }
}

ServerRebootTask.setStart(start);
