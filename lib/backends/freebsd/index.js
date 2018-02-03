/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */


/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var execFile = require('child_process').execFile;
var fs = require('fs');
var os = require('os');
var path = require('path');

var assert = require('assert-plus');
var jsprim = require('jsprim');
var uuid = require('uuid');
var vasync = require('vasync');
var zfs = require('zfs').zfs;
var zpool = require('zfs').zpool;

var sysinfoGetter = require('./lib/sysinfo');


// This defines which tasks we'll handle.
var queueDefns = [
    {
        name: 'machine_creation',
        tasks: [ 'machine_create' ]
    },
    {
        name: 'image_import_tasks',
        tasks: [ 'image_ensure_present' ]
    },
    {
        name: 'machine_tasks',
        tasks: [
            'machine_boot',
            'machine_destroy',
            'machine_kill',
            'machine_reboot',
            'machine_shutdown',
            'machine_update'
        ]
    },
    {
        name: 'machine_query',
        logging: false,
        tasks: [
            'machine_load'
        ]
    },
    {
        name: 'nop',
        tasks: [ 'nop' ]
    }
];


function FreebsdBackend(opts) {
    var self = this;

    self.log = opts.log;
    self.name = opts.backendName;
    self.queueDefns = queueDefns;
}


FreebsdBackend.prototype.getAgentConfig = function getAgentConfig(callback) {
    var config = {
        no_rabbit: true,
        skip_agents_update: true
    };

    callback(null, config);
};


FreebsdBackend.prototype.getSdcConfig = function getSdcConfig(callback) {
    fs.readFile('/opt/smartdc/etc/config.json', function _onRead(err, data) {
        var config = {};

        if (err && err.code === 'ENOENT') {
            callback(null, config);
            return;
        }

        assert.ifError(err, 'should be able to load config.json');

        // This will throw if JSON is bad
        config = JSON.parse(data);

        assert.object(config, 'config');
        assert.optionalString(config.datacenter_name, 'config.datacenter_name');
        assert.optionalString(config.dns_domain, 'config.dns_domain');

        // XXX nic_tags exists to work around the lack of network configuration
        // for now, we'll not include it in the config, since we don't want
        // anything other than sysinfo to depend on it.
        delete config.nic_tags;

        callback(null, config);
    });
};


FreebsdBackend.prototype.getSysinfo = function getSysinfo(callback) {
    var getter = new sysinfoGetter();

    getter.get({}, function _onSysinfo(err, sysinfo) {
        callback(err, sysinfo);
    });
};


FreebsdBackend.prototype.getMemoryInfo = function getMemoryInfo(callback) {
    execFile('/sbin/sysctl', ['-n',
        'kstat.zfs.misc.arcstats.size'
    ], function onSysctl(error, stdout, stderr) {
        if (error) {
            callback(error);
            return;
        }

        callback(null, {
            availrmem_bytes: os.freemem(),
            arcsize_bytes: jsprim.parseInteger(stdout.trim(), {}),
            total_bytes: os.totalmem()
        });
    });
};

// getPoolSpaceStats() calls:
//
//  callback(err, spaceStats)
//
// where spaceStats looks like:
//
//  {
//      bytes_available: <number>,
//      bytes_used: <number>
//  }
//
// NOTE: this function is used by getZpoolInfo and not exported itself.
//
function getPoolSpaceStats(pool, opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');

    var log = opts.log;
    var spaceStats = {};

    zfs.get(pool, ['used', 'available'], true, function _onGet(err, props) {
        if (err) {
            log.error({err: err}, 'zfs get error');
            callback(err);
            return;
        }

        if (!props[pool]) {
            log.error({props: props},
                'XXX props returned degenerate values');
            callback(new Error('degenerate usage values returned for ' +
                'zpool ' + pool));
            return;
        }

        spaceStats = {
            bytes_available: parseInt(props[pool].available, 10),
            bytes_used: parseInt(props[pool].used, 10)
        };

        callback(null, spaceStats);
    });
}

// getZpoolInfo() calls:
//
//  callback(err, zpoolStatus)
//
// where zpoolStatus looks like:
//
//  {
//      <pool_name>: {
//          bytes_available,
//          bytes_used
//      }
//  }
//
function getZpoolInfo(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');

    var log = opts.log;
    var zpoolStatus = {};

    zpool.list(function _onZpoolList(zpoolListErr, _, lines) {
        if (zpoolListErr) {
            log.error({err: zpoolListErr}, 'zpool list error');
            callback(zpoolListErr);
            return;
        }

        vasync.forEachParallel({
            inputs: lines,
            func: function _getSpaceStats(poolinfo, cb) {
                var pool = poolinfo[0];

                getPoolSpaceStats(pool, opts, function _onSpaceStats(err, ss) {
                    if (err) {
                        cb(err);
                        return;
                    }

                    zpoolStatus[pool] = ss;
                    cb();
                });
            }
        }, function _afterSpaceStats(err) {
            callback(err, zpoolStatus);
        });
    });
}


FreebsdBackend.prototype.getZpoolInfo = function _getZpoolInfo(callback) {
     var self = this;

    getZpoolInfo({log: self.log}, function onPoolInfo(err, info) {
        if (err) {
            callback(err);
            return;
        }
        callback(null, info);
    });
};


FreebsdBackend.prototype.getDiskUsage = function getDiskUsage(vms, callback) {
    // XXX implement this

    var diskUsage = {
        kvm_zvol_used_bytes: 0,
        kvm_zvol_volsize_bytes: 0,
        kvm_quota_bytes: 0,
        kvm_quota_used_bytes: 0,
        zone_quota_bytes: 0,
        zone_quota_used_bytes: 0,
        cores_quota_bytes: 0,
        cores_quota_used_bytes: 0,
        installed_images_used_bytes: 0,
        pool_size_bytes: 1024 * 1024 * 1024 * 1024,
        pool_alloc_bytes: 512 * 1024 * 1024 * 1024,
        system_used_bytes: 256 * 1024 * 1024
    };

    callback(null, diskUsage);
};


FreebsdBackend.prototype.getBootTime = function getBootTime(callback) {
    var getter = new sysinfoGetter();

    getter.get({}, function _onSysinfo(err, sysinfo) {
        var epochTime = jsprim.parseInteger(sysinfo['Boot Time'], {});
        callback(err, new Date(epochTime * 1000).toISOString());
    });
};


// opts will have:
//
//  {
//    fields: <array of field names to include in objects>,
//    log: <bunyan logger>,
//  }
FreebsdBackend.prototype.loadVms = function loadVms(opts, callback) {
    var vms = []; // would be an array of VM objects limited to opts.fields

    callback(null, vms);
};


// Freebsd needs no watchers, other backends would start watching whatever they
// need in the filesystem/system and whenever they decide something changed that
// might cause cn-agent's cache to be dirty, they should call dirtyFn() with no
// arguments. This will tell cn-agent to reload its data asap. Otherwise the
// change might not be noticed for up to a minute.
//
// opts will have:
//
//  {
//     dirtyFn: <function>,
//     log: <bunyan logger>
//  }
//
FreebsdBackend.prototype.startWatchers = function startWatchers(opts) {
    // TODO: fs.watch the instance JSON dir
};


// This will never actually be called unless we returned watchers from
// startWatchers. In that case, we'll get passed the object we returned there
// and be expected to stop any watchers we created.
FreebsdBackend.prototype.stopWatchers = function stopWatchers(watchers) {
};


module.exports = FreebsdBackend;
