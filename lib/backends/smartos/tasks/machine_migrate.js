/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

var child_process = require('child_process');
var fs = require('fs');
var util = require('util');

var assert = require('assert-plus');
var once = require('once');
var vasync = require('vasync');
var VError = require('verror').VError;

var Task = require('../../../task_agent/task');

var SNAPSHOT_NAME_PREFIX = 'vm-migration-';

var gExecFileDefaults = {
    // The default maxBuffer for child_process.execFile is 200Kb, we use a much
    // larger value in our execFile calls.
    maxBuffer: 50 * 1024 * 1024,
    // Set timeout for zfs calls.
    timeout: 15 * 60 * 1000
};

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


function getFilesystemDetails(callback) {
    var self = this;

    var log = self.log;
    var payload = self.req.params;

    assert.object(payload, 'payload');
    assert.object(payload.vm, 'payload.vm');

    var vm = payload.vm;

    var cmd = '/usr/sbin/zfs';
    var args = [
        'list',
        '-Hp',
        '-o',
        'quota,reservation',
        vm.zfs_filesystem
    ];

    log.debug({cmd: cmd, args: args}, 'getFilesystemDetails');

    child_process.execFile(cmd, args, gExecFileDefaults,
            function _execZfsListQuotaCb(err, stdout, stderr) {
        if (err) {
            log.error('zfs list error:', err, ', stderr:', stderr);
            self.fatal(new zfsError('zfs list failure', err, stderr));
            return;
        }

        // Note that we are leaving these numbers as strings.
        var values = stdout.trim().split('\t');
        var result = {
            quotaStr: values[0],
            reservationStr: values[1]
        };

        log.debug('getFilesystemDetails:: result:', result);
        self.finish(result);
    });
}


function removeZfsQuota(callback) {
    var self = this;

    var log = self.log;
    var payload = self.req.params;

    assert.object(payload, 'payload');
    assert.object(payload.vm, 'payload.vm');

    var vm = payload.vm;

    var cmd = '/usr/sbin/zfs';
    var args = [
        'set',
        'quota=none',
        vm.zfs_filesystem
    ];

    log.debug({cmd: cmd, args: args}, 'removeZfsQuota');

    child_process.execFile(cmd, args, gExecFileDefaults,
            function _execZfsSetQuotaCb(err, stdout, stderr) {
        if (err) {
            log.error('zfs set error:', err, ', stderr:', stderr);
            self.fatal(new zfsError('zfs set failure', err, stderr));
            return;
        }

        self.finish();
    });
}


function restoreZfsQuota(callback) {
    var self = this;

    var log = self.log;
    var payload = self.req.params;

    assert.object(payload, 'payload');
    assert.object(payload.vm, 'payload.vm');
    assert.string(payload.vm.zfs_filesystem, 'payload.vm.zfs_filesystem');

    var vm = payload.vm;

    // Determine what the current reservation size is, then set the
    // zfs filesystem quota to that value. For bhyve, quota and
    // reservation typically have the same value. Earlier we relaxed
    // the quota to allow snapshots to take extra space. Now restore
    // quota to its previous value, which is found in reservation.
    vasync.pipeline({arg: {}, funcs: [
        function getReservationSize(ctx, next) {
            var cmd = '/usr/sbin/zfs';
            var args = [
                'list',
                '-Hp',
                '-o',
                'reservation',
                vm.zfs_filesystem
            ];

            log.debug({cmd: cmd, args: args}, 'restoreZfsQuota');

            child_process.execFile(cmd, args, gExecFileDefaults,
            function _execZfsListReservationSizeCb(err, stdout, stderr) {
                if (err) {
                    log.error('zfs list error:', err, ', stderr:', stderr);
                    next(new zfsError('zfs list failure', err, stderr));
                    return;
                }

                ctx.quotaStr = stdout.trim();
                next();
            });
        },

        function setQuota(ctx, next) {
            var cmd = '/usr/sbin/zfs';
            var args = [
                'set',
                'quota=' + ctx.quotaStr,
                vm.zfs_filesystem
            ];

            log.debug({cmd: cmd, args: args}, 'setQuota');

            child_process.execFile(cmd, args, gExecFileDefaults,
                    function _execZfsSetQuotaCb(err, stdout, stderr) {
                if (err) {
                    log.error('zfs set error:', err, ', stderr:', stderr);
                    next(new zfsError('zfs set failure', err, stderr));
                    return;
                }

                next();
            });
        }
    ]}, function _pipelineCb(err) {
        if (err) {
            self.fatal(err);
            return;
        }

        self.finish();
    });
}


function setCreateTimestamp(callback) {
    var self = this;

    var log = self.log;
    var payload = self.req.params;

    assert.object(payload, 'payload');
    assert.object(payload.vm, 'payload.vm');
    assert.string(payload.vm.create_timestamp, 'payload.vm.create_timestamp');
    assert.uuid(payload.vm_uuid, 'payload.vm_uuid');

    var cmd = '/usr/sbin/zonecfg';
    var args = [
        '-z',
        payload.vm_uuid,
        util.format('select attr name=create-timestamp; set value=%s; end;',
            payload.vm.create_timestamp)
    ];

    log.debug({cmd: cmd, args: args}, 'setCreateTimestamp');

    child_process.execFile(cmd, args, gExecFileDefaults,
            function _execZonecfgSetTimestampCb(err, stdout, stderr) {
        if (err) {
            log.error('zonecfg error:', err, ', stderr:', stderr);
            self.fatal(new zfsError('zonecfg failure', err, stderr));
            return;
        }

        log.debug('setCreateTimestamp:: success');
        self.finish();
    });
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

    log.debug({cmd: cmd, args: args}, 'deleteSnapshot');

    child_process.execFile(cmd, args, gExecFileDefaults,
            function _execZfsDestroySnapshotCb(err, stdout, stderr) {
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

    function estimateOneDataset(dataset, cb) {
        var cmd = '/usr/sbin/zfs';
        var args = [
            'list',
            '-p', // computer parseable
            '-r', // recursive
            '-H', // no headers
            '-o', 'usedds',
            dataset
        ];

        log.info({cmd: cmd, args: args}, 'getEstimate');

        child_process.execFile(cmd, args, gExecFileDefaults,
                function _execZfsSendEstimateCb(error, stdout, stderr) {
            if (error) {
                log.error('zfs list error:', error, ', stderr:', stderr);
                cb(zfsError('zfs list error', error, stderr));
                return;
            }

            var size = 0;
            var lines = stdout.trim().split('\n');

            lines.map(function _estimateLine(line) {
                size += parseInt(line, 10) || 0;
            });

            log.debug({dataset: dataset, estimate: size}, 'getEstimate');

            estimatedSize += size;

            cb();
        });
    }

    vasync.forEachParallel({inputs: datasets, func: estimateOneDataset},
            function _onEstimateComplete(err) {
        if (err) {
            log.error('estimate failure', err);
            self.fatal(err);
            return;
        }

        var result = {
            size: estimatedSize
        };
        self.finish(result);
    });
}


function _mountFilesystem(dataset, payload, log, callback) {
    var buf;
    var target_vm_uuid = payload.migrationTask.record.target_vm_uuid;
    var vm_uuid = payload.migrationTask.record.vm_uuid;

    // Check for override of the vm uuid. Note that performing an uuid override
    // is only supported in a non-production environment.
    if (vm_uuid !== target_vm_uuid) {
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
        buf = child_process.execFileSync(cmd, args, gExecFileDefaults);
    } catch (ex) {
        log.warn({cmd: cmd, args: args}, 'Could not run zfs mount:', ex);
        errorMsg = String(ex.stderr || buf);
        if (errorMsg.indexOf('filesystem already mounted') === -1) {
            callback(new Error(errorMsg));
            return;
        }
    }

    callback();
}

function setupFilesystem(callback) {
    var self = this;
    var log = self.log;
    var payload = self.req.params;

    assert.object(payload, 'payload');
    assert.object(payload.vm, 'payload.vm');
    assert.string(payload.vm.zfs_filesystem, 'payload.vm.zfs_filesystem');
    assert.string(payload.vm.zonepath, 'payload.vm.zonepath');
    assert.optionalArrayOfObject(payload.vm.filesystems,
        'payload.vm.filesystems');
    assert.object(payload.migrationTask, 'payload.migrationTask');
    assert.uuid(payload.migrationTask.record.vm_uuid,
        'payload.migrationTask.record.vm_uuid');
    assert.uuid(payload.migrationTask.record.target_vm_uuid,
        'payload.migrationTask.record.target_vm_uuid');

    var dataset = payload.vm.zfs_filesystem;
    var vm = payload.vm;
    var volRegex = new RegExp('^' + vm.zonepath +
        '/volumes/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-' +
        '[a-f0-9]{4}-[a-f0-9]{12})$');

    var dockerSharedVolumes = vm.brand === 'lx' && vm.docker &&
        Array.isArray(vm.filesystems) &&
        vm.filesystems.filter(function _someFs(f) {
            if (f.type === 'lofs' && f.source && f.source.match(volRegex)) {
                return true;
            }
            return false;
        });

    // Mount the main zone dataset.
    _mountFilesystem(dataset, payload, log, function _onMountFs(err) {
        if (err) {
            self.fatal(err);
            return;
        }

        if (!Array.isArray(dockerSharedVolumes) ||
                dockerSharedVolumes.length === 0) {
            self.finish();
            return;
        }

        function setupDockerVolume(dockerVol, next) {
            assert.object(dockerVol, 'dockerVol');
            assert.string(dockerVol.source, 'dockerVol.source');
            // Handle docker shared volume lofs.
            //    "filesystems": [
            //      {
            //        "source": "/zones/$ZONE_UUID/volumes/$VOL_UUID",
            //        "target": "/data/configdb",
            //        "type": "lofs"
            //      },
            var zfsFs = dockerVol.source.replace(vm.zonepath,
                vm.zfs_filesystem);
            _mountFilesystem(zfsFs, payload, log, next);
        }

        // Mount the docker data volume(s).
        vasync.forEachParallel({inputs: dockerSharedVolumes,
                func: setupDockerVolume},
                function _setupDockerVolsCb(volErr) {
            if (volErr) {
                log.error('setupFilesystem docker mount failure:', volErr);
                self.fatal(volErr);
                return;
            }

            self.finish();
        });
    });
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

        child_process.execFile(cmd, args, gExecFileDefaults,
                function _execZfsListSnapshotsCb(err, stdout, stderr) {
            if (err) {
                log.error({cmd: cmd, args: args},
                    'Could not run zfs list:', err);
                next(new zfsError('zfs list failure', err, stderr));
                return;
            }
            // The 'name' variable will look like this:
            //    zones/36cf8056-47a0-63e4-80e2-a1b28cf396ab@vm-migration-3
            ctx.snapshots = stdout.trim().split('\n').filter(
                    function _filterEmptySnapshotNames(name) {
                var idx = name.indexOf('@');
                if (idx === -1) {
                    return false;
                }
                return name.substr(idx+1).startsWith(SNAPSHOT_NAME_PREFIX);
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
        buf = child_process.execFileSync(cmd, args, gExecFileDefaults);
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
        buf = child_process.execFileSync(cmd, args, gExecFileDefaults);
    } catch (ex) {
        log.warn({cmd: cmd, args: args}, 'Could not run vmadm update:', ex);
        this.fatal(String(ex.stderr || buf));
        return;
    }

    this.finish();
}


function setIndestructibleZoneroot(callback) {
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
        'indestructible_zoneroot=' + value
    ];

    var buf;

    log.debug({cmd: cmd, args: args}, 'setIndestructibleZoneroot');

    try {
        buf = child_process.execFileSync(cmd, args, gExecFileDefaults);
    } catch (ex) {
        log.warn({cmd: cmd, args: args}, 'Could not run vmadm update:', ex);
        this.fatal(String(ex.stderr || buf));
        return;
    }

    this.finish();
}


function setIndestructibleDelegated(callback) {
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
        'indestructible_delegated=' + value
    ];

    var buf;

    log.debug({cmd: cmd, args: args}, 'setIndestructibleDelegated');

    try {
        buf = child_process.execFileSync(cmd, args, gExecFileDefaults);
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

    /* Begin */
    } else if (payload.action === 'get-filesystem-details') {
        getFilesystemDetails.bind(this)(callback);
    } else if (payload.action === 'set-create-timestamp') {
        setCreateTimestamp.bind(this)(callback);

    /* Sync */
    } else if (payload.action === 'sync' || payload.action === 'receive') {
        startChildProcess.bind(this)(callback);
    } else if (payload.action === 'remove-zfs-quota') {
        removeZfsQuota.bind(this)(callback);
    } else if (payload.action === 'restore-zfs-quota') {
        restoreZfsQuota.bind(this)(callback);

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
    } else if (payload.action === 'set-indestructible-zoneroot') {
        setIndestructibleZoneroot.bind(this)(callback);
    } else if (payload.action === 'set-indestructible-delegated') {
        setIndestructibleDelegated.bind(this)(callback);
    } else {
        this.fatal('Unexpected payload.action: ' + payload.action);
    }
}
