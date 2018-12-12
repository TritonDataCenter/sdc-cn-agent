/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var child_process = require('child_process');
var fs = require('fs');

var assert = require('assert-plus');
var once = require('once');
var util = require('util');

var Task = require('../../../task_agent/task');

/**
 * Migrate task.
 */
var MachineMigrateTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineMigrateTask);

MachineMigrateTask.setStart(start);

function startChildProcess(callback) {
    var self = this;

    var payload = this.req.params;

    var binfn = __dirname + '/../bin/machine-migrate-send.js';
    if (payload.action === 'receive') {
        binfn = __dirname + '/../bin/machine-migrate-receive.js';
    }

    var forkOpts = { silent: true };
    var handledResponse = false;
    var limitedStderr;
    var log = self.log;

    log.debug('Starting machine-migrate-%s.js child process', payload.action);

    var migrateProcess = child_process.fork(binfn, [], forkOpts);

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
        log.warn('machine-migrate.js stdout: ' + String(buf));
    });

    migrateProcess.stderr.on('data', function (buf) {
        log.warn('machine-migrate.js stderr: ' + String(buf));
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
        log.error('machine-migrate.js exit: ' + code + ', signal: ' + signal);
        if (!handledResponse) {
            self.fatal(
                util.format('machine-migrate exit error (code %s, signal %s)',
                    code, signal),
                String(limitedStderr));
        }
    });

    migrateProcess.on('disconnect', function () {
        log.info('machine-migrate.js disconnect');
    });

    migrateProcess.on('error', function (err) {
        log.error('machine-migrate.js error: ' + err);
    });

    migrateProcess.send({
        logname: log.name,
        payload: payload,
        req_id: self.req.req_id,
        uuid: self.req.params.uuid
    });

    log.debug('child process started - now waiting for child to message back');
}

function killChild(callback) {
    var log = this.log;
    var payload = this.req.params;

    var pid = payload.pid;
    var ppid = payload.ppid;

    if (!pid) {
        this.fatal('No PID supplied to kill_migration_process task');
        return;
    }

    log.debug({proc_pid: pid, parent_pid: ppid}, 'kill_migration_process');

    // Check if the process is running.
    try {
        process.kill(pid, 0);
    } catch (ex) {
        // Not running.
        log.debug({proc_pid: pid}, 'process not running');
        this.finish();
        return;
    }

    // Check if the process is the one we think it is.
    var cmd = '/usr/bin/ps';
    var args = [
        '-p',
        pid,
        '-o',
        'ppid=',
        '-o',
        'zone='
    ];

    var buf;
    try {
        buf = child_process.execFileSync(cmd, args);
    } catch (ex) {
        log.warn({proc_pid: pid}, 'Could not get ps info:', ex);
        this.finish();
        return;
    }

    var argSplit = String(buf).split(' ');
    // Check the parent process is the same.
    if (argSplit[0] !== ppid) {
        log.debug({ppid: argSplit[0]}, 'found process, but different ppid');
        this.finish();
        return;
    }
    // Check the zone name.
    if (argSplit[1] !== 'global') {
        log.debug({zone: argSplit[1]}, 'found process, but different zone');
        this.finish();
        return;
    }

    // Check the process name/argv.
    var argv;
    try {
        argv = fs.readFileSync('/proc/' + pid + '/argv');
    } catch (ex) {
        log.warn({proc_pid: pid}, 'Could not get argv info:', ex);
        this.finish();
        return;
    }

    if (argv.indexOf('/machine-migrate.js') === -1) {
        log.warn({argv: argv}, 'Could not find migrate.js in argv');
        this.finish();
        return;
    }

    // Kill the process.
    try {
        process.kill(pid, 'SIGTERM');
    } catch (ex) {
        log.warn({proc_pid: pid}, 'Could not kill process:', ex);
    }

    log.info({proc_pid: pid}, 'success - killed the cn-agent migrate process');

    this.finish();
}


function setupFilesystem(callback) {
    var log = this.log;
    var payload = this.req.params;

    assert.object(payload, 'payload');
    assert.uuid(payload.vm_uuid, 'payload.vm_uuid');

    var buf;
    var vmUuid = payload.vm_uuid;

    // Mount the zfs filesystem.
    var cmd = '/usr/sbin/zfs';
    var args = [
        'mount',
        'zones/' + vmUuid
    ];

    log.debug({cmd: cmd, args: args}, 'mount zfs filesystem');

    try {
        buf = child_process.execFileSync(cmd, args);
    } catch (ex) {
        log.warn({cmd: cmd, args: args}, 'Could not run zfs mount:', ex);
        this.fatal(String(buf));
        return;
    }

    this.finish();
}


function setDoNotInventory(callback) {
    var log = this.log;
    var payload = this.req.params;

    assert.object(payload, 'payload');
    assert.uuid(payload.vm_uuid, 'payload.vm_uuid');
    assert.string(payload.value, 'payload.value');

    var vmUuid = payload.vm_uuid;
    var value = payload.value;

    // Update using vmadm.
    var cmd = '/usr/sbin/vmadm';
    var args = [
        'update',
        vmUuid,
        'do_not_inventory=' + value
    ];

    var buf;

    log.debug({cmd: cmd, args: args}, 'setDoNotInventory');

    try {
        buf = child_process.execFileSync(cmd, args);
    } catch (ex) {
        log.warn({cmd: cmd, args: args}, 'Could not run vmadm update:', ex);
        this.fatal(String(buf));
        return;
    }

    this.finish();
}


function setAutoboot(callback) {
    var log = this.log;
    var payload = this.req.params;

    assert.object(payload, 'payload');
    assert.uuid(payload.vm_uuid, 'payload.vm_uuid');
    assert.string(payload.value, 'payload.value');

    var vmUuid = payload.vm_uuid;
    var value = payload.value;

    // Update using vmadm.
    var cmd = '/usr/sbin/vmadm';
    var args = [
        'update',
        vmUuid,
        'autoboot=' + value
    ];

    var buf;

    log.debug({cmd: cmd, args: args}, 'setAutoboot');

    try {
        buf = child_process.execFileSync(cmd, args);
    } catch (ex) {
        log.warn({cmd: cmd, args: args}, 'Could not run vmadm update:', ex);
        this.fatal(String(buf));
        return;
    }

    this.finish();
}


function start(callback) {
    var payload = this.req.params;

    if (payload.action === 'kill_migration_process') {
        killChild.bind(this)(callback);
    } else if (payload.action === 'sync' || payload.action === 'receive') {
        startChildProcess.bind(this)(callback);

    /* Switch helper functions */
    } else if (payload.action === 'setup-filesystem') {
        setupFilesystem.bind(this)(callback);
    } else if (payload.action === 'set-do-not-inventory') {
        setDoNotInventory.bind(this)(callback);
    } else if (payload.action === 'set-autoboot') {
        setAutoboot.bind(this)(callback);
    } else {
        this.fatal('Unexpected payload.action: ' + payload.action);
    }
}
