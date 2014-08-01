var fs = require('fs');
var async = require('async');
var zfs = require('zfs').zfs;
var zpool = require('zfs').zpool;
var cp = require('child_process');
var exec = cp.exec;
var spawn = cp.spawn;
var execFile = cp.execFile;
var VM = require('VM');
var Zone = require('tracker/lib/zone');
var sprintf = require('sprintf').sprintf;
var system = require('/usr/node/node_modules/system');
var EventEmitter = require('events').EventEmitter;
var events = require('events');
var util = require('util');


function StatusReporter(opts) {
    this.debug = !!process.env.DEBUG;
    this.max_interval = 60000;  // milliseconds frequency for doing full reload
    this.ping_interval = 5000;  // milliseconds frequency of sending msgs

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

            VM.lookup({}, {fields: lookup_fields}, function (err, vmobjs) {
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

                            newSample.zpoolStatus[pool].bytes_available
                                = parseInt(props[pool].available, 10);
                            newSample.zpoolStatus[pool].bytes_used
                                = parseInt(props[pool].used, 10);

                            return callback();
                        });
                };

                return (
                    async.forEach(lines, getSpaceStats,
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
            system.getMemoryInfo(function (err, meminfo) {
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
 * 7) the total size of the pool (this we already have in here I believe)
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
        zone_quota_bytes: 0,
        cores_quota_bytes: 0,
        installed_images_used_bytes: 0,
        pool_size_bytes: 0
//         system_used_bytes: 0
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
                true, // Parseabe
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

            async.forEach(Object.keys(vms), function (uuid, fecb) {
                vm = vms[uuid];

                if (vm.brand === 'kvm') {
                    // #1,2
                    Zone.get(uuid, function (error, zone) {
                        if (error) {
                            self.log.error(
                                'Error looking up zone ' + uuid + ' by uuid'
                                + error.message + '\n'
                                + error.stack);
                            fecb();
                            return;
                        }

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

                        // #2
                        if (datasets.hasOwnProperty(vm.zonepath.slice(1))) {
                            usage.kvm_quota_bytes += toInt(
                                datasets[vm.zonepath.slice(1)].quota);
                        }
                        fecb();
                    });

                } else {
                    // #3
                    if (datasets.hasOwnProperty(vm.zonepath.slice(1))) {
                        usage.zone_quota_bytes += toInt(
                            datasets[vm.zonepath.slice(1)].quota);
                    }

                    // #4
                    var coreds = datasets[vm.zonepath.slice(1) + '/cores'] ||
                        datasets['zones/cores/' + vm.uuid];
                    if (coreds) {
                        usage.cores_quota_bytes +=
                            toInt(coreds.quota);
                    }

                    fecb();
                }
            },
            function (error) {
                cb(error);
            });
        },
        function (cb) {
            var vm;
            // #5
            // Determine which datasets in the zpool are 'installed' images
            // - must not be a vm's zonepath
            // - must not have an origin
            var imageDatasets = JSON.parse(JSON.stringify(datasets));
            var d;

            for (var vmuuid in vms) {
                vm = vms[vmuuid];

                for (d in datasets) {
                    // Delete zone-related zones
                    if (d.match('^' + vm.zonepath.slice(1) + '(/?.*$)?$')) {
                        delete imageDatasets[d];
                    }

                    // Delete zpool entries
                    if (d.indexOf('/') === -1) {
                        delete imageDatasets[d];
                    }

                    // Delete system datasets
                    if (['usbkey', 'var', 'swap', 'opt', 'dump', 'cores',
                            'config']
                            .indexOf(d.slice(d.indexOf('/')+1)) !== -1)
                    {
                        delete imageDatasets[d];
                    }

                    if (datasets[d].origin !== '-') {
                        delete imageDatasets[d];
                    }
                }
            }

            for (d in imageDatasets) {
                usage.installed_images_used_bytes
                    += toInt(datasets[d].used);
            }

            cb();
        },
        function (cb) {
            // #6
            zpool.list(
                'zones', { parseable: true, fields: ['size'] },
                function (error, fields, pools) {
                    if (error) {
                        cb(error);
                        return;
                    }
                    usage.pool_size_bytes = toInt(pools[0][0]);
                    cb();
                });
        }
    ],
    function (error) {
        if (error) {
            self.log.warn(error.message);
        }
        callback(null, usage);
    });
};


StatusReporter.prototype.startZoneWatcher = function () {
    var self = this;
    this.watcher = spawn('/usr/vm/sbin/zoneevent', []);
    self.log.info('zoneevent running with pid ' + self.watcher.pid);
    this.watcher.stdout.on('data', function (data) {
        // If we cared about the data here, we'd parse it (JSON) but we just
        // care that *something* changed, not what it was so we always just
        // mark our sample dirty when we see any changes.  It's normal to
        // see multiple updates ('C's) for one zone action.
        process.stdout.write('C');
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
        // When we get here something changed in /etc/zones and if that happens
        // it means that something has changed about one of the zones and in
        // turn it means that we need to recheck.
        process.stdout.write('c');
        self.markDirty();
    });
    self.log.info('start fs.watch() for /etc/zones');
};


StatusReporter.prototype.emitStatus = function () {
    var self = this;

    if (self.isDirty) {
        self.updateSample();
    }

    if (self.sample) {
        self.emit('status', self.sample);
    } else {
        self.log.warn('no sample');
    }
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
        // best of our knowledge every ping_interval ms.
        self.maxInterval = setInterval(
            self.markDirty.bind(self), self.max_interval);
        self.pingInterval = setInterval(
            self.emitStatus.bind(self), self.ping_interval);
    });
};


module.exports = StatusReporter;
