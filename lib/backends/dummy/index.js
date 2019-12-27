/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

var netconfig = require('triton-netconfig');

var assert = require('assert-plus');
var jsprim = require('jsprim');

var backends_common = require('../common');
var common = require('./common');
var sysinfoGetter = require('./lib/sysinfo');

// These are used for caching the results of mdata-get so we don't need to
// re-run that for every server when we have multiple servers.
var cachedDatacenterName;
var cachedDNSDomain;


// This defines which tasks we'll handle.
var queueDefns = [
    {
        name: 'machine_creation',
        tasks: [ 'machine_create', 'machine_reprovision' ]
    },
    {
        name: 'image_import_tasks',
        tasks: [ 'image_ensure_present' ]
    },
    {
        name: 'machine_tasks',
        tasks: [
            'machine_boot',
            'machine_create_snapshot',
            'machine_delete_snapshot',
            'machine_destroy',
            'machine_kill',
            'machine_reboot',
            'machine_rollback_snapshot',
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
    },
    {
        name: 'agents_tasks',
        maxConcurrent: 1,
        tasks: [
            'agent_install',
            'agents_uninstall',
            'refresh_agents'
        ]
    },
    {
        name: 'server_tasks',
        tasks: [
            'command_execute',
            'server_reboot',
            'server_sysinfo',
            'server_update_nics',
            'recovery_config'
        ]
    }
];


function DummyBackend(opts) {
    var self = this;

    assert.object(opts.log, 'opts.log');
    assert.optionalUuid(opts.serverUuid, 'opts.serverUuid');

    self.log = opts.log;
    self.name = opts.backendName;
    self.queueDefns = queueDefns;

    // This is only passed when we're handling for a single server. If there are
    // multiple servers, the opts.serverUuid should be passed in to the
    // backend.* functions.
    self.serverUuid = opts.serverUuid;
}


DummyBackend.prototype.getAgentConfig =
function getAgentConfig(opts, callback) {
    var config = {
        no_rabbit: true
    };

    callback(null, config);
};

DummyBackend.prototype.getSdcConfig = function getSdcConfig(_, callback) {
    common.getSdcConfig(callback);
};

DummyBackend.prototype.getSysinfo = function getSysinfo(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.serverAddress, 'opts.serverAddress');
    assert.optionalUuid(opts.serverUuid, 'opts.serverUuid');

    var self = this;
    var serverUuid = opts.serverUuid || self.serverUuid;

    var getter = new sysinfoGetter();

    getter.get({
        serverAddress: opts.serverAddress,
        serverUuid: serverUuid
    }, function _onSysinfo(err, sysinfo) {
        callback(err, sysinfo);
    });
};

// This will call callback() every time sysinfo has changed.
DummyBackend.prototype.watchSysinfo = function watchSysinfo(opts, callback) {
    assert.func(callback, 'callback');
    assert.object(opts, 'opts');
    assert.optionalUuid(opts.serverUuid, 'opts.serverUuid');

    var self = this;
    var getter = new sysinfoGetter();
    var serverUuid = opts.serverUuid || self.serverUuid;

    var watcher = new backends_common.SysinfoFileWatcher({
        callback: callback,
        filename: getter.filename({serverUuid: serverUuid}),
        log: self.log
    });

    watcher.watch();
};


function _getAdminIpSysinfo(sysinfo_object, callback) {
    var adminIp = netconfig.adminIpFromSysinfo(sysinfo_object);

    if (!adminIp) {
        callback(new Error('Could not find admin IP'));
        return;
    }

    callback(null, adminIp);
}

DummyBackend.prototype.getFirstAdminIp = function getFirstAdminIp(opts, sysinfo,
    callback) {

    if (!callback) {
        callback = sysinfo;
        this.getSysinfo({
            serverAddress: {}, // don't need serverAddress, just want Admin IP
            serverUuid: opts.serverUuid // might be undefined, that's ok
        }, function (err, sysinfoObj) {
            if (err) {
                callback(err);
                return;
            }

            _getAdminIpSysinfo(sysinfoObj, callback);
        });
        return;
    }
    _getAdminIpSysinfo(sysinfo, callback);
};

DummyBackend.prototype.getMemoryInfo = function getMemoryInfo(opts, callback) {
    // TODO: implement something here
    callback(null, {
        availrmem_bytes: 256 * 1024 * 1024 * 1024,
        arcsize_bytes: 42,
        total_bytes: 256 * 1024 * 1024 * 1024
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

    var spaceStats = {};

    // TODO: implement something here
    spaceStats = {
        bytes_available: 3 * 1024 * 1024 * 1024 * 1024,
        bytes_used: 42
    };

    callback(null, spaceStats);
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

    var pool = 'zones';
    var zpoolStatus = {};

    getPoolSpaceStats(pool, opts, function _onSpaceStats(err, ss) {
        if (err) {
            callback(err);
            return;
        }

        zpoolStatus[pool] = ss;
        callback(err, zpoolStatus);
    });
}


DummyBackend.prototype.getZpoolInfo = function _getZpoolInfo(opts, callback) {
    var self = this;
    var serverUuid = opts.serverUuid || self.serverUuid;

    assert.object(self.log, 'self.log');

    getZpoolInfo({
        log: self.log,
        serverUuid: serverUuid
    }, function onPoolInfo(err, info) {
        if (err) {
            callback(err);
            return;
        }
        callback(null, info);
    });
};


DummyBackend.prototype.getDiskUsage =
function getDiskUsage(vms, opts, callback) {
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


DummyBackend.prototype.getBootTime = function getBootTime(opts, callback) {
    var self = this;
    var getter = new sysinfoGetter();
    var serverUuid = opts.serverUuid || self.serverUuid;

    getter.get({
        serverAddress: {}, // Don't need server addr to just get Boot Time
        serverUuid: serverUuid
    }, function _onSysinfo(err, sysinfo) {
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
DummyBackend.prototype.loadVms = function loadVms(opts, callback) {
    var vms = []; // would be an array of VM objects limited to opts.fields

    callback(null, vms);
};


// Loads information about the agents on this mock CN.
//
// opts must contain:
//
//  serverUuid -- the UUID of the CN
//
// data will be loaded and callback will be called with:
//
//  callback(err, agents);
//
// where on failure `err` will be an Error object. On success, `err` will be
// null and `agents` will be an array of agents that looks like:
//
//  [
//      {
//          "image_uuid": "<image_uuid>",
//          "name": "net-agent",
//          "uuid": "<instance_uuid>",
//          "version": "2.2.0"
//      },
//      ...
//  ]
//
DummyBackend.prototype.getAgents = function getAgents(opts, callback) {
    assert.object(opts, 'opts');
    assert.uuid(opts.serverUuid, 'opts.serverUuid');

    common.getAgents(opts, callback);
};


// Dummy needs no watchers, other backends would start watching whatever they
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
DummyBackend.prototype.startWatchers = function startWatchers(opts) {
    // TODO: fs.watch the instance JSON dir
};


// This will never actually be called unless we returned watchers from
// startWatchers. In that case, we'll get passed the object we returned there
// and be expected to stop any watchers we created.
DummyBackend.prototype.stopWatchers = function stopWatchers(watchers) {
};


module.exports = DummyBackend;
