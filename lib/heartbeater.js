/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var fs = require('fs');
var async = require('async');
var zfs = require('zfs').zfs;
var zpool = require('zfs').zpool;
var kstat = require('kstat');
var cp = require('child_process');
var vmadm = require('vmadm');
var imgadm = require('./imgadm');
var exec = cp.exec;
var spawn = cp.spawn;
var execFile = cp.execFile;
var Zone = require('tracker/lib/zone');
var sprintf = require('sprintf').sprintf;
var EventEmitter = require('events').EventEmitter;
var events = require('events');
var util = require('util');
var assert = require('assert');


/**
 * `getMemoryInfo` was lifted from
 * https://github.com/joyent/smartos-live/blob/master/src/node_modules/system.js
 */
var systempages_reader = null;
var arcstats_reader = null;

/*
 * This function grabs some basic memory usage information via kstat.  It should
 * be called like:
 *
 *     getMemoryInfo(function (err, data) {
 *         // data will contain several memory properties if err is not set
 *     });
 *
 * values in the data object are in bytes for maximum accuracy.
 *
 */
function getMemoryInfo(callback)
{
    var arcstats_val, systempages_val;

    // Setup readers if we've not already done so.
    if (!arcstats_reader) {
        arcstats_reader = new kstat.Reader({ module: 'zfs',
            'class': 'misc', instance: 0, name: 'arcstats' });
    }
    if (!systempages_reader) {
        systempages_reader = new kstat.Reader({ module: 'unix',
            'class': 'pages', instance: 0, name: 'system_pages' });
    }

    // Get the latest values from kstat
    systempages_val = systempages_reader.read();
    arcstats_val = arcstats_reader.read();

    if (!systempages_val) {
        return callback(new Error('No value for system_pages.'));
    }
    if (!arcstats_val) {
        return callback(new Error('No value for arcstats.'));
    }
    if (!systempages_val.hasOwnProperty(0) ||
        !systempages_val[0].hasOwnProperty('data') ||
        !systempages_val[0].data.hasOwnProperty('availrmem') ||
        !systempages_val[0].data.hasOwnProperty('pagestotal')) {

        return callback(new Error('Invalid data returned for system_pages:'
            + JSON.stringify(systempages_val)));
    }
    if (!arcstats_val.hasOwnProperty(0) ||
        !arcstats_val[0].hasOwnProperty('data') ||
        !arcstats_val[0].data.hasOwnProperty('size')) {

        return callback(new Error('Invalid data returned for arcstats:'
            + JSON.stringify(arcstats_val)));
    }

    return callback(null, {
        'availrmem_bytes': (systempages_val[0].data.availrmem * 4096),
        'arcsize_bytes': arcstats_val[0].data.size,
        'total_bytes': (systempages_val[0].data.pagestotal * 4096)
    });
}


function StatusReporter(opts) {
    this.debug = !!process.env.DEBUG;
    this.max_interval = 60000;  // milliseconds frequency for doing full reload
    this.status_interval = 500;  // milliseconds frequency of sending msgs
    this.heartbeat_interval = 5000;  // milliseconds frequency of sending msgs

    this.throttle = false;

    // The boot time of the global zone
    this.boot_time = null;

    // This specifies whether the cache is dirty.  This could be because a zone
    // has changed state, or we've hit max_interval.  Either way, we'll reload
    // the list. readySample let us track if a new sample was just updated so
    // we know if we need to broadcast a new one to the secondary 'zone-event'
    // routing key
    this.isDirty = true;
    this.readySample = true;

    // The current sample is stored here and we lock the samplerLock while we're
    // updating so that we don't do two lookups at the same time.
    this.sample = null;
    this.samplerLock = false;

    // pingInterval sends a message
    // maxInterval ensures the msg is marked dirty every max_interval ms
    this.pingInterval = null;
    this.maxInterval = null;

    // this watcher watches whether /etc/zones has changed
    this.cfg_watcher = null;

    // this is the subprocess that watches for zone changes
    this.watcher = null;

    this.updateSampleAttempts = 0;
    this.updateSampleAttemptsMax = 10;

    this.log = opts.log;

    EventEmitter.call(this);
}

util.inherits(StatusReporter, EventEmitter);


StatusReporter.prototype.updateSample = function () {
    var self = this;
    var newSample = {};

    if (self.samplerLock) {
        self.updateSampleAttempts++;

        if (self.updateSampleAttempts === self.updateSampleAttemptsMax) {
            self.log.error(
                'Something bad happened: samplerLock was held for '
                + self.updateSampleAttemptsMax);
        }
        self.log.error(
            'samplerLock is still held, skipping update. Attempt #'
            + self.updateSampleAttempts);
        return;
    }

    self.updateSampleAttempts = 0;

    self.samplerLock = true;

    // set this now in case another update comes in while we're running.
    self.isDirty = false;
    var vms;

    async.series([
        function (cb) { // zone info
            var lookup_fields = [
                'brand',
                'cpu_cap',
                'do_not_inventory',
                'last_modified',
                'max_physical_memory',
                'owner_uuid',
                'quota',
                'state',
                'uuid',
                'zone_state',
                'zoneid',
                'zonename',
                'zonepath'
            ];

            vmadm.lookup(
                {}, {fields: lookup_fields, log: self.log},
                function (err, vmobjs)
            {
                var vmobj;
                var hbVm;
                var newStatus;


                if (err) {
                    self.log.error(
                        'unable update VM list: ' + err.message);
                    self.markDirty();
                    return cb(new Error('unable to update VM list.'));
                } else {
                    vms = {};
                    newSample.vms = {};

                    for (vmobj in vmobjs) {
                        vmobj = vmobjs[vmobj];
                        vms[vmobj.uuid] = vmobj;
                        if (!vmobj.do_not_inventory) {
                            hbVm = {
                                uuid: vmobj.uuid,
                                owner_uuid: vmobj.owner_uuid,
                                quota: vmobj.quota,
                                max_physical_memory: vmobj.max_physical_memory,
                                zone_state: vmobj.zone_state,
                                state: vmobj.state,
                                brand: vmobj.brand,
                                cpu_cap: vmobj.cpu_cap
                            };
                            newStatus = [
                                vmobj.zoneid ? vmobj.zoneid : '-',
                                vmobj.zonename,
                                vmobj.zone_state,
                                vmobj.zonepath,
                                vmobj.uuid,
                                vmobj.brand,
                                'excl',
                                vmobj.zoneid ? vmobj.zoneid : '-'
                            ];
                            if (vmobj.hasOwnProperty('last_modified')) {
                                // this is only conditional until all platforms
                                // we might run this heartbeater on support the
                                // last_modified property.
                                hbVm.last_modified = vmobj.last_modified;
                                newStatus.push(vmobj.last_modified);
                            }
                            newSample.vms[vmobj.uuid] = hbVm;
                        }
                    }

                    return cb();
                }
            });
        },
        function (cb) { // zpool info
            zpool.list(function (err, fields, lines) {
                if (err) {
                    self.log.error('zpool list error: ' + err);
                    return cb(err);
                }

                newSample.zpoolStatus = {};

                var getSpaceStats = function (line, callback) {
                    var pool = line[0];

                    newSample.zpoolStatus[pool] = {};

                    zfs.get(pool, [ 'used', 'available' ], true,
                        function (zfsError, props) {
                            if (zfsError) {
                                self.log.error('zfs get error: ' + zfsError);
                                return callback(zfsError);
                            }

                            if (!props[pool]) {
                                self.log.error({ props: props },
                                    'XXX props returned degenerate values');
                            }

                            newSample.zpoolStatus[pool].bytes_available
                                = parseInt(props[pool].available, 10);
                            newSample.zpoolStatus[pool].bytes_used
                                = parseInt(props[pool].used, 10);

                            return callback();
                        });
                };

                return (
                    async.each(lines, getSpaceStats,
                        function (forEachError) {
                        if (forEachError) {
                            self.log.error('zfs get error: ' + forEachError);
                            return cb(forEachError);
                        }

                        return cb();
                    }));
            });
        },
        function (cb) { // meminfo
            getMemoryInfo(function (err, meminfo) {
                if (!err && meminfo) {
                    newSample.meminfo = meminfo;
                    return cb();
                } else {
                    self.log.warn('unable to get memory info:'
                        + JSON.stringify(err));
                    return cb(err);
                }
            });
        },
        function (cb) { // diskinfo
            self.gatherDiskUsage(vms, function (err, diskinfo) {
                if (!err && diskinfo) {
                    newSample.diskinfo = diskinfo;
                    return cb();
                } else {
                    self.log.warn('unable to get disk info:'
                        + JSON.stringify(err));
                    return cb(err);
                }
            });
        },
        function (cb) { // timestamp
            newSample.boot_time = self.boot_time;
            newSample.timestamp = new Date().toISOString();
            cb();
        }
        ], function (err) {
            if (err) {
                self.log.error(err.message);
            } else {
                self.sample = newSample;
                self.readySample = true;
            }

            self.emit('status', self.sample);
            self.samplerLock = false;
        });
};


StatusReporter.prototype.markDirty = function () {
    var self = this;
    self.isDirty = true;
};


/**
 * 1) the sum of the disk used by the kvm VMs' zvols' volsizes
 * 2) the sum of the maximum capacity of VMs' zvols
 * 3) the sum of the quotas for kvm VMs (this space has a different usage
 *     pattern from zone's quotas)
 * 4) the sum of the quotas for non-kvm VMs
 * 5) the sum of the cores quotas for all VMs of all brands
 * 6) the sum of the disk used by images installed on the CN
 * 7) the total size of the pool
 * 8) the 'system space' which would be the total size of the pool minus
 *    the sum of the other numbers here and include things like the files
 *    in /opt, kernel dumps, and anything else written that's not part of
 *    the above.
 */

StatusReporter.prototype.gatherDiskUsage = function (vms, callback) {
    var self = this;
    var usage = {
        kvm_zvol_used_bytes: 0,
        kvm_zvol_volsize_bytes: 0,
        kvm_quota_bytes: 0,
        kvm_quota_used_bytes: 0,
        zone_quota_bytes: 0,
        zone_quota_used_bytes: 0,
        cores_quota_bytes: 0,
        cores_quota_used_bytes: 0,
        installed_images_used_bytes: 0,
        pool_size_bytes: 0,
        pool_alloc_bytes: 0,
        system_used_bytes: 0
    };

    var datasets = {};

    function toInt(val) {
        var a = parseInt(val, 10);
        return (isNaN(a) ? 0 : a);
    }

    async.waterfall([
        function (cb) {
            zfs.get(
                null, // Look up properties for *all* datasets
                [ 'name', 'used', 'avail', 'refer', 'type', 'mountpoint',
                'quota', 'origin', 'volsize'],
                true, // Parseable
                function (geterr, props) {
                    if (geterr) {
                        cb(geterr);
                        return;
                    }

                    datasets = props;
                    cb();
            });
        },
        function (cb) {
            var vm;

            async.each(Object.keys(vms), function (uuid, fecb) {
                Zone.get(uuid, function (error, zone) {
                    if (error) {
                        self.log.error(
                            'Error looking up zone ' + uuid + ' by uuid '
                            + error.message + '\n'
                            + error.stack);
                        fecb();
                        return;
                    }

                    vm = vms[uuid];

                    // #1,2
                    if (vm.brand === 'kvm') {
                        var devices = zone.devices;
                        var device;

                        for (var deviceIdx in devices) {
                            device = devices[deviceIdx];

                            var match = device['match'];
                            var rdskpath = '/dev/zvol/rdsk/';
                            var rdskpathlen = rdskpath.length;
                            var ds = match.slice(rdskpathlen);

                            if (datasets.hasOwnProperty(ds)) {
                                usage.kvm_zvol_used_bytes +=
                                    toInt(datasets[ds].used);
                                usage.kvm_zvol_volsize_bytes +=
                                    toInt(datasets[ds].volsize);
                            }
                        }

                        // #3
                        if (datasets.hasOwnProperty(vm.zonepath.slice(1))) {
                            usage.kvm_quota_bytes += toInt(
                                datasets[vm.zonepath.slice(1)].quota);
                            usage.kvm_quota_used_bytes += toInt(
                                datasets[vm.zonepath.slice(1)].used);
                        }
                    } else {
                        // #4
                        if (datasets.hasOwnProperty(vm.zonepath.slice(1))) {
                            usage.zone_quota_bytes += toInt(
                                datasets[vm.zonepath.slice(1)].quota);
                            usage.zone_quota_used_bytes += toInt(
                                datasets[vm.zonepath.slice(1)].used);
                        }
                    }

                    // #5
                    var coreds = datasets[vm.zonepath.slice(1) + '/cores'] ||
                        datasets['zones/cores/' + vm.uuid];
                    if (coreds) {
                        usage.cores_quota_bytes += toInt(coreds.quota);
                        usage.cores_quota_used_bytes += toInt(coreds.used);
                    }

                    fecb();
                });
            },
            function (error) {
                cb(error);
            });
        },
        function (cb) {
            // #6
            // Sum installed images 'used' values

            async.forEachSeries(
                Object.keys(datasets),
                onDataset,
                onDatasetsDone);

            function onDatasetsDone(err) {
                cb(err);
            }

            function onDataset(dataset, _next) {
                // Guard against us blowing up the stack (AGENT-1072)
                var next = function (err) {
                    setImmediate(function (_err) {
                        _next(_err);
                    }, err);
                };

                // Eliminate snapshots and sub-filesystems
                var UUID_RE = '([0-9a-f]{8}-[0-9a-f]{4}-' +
                              '[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-' +
                              '[0-9a-f]{12})';

                var datasetReStr = '^([^/]+)/' + UUID_RE + '$';
                var match = dataset.match(new RegExp(datasetReStr));
                if (!match) {
                    next();
                    return;
                }

                // Check if UUID corresponds to that of an installed image
                var datasetUuid = match[2];

                self.log.trace(
                    { uuid: datasetUuid },
                    'quickGetImage');
                imgadm.quickGetImage({
                    uuid: datasetUuid,
                    log: self.log
                }, function (err, manifest) {
                    if (err && err.code === 'ImageNotInstalled') {
                        next();
                        return;
                    } else if (err) {
                        self.log.error({
                            uuid: datasetUuid, err: err },
                            'quickGetImage');
                        next();
                        return;
                    }

                    /*
                     * If we used "imgadm get" we might get a dummy result for
                     * a random UUID-named dataset. We can't easily tell whether
                     * it's really an image (in the Bad Old Days no metadata was
                     * really required), so if it has nothing but a uuid in its
                     * manifest, skip it.
                     *
                     * It's better to miss one or two images here (they'll still
                     * get counted against provisionable space by DAPI, just as
                     * system_used instead) than to double-count real VMs
                     * (which could make this box un-provisionable).
                     */
                    var keys = Object.keys(manifest);
                    if (keys.length === 1 && keys[0] === 'uuid') {
                        next();
                        return;
                    }

                    // Tally bytes used
                    usage.installed_images_used_bytes
                        += toInt(datasets[dataset].used);

                    next();
                });
            }
        },
        function (cb) {
            // #7
            var poolds = datasets['zones'];
            usage.pool_alloc_bytes = toInt(poolds.used);
            usage.pool_size_bytes = toInt(poolds.used) +
                toInt(poolds.available);

            // #8
            // All separated usages should be subtracted from the allocated
            // here. Anything not specifically listed is treated as 'system
            // space'.
            usage.system_used_bytes = usage.pool_alloc_bytes - (
                usage.kvm_zvol_used_bytes +
                usage.kvm_quota_used_bytes +
                usage.zone_quota_used_bytes +
                usage.cores_quota_used_bytes +
                usage.installed_images_used_bytes);

            cb();
        }
    ],
    function (error) {
        if (error) {
            self.log.warn(error.message);
        }
        callback(null, usage);
    });
};


/**
 * Run a command via `spawn` and callback with the results a la `execFile`.
 *
 * @param args {Object}
 *      - argv {Array} Required.
 *      - log {Bunyan Logger} Required. Use to log details at trace level.
 *      - opts {Object} Optional `child_process.spawn` options.
 * @param cb {Function} `function (err, stdout, stderr)` where `err` here is
 *      an `errors.InternalError` wrapper around the child_process error.
 */
function spawnRun(args, cb) {
    assert.ok(args, 'args');
    assert.ok(args.argv, 'args.argv');
    assert.ok(args.argv.length > 0, 'argv has at least one arg');
    assert.ok(args.log, 'args.log');
    assert.ok(cb);

    args.log.trace({exec: true, argv: args.argv}, 'exec start');
    var child = spawn(args.argv[0], args.argv.slice(1), args.opts);

    var stdout = [];
    var stderr = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', function (chunk) { stdout.push(chunk); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', function (chunk) { stderr.push(chunk); });

    child.on('close', function spawnClose(code, signal) {
        stdout = stdout.join('');
        stderr = stderr.join('');
        args.log.trace({exec: true, argv: args.argv, code: code,
            signal: signal, stdout: stdout, stderr: stderr}, 'exec done');
        if (code || signal) {
            var msg = util.format(
                'spawn error:\n'
                + '\targv: %j\n'
                + '\texit code: %s\n'
                + '\texit signal: %s\n'
                + '\tstdout:\n%s\n'
                + '\tstderr:\n%s',
                args.argv, code, signal, stdout.trim(), stderr.trim());
            cb(new Error(msg), stdout, stderr);
        } else {
            cb(null, stdout, stderr);
        }
    });
}


StatusReporter.prototype.startZoneWatcher = function () {
    var self = this;
    this.watcher = spawn('/usr/vm/sbin/zoneevent', []);
    self.log.info('zoneevent running with pid ' + self.watcher.pid);
    this.watcher.stdout.on('data', function (data) {
        // If we cared about the data here, we'd parse it (JSON) but we just
        // care that *something* changed, not what it was so we always just
        // mark our sample dirty when we see any changes.  It's normal to
        // see multiple updates ('C's) for one zone action.
//         process.stdout.write('C');
        self.markDirty();
    });
    this.watcher.stdin.end();

    this.watcher.on('exit', function (code) {
        self.log.warn('zoneevent watcher exited.');
        self.watcher = null;
    });
};

StatusReporter.prototype.startZoneConfigWatcher = function () {
    var self = this;
    self.cfg_watcher = fs.watch('/etc/zones', function (evt, file) {
        self.markDirty();
    });
    self.log.info('start fs.watch() for /etc/zones');
};


StatusReporter.prototype.checkEmitStatus = function () {
    var self = this;

    if (self.isDirty && !self.throttle) {
        self.throttle = true;
        setTimeout(function () {
            self.throttle = false;
        }, 5000);
        self.updateSample();
    }

    if (!self.sample) {
        self.log.warn('no sample');
    }
};


StatusReporter.prototype.emitHeartbeat = function () {
    var self = this;
    self.emit('heartbeat');
};


StatusReporter.prototype.getBootTime = function (callback) {
    var self = this;

    execFile(
        '/usr/bin/kstat',
        [ '-p', '-m', 'unix', '-n', 'system_misc', '-s', 'boot_time'],
        function (error, stdout, stderr) {
            if (error) {
                throw error;
            }
            self.boot_time = new Date(
                parseInt(stdout.toString().split(/\s+/)[1], 10) * 1000)
                    .toISOString();
            callback();
        });
};


StatusReporter.prototype.start = function () {
    var self = this;

    self.startZoneWatcher();
    self.startZoneConfigWatcher();

    self.getBootTime(function () {
        // every max_interval we force an update but we send the state to the
        // best of our knowledge every status_interval ms.
        self.maxInterval = setInterval(
            self.markDirty.bind(self), self.max_interval);
        self.pingInterval = setInterval(
            self.checkEmitStatus.bind(self), self.status_interval);
        self.hbInterval = setInterval(
            self.emitHeartbeat.bind(self), self.heartbeat_interval);
    });
};


module.exports = StatusReporter;
