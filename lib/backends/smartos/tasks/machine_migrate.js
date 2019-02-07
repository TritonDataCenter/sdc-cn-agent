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
var util = require('util');

var assert = require('assert-plus');
var once = require('once');
var vasync = require('vasync');
var VError = require('verror').VError;

var Task = require('../../../task_agent/task');

var SNAPSHOT_NAME_PREFIX = 'vm-migrate-estimate';

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

    var forkArgs = [
        // Used as a marker for killChild.
        payload.vm_uuid
    ];
    var forkOpts = { silent: true };
    var handledResponse = false;
    var limitedStderr;
    var log = self.log;

    log.debug('Starting machine-migrate-%s.js child process', payload.action);

    var migrateProcess = child_process.fork(binfn, forkArgs, forkOpts);

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
    var vmUuid = payload.vm_uuid;

    if (!pid || !Number.isInteger(pid) || pid <= 1) {
        this.fatal('Invalid PID supplied to kill_migration_process task');
        return;
    }

    log.debug({proc_pid: pid}, 'kill_migration_process');

    // Check if the process is running.
    try {
        process.kill(pid, 0);
    } catch (ex) {
        // Not running.
        log.debug({proc_pid: pid}, 'process not running');
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

    if (argv.indexOf('/machine-migrate-') === -1 ||
            argv.indexOf(vmUuid) === -1) {
        log.warn({argv: argv}, 'Could not find migrate markers in argv');
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


// Cribbed from zfs.js
function zfsErrorStr(error, stderr) {
    if (!error) {
        return ('');
    }

    if (error.killed) {
        return ('Process killed due to timeout.');
    }

    return (error.message || (stderr ? stderr.toString() : ''));
}


function zfsError(prefixMsg, error, stderr) {
    var err = (new VError(prefixMsg + ': ' + zfsErrorStr(error, stderr)));
    err.stderr = stderr;
    return err;
}


function deleteSnapshot(snapshot, log, callback) {
    assert.string(snapshot, 'snapshot');
    assert.object(log, 'log');
    assert.func(callback, 'callback');

    assert.ok(snapshot.length > 0, 'snapshot.length > 0');
    assert.ok(snapshot.lastIndexOf('@') > 0, 'snapshot.lastIndexOf("@") > 0');

    // Delete any existing migration estimate snapshot.
    var cmd = '/usr/sbin/zfs';
    var args = [
        'destroy',
        '-r',
        snapshot
    ];
    var timeout = 5 * 60 * 1000; // 5 minutes

    log.debug({cmd: cmd, args: args}, 'deleteSnapshot');

    child_process.execFile(cmd, args, { timeout: timeout},
            function (err, stdout, stderr) {
        // Catch the error when a snapshot does not exist - that is allowed.
        if (err && stderr.indexOf('could not find any snapshots to ' +
                'destroy') === -1) {
            log.error('zfs snapshot destroy error:', err,
                ', stderr:', stderr);
            callback(new zfsError('zfs snapshot destroy failure', err, stderr));
            return;
        }

        callback();
    });
}


function estimate(callback) {
    var self = this;

    var log = self.log;
    var payload = self.req.params;

    assert.object(payload, 'payload');
    assert.object(payload.vm, 'payload.vm');

    var estimatedSize = 0;
    var vm = payload.vm;
    var isDocker = (vm.brand === 'lx' && vm.docker === true);

    // This is the main context for each dataset sync operation.
    var datasets = [vm.zfs_filesystem];

    // For KVM, the disks hold zfs filesystems that are outside of the base
    // dataset, so we must copy over these filesystems as well. Note that BHYVE
    // uses disks that are a zfs child dataset, which will then be sent
    // recursively all in one go.
    if (vm.brand === 'kvm' && Array.isArray(vm.disks)) {
        vm.disks.forEach(function _forEachDisk(disk) {
            datasets.push(disk.zfs_filesystem);
        });
    }

    function estimateOneDataset(dataset, next) {
        var ctx = {
            snapshot: dataset + '@' + SNAPSHOT_NAME_PREFIX
        };

        vasync.pipeline({funcs: [
            // Delete any existing migration estimate snapshot.
            function deletePreviousSnapshot(_, cb) {
                deleteSnapshot(ctx.snapshot, log, cb);
            },

            // Create a temporary snapshot to get an estimate.
            function createSnapshot(_, cb) {
                var cmd = '/usr/sbin/zfs';
                var args = [
                    'snapshot',
                    '-r',
                    ctx.snapshot
                ];
                var timeout = 5 * 60 * 1000; // 5 minutes

                log.debug({cmd: cmd, args: args}, 'zfs snapshot');

                child_process.execFile(cmd, args, { timeout: timeout},
                        function (err, stdout, stderr) {
                    if (err) {
                        log.error('zfs snapshot error:', err,
                            ', stderr:', stderr);
                            cb(new zfsError('zfs snapshot failure',
                                err, stderr));
                        return;
                    }

                    ctx.snapshotCreated = true;
                    cb();
                });
            },

            // Get the estimate for the snapshot.
            function getEstimate(_, cb) {
                var replicateArg = '--replicate';

                // Docker datasets are created on demand for each CN, so they
                // will always be different between each CN. Thus we don't want
                // the usual --replicate argument (as that will expect the
                // origin dataset to be the same) - we want a full send instead.
                if (isDocker) {
                    replicateArg = '--props';
                }

                var cmd = '/usr/sbin/zfs';
                var args = [
                    'send',
                    '--dryrun',
                    '--parsable',
                    replicateArg,
                    ctx.snapshot
                ];
                var timeout = 5 * 60 * 1000; // 5 minutes

                log.info({cmd: cmd, args: args, timeout: timeout},
                    'getEstimate');

                child_process.execFile(cmd, args, { timeout: timeout},
                        function (error, stdout, stderr) {
                    if (error) {
                        log.error('zfs snapshot error:', error,
                            ', stderr:', stderr);
                        cb(zfsError('zfs snapshot error', error, stderr));
                        return;
                    }

                    var lines = stdout.trim().split('\n');
                    var lastLine = lines.splice(-1)[0].trim();
                    log.trace('getEstimate:: lastLine: %s', lastLine);

                    var match = lastLine.match(/^size\s+(\d+)$/);
                    if (!match) {
                        log.error('Unable to get zfs send estimate, stdout:',
                            stdout);
                        cb(new Error('Unable to get zfs send estimate'));
                        return;
                    }

                    log.debug({dataset: dataset, estimate: match[1]},
                        'getEstimate');

                    estimatedSize += Number(match[1]);

                    cb();
                });
            },

            // Delete the created migration estimate snapshot.
            function cleanupSnapshot(_, cb) {
                deleteSnapshot(ctx.snapshot, log, cb);
            }

        ]}, function _onEstimateOneDatasetPipelineCb(err) {
            if (err) {
                if (ctx.snapshotCreated) {
                    deleteSnapshot(ctx.snapshot, log, function _deleteCb(err2) {
                        // Ignoring err2 and using original err.
                        next(err);
                        return;
                    });
                }
                next(err);
                return;
            }
            next();
        });
    }

    vasync.forEachParallel({inputs: datasets, func: estimateOneDataset},
            function _onEstimateComplete(err) {
        if (err) {
            // log.error('estimate failure', err);
            self.fatal(err);
            return;
        }

        var result = {
            size: estimatedSize
        };
        self.finish(result);
    });
}


function setupFilesystem(callback) {
    var log = this.log;
    var payload = this.req.params;

    assert.object(payload, 'payload');
    assert.object(payload.vm, 'payload.vm');
    assert.string(payload.vm.zfs_filesystem, 'payload.vm.zfs_filesystem');
    assert.object(payload.migrationTask, 'payload.migrationTask');
    assert.uuid(payload.migrationTask.record.vm_uuid,
        'payload.migrationTask.record.vm_uuid');
    assert.uuid(payload.migrationTask.record.target_vm_uuid,
        'payload.migrationTask.record.target_vm_uuid');

    var buf;
    var dataset = payload.vm.zfs_filesystem;
    var target_vm_uuid = payload.migrationTask.record.target_vm_uuid;
    var vm_uuid = payload.migrationTask.record.vm_uuid;

    // Check for override of the vm uuid. Note that performing an uuid override
    // is only supported in a non-production environment.
    if (vm_uuid !== target_vm_uuid) {
        var fileMarkerPath = '/lib/sdc/.sdc-test-no-production-data';
        try {
            fs.accessSync(fileMarkerPath);
        } catch (ex) {
            this.fatal('Cannot perform migration uuid override - ' +
                'as non-production marker file is missing: ' +
                fileMarkerPath);
            return;
        }

        dataset = dataset.replace(vm_uuid, target_vm_uuid);

        log.warn({
            vm_uuid: vm_uuid,
            target_vm_uuid: target_vm_uuid,
            dataset: dataset,
            original_dataset: payload.vm.zfs_filesystem
        }, 'setupFilesystem:: performing uuid override for dataset');
    }

    // Mount the zfs filesystem.
    var cmd = '/usr/sbin/zfs';
    var args = [
        'mount',
        dataset
    ];
    var errorMsg;

    log.debug({cmd: cmd, args: args}, 'mount zfs filesystem');

    try {
        buf = child_process.execFileSync(cmd, args);
    } catch (ex) {
        log.warn({cmd: cmd, args: args}, 'Could not run zfs mount:', ex);
        errorMsg = String(ex.stderr || buf);
        if (errorMsg.indexOf('filesystem already mounted') === -1) {
            this.fatal(errorMsg);
            return;
        }
    }

    this.finish();
}


function removeSyncSnapshots(callback) {
    var self = this;

    var log = self.log;
    var payload = self.req.params;

    assert.object(payload, 'payload');
    assert.uuid(payload.vm_uuid, 'payload.vm_uuid');
    assert.object(payload.vm, 'payload.vm');
    assert.string(payload.vm.zfs_filesystem, 'payload.vm.zfs_filesystem');
    assert.object(payload.migrationTask, 'payload.migrationTask');
    assert.object(payload.migrationTask.record, 'payload.migrationTask.record');
    assert.uuid(payload.migrationTask.record.target_vm_uuid,
        'payload.migrationTask.record.target_vm_uuid');

    var vm = payload.vm;

    var datasets = [vm.zfs_filesystem];

    // For KVM, the disks hold zfs filesystems that are outside of the base
    // dataset, so we must iterate over these filesystems as well. Note that
    // BHYVE uses disks that are a zfs child dataset, so these are iterated
    // over as part of the `zfs list` command.
    if (vm.brand === 'kvm' && Array.isArray(vm.disks)) {
        vm.disks.forEach(function _forEachDisk(disk) {
            datasets.push(disk.zfs_filesystem);
        });
    }

    // Check for override of the vm uuid. Note that performing an uuid override
    // is only supported in a non-production environment.
    if (vm.uuid !== payload.vm_uuid) {
        var fileMarkerPath = '/lib/sdc/.sdc-test-no-production-data';
        try {
            fs.accessSync(fileMarkerPath);
        } catch (ex) {
            self.fatal('Cannot perform migration uuid override - ' +
                'as non-production marker file is missing: ' +
                fileMarkerPath);
            return;
        }

        datasets = datasets.map(function (aDataset) {
            return aDataset.replace(vm.uuid, payload.vm_uuid);
        });

        log.warn({
            vm_uuid: vm.uuid,
            target_vm_uuid: payload.vm_uuid,
            datasets: datasets
        }, 'removeSyncSnapshots:: performing uuid override for datasets');
    }

    function listSnapshots(ctx, next) {
        assert.string(ctx.dataset, 'ctx.dataset');

        var cmd = '/usr/sbin/zfs';
        var args = [
            'list',
            '-t',
            'snapshot',
            '-r',
            '-H',
            '-o',
            'name',
            ctx.dataset
        ];

        log.debug({cmd: cmd, args: args}, 'listSnapshots');

        child_process.execFile(cmd, args,
                function (err, stdout, stderr) {
            if (err) {
                log.error({cmd: cmd, args: args},
                    'Could not run zfs list:', err);
                next(new zfsError('zfs list failure', err, stderr));
                return;
            }
            ctx.snapshots = stdout.trim().split('\n').filter(
                    function _filterEmptySnapshotNames(name) {
                // When there are no snapshots - we end up with an empty string.
                return name;
            });
            next();
        });
    }

    function destroySnapshots(ctx, next) {
        assert.arrayOfString(ctx.snapshots, 'ctx.snapshots');

        vasync.forEachPipeline({
            inputs: ctx.snapshots,
            func: function destroyOneSnapshot(snapshot, cb) {
                deleteSnapshot(snapshot, log, cb);
            }
        }, next);
    }

    function destroySyncSnapshots(dataset, next) {
        vasync.pipeline({arg: {dataset: dataset}, funcs: [
            listSnapshots,
            destroySnapshots
        ]}, next);
    }

    vasync.forEachParallel({inputs: datasets, func: destroySyncSnapshots},
            function _destroySyncSnapshotsCb(err) {
        if (err) {
            log.error('removeSyncSnapshots failure:', err);
            self.fatal(err);
            return;
        }

        self.finish();
    });
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
        this.fatal(String(ex.stderr || buf));
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
        this.fatal(String(ex.stderr || buf));
        return;
    }

    this.finish();
}


function start(callback) {
    var payload = this.req.params;

    /* Cleanup */
    if (payload.action === 'kill_migration_process') {
        killChild.bind(this)(callback);

    /* Sync */
    } else if (payload.action === 'sync' || payload.action === 'receive') {
        startChildProcess.bind(this)(callback);

    /* Estimate */
    } else if (payload.action === 'estimate') {
        estimate.bind(this)(callback);

    /* Switch helper functions */
    } else if (payload.action === 'remove-sync-snapshots') {
        removeSyncSnapshots.bind(this)(callback);
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
