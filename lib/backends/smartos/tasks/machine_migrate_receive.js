/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var Task = require('../../../task_agent/task');
var fork = require('child_process').fork;
var once = require('once');
var util = require('util');


/**
 * Migration receiver task.
 */
var MachineMigrateReceiveTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineMigrateReceiveTask);

MachineMigrateReceiveTask.setStart(start);

function start(callback) {
    var self = this;

    var binfn = __dirname + '/../bin/machine-migrate-receive.js';
    var forkOpts = { silent: true };
    var handledResponse = false;
    var limitedStderr;
    var log = self.log;
    var payload = self.req.params;

    log.debug('Starting machine-migrate-receive.js child process');

    var migrateProcess = fork(binfn, [], forkOpts);

    // The migrate procress will send one (and only one) message back to us.
    migrateProcess.on('message', once(function (result) {
        handledResponse = true;

        // Detach the IPC communication between the parent/child process.
        migrateProcess.disconnect();

        if (result.error) {
            self.fatal(result.error.message);
            return;
        }

        log.debug('Got response:', result);

        // Add a note of the this/parent process.
        result.ppid = process.pid;

        self.finish(result);
    }));

    migrateProcess.stdout.on('data', function (buf) {
        log.warn('machine-migrate-receive.js stdout: ' + String(buf));
    });

    migrateProcess.stderr.on('data', function (buf) {
        log.warn('machine-migrate-receive.js stderr: ' + String(buf));
        // Only keep the first 2500 and last 2500 characters of stderr.
        if (!limitedStderr) {
            limitedStderr = buf;
        } else {
            limitedStderr = Buffer.concat([limitedStderr, buf]);
        }
        if (limitedStderr.length > 5000) {
            limitedStderr = Buffer.concat([
                limitedStderr.slice(0, 2500),
                Buffer.from('\n...\n'),
                limitedStderr.slice(-2500)
            ]);
        }
    });

    migrateProcess.on('exit', function (code, signal) {
        log.error('machine-migrate-receive.js exit: %s, signal: %s',
            code, signal);
        if (!handledResponse) {
            self.fatal(util.format(
                'machine-migrate-receive exit error (code %s, signal %s)',
                    code, signal),
                String(limitedStderr));
        }
    });

    migrateProcess.on('disconnect', function () {
        log.info('machine-migrate-receive.js disconnect');
    });

    migrateProcess.on('error', function (err) {
        log.error('machine-migrate-receive.js error: ' + err);
    });

    migrateProcess.send({
        logname: log.name,
        payload: payload,
        req_id: self.req.req_id,
        uuid: self.req.params.uuid
    });

    log.debug('child process started - now waiting for child to message back');
}
