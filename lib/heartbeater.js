/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

var cp = require('child_process');
var events = require('events');
var EventEmitter = require('events').EventEmitter;
var util = require('util');

var assert = require('assert-plus');
var vasync = require('vasync');


// These are the fields we'll load for VMs
var VM_LOOKUP_FIELDS = [
    'brand',
    'cpu_cap',
    'disks',
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


function StatusReporter(opts) {
    this.debug = !!process.env.DEBUG;
    this.max_interval = 60000;  // milliseconds frequency for doing full reload
    this.status_interval = 500;  // milliseconds frequency of sending msgs

    assert.object(opts, 'opts');
    assert.object(opts.backend, 'opts.backend');

    this.throttle = false;

    // The backend provides the functions to get system-specific data for
    // status updates.
    this.backend = opts.backend;

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

    // this is the handle to the backend's watcher if it has one
    this.watcher = null;

    this.updateSampleAttempts = 0;
    this.updateSampleAttemptsMax = 10;

    this.log = opts.log;

    this.serverUuid = opts.serverUuid;

    EventEmitter.call(this);
}

util.inherits(StatusReporter, EventEmitter);


StatusReporter.prototype.updateSample = function () {
    var self = this;
    var newSample = {};
    var vms;

    if (self.samplerLock) {
        self.updateSampleAttempts++;

        if (self.updateSampleAttempts === self.updateSampleAttemptsMax) {
            self.log.error(
                'Something bad happened: samplerLock was held for '
                + self.updateSampleAttemptsMax);
        }
        self.log.error(
            'SamplerLock is still held, skipping update. Attempt #'
            + self.updateSampleAttempts);
        return;
    }

    self.updateSampleAttempts = 0;

    self.samplerLock = true;

    // set this now in case another update comes in while we're running.
    self.isDirty = false;

    vasync.pipeline({
        funcs: [
            function _getVmInfo(_, cb) {
                self.backend.loadVms({
                    fields: VM_LOOKUP_FIELDS,
                    log: self.log,
                    serverUuid: self.serverUuid
                }, function onLoadVms(err, vmobjs) {
                    var vmobj;

                    if (err) {
                        self.log.error({err: err}, 'Unable update VM list');
                        cb(new Error('Unable to update VM list.'));
                        return;
                    }

                    assert.arrayOfObject(vmobjs, 'vmobjs');

                    vms = {};
                    newSample.vms = {};

                    for (vmobj in vmobjs) {
                        vmobj = vmobjs[vmobj];
                        vms[vmobj.uuid] = vmobj;

                        if (!vmobj.do_not_inventory) {
                            newSample.vms[vmobj.uuid] = {
                                brand: vmobj.brand,
                                cpu_cap: vmobj.cpu_cap,
                                last_modified: vmobj.last_modified,
                                max_physical_memory: vmobj.max_physical_memory,
                                owner_uuid: vmobj.owner_uuid,
                                quota: vmobj.quota,
                                state: vmobj.state,
                                uuid: vmobj.uuid,
                                zone_state: vmobj.zone_state
                            };
                        }
                    }

                    cb();
                });
            }, function _getZpoolInfo(_, cb) {
                self.backend.getZpoolInfo({
                    serverUuid: self.serverUuid
                }, function onZpoolInfo(err, zpoolInfo) {
                    if (err) {
                        self.log.error({err: err}, 'Unable to get zpool info');
                        cb(err);
                        return;
                    }
                    newSample.zpoolStatus = zpoolInfo;
                    cb();
                });
            },
            function _getMemoryInfo(_, cb) {
                self.backend.getMemoryInfo({
                    serverUuid: self.serverUuid
                }, function onMemoryInfo(err, meminfo) {
                    if (err) {
                        self.log.warn({err: err}, 'Unable to get memory info');
                    } else {
                        newSample.meminfo = meminfo;
                    }
                    cb(err);
                });
            },
            function _getDiskUsage(_, cb) {
                self.backend.getDiskUsage(vms, {
                    serverUuid: self.serverUuid
                }, function onDiskUsage(err, diskusage) {
                    if (err) {
                        self.log.warn({err: err},
                            'Unable to get disk usage');
                    } else {
                        newSample.diskinfo = diskusage;
                    }
                    cb(err);
                });
            },
            function _getBootTime(_, cb) {
                self.backend.getBootTime({
                    serverUuid: self.serverUuid
                }, function onBootTime(err, boot_time) {
                    if (err) {
                        self.log.warn({err: err},
                            'Unable to get system boot time');
                    } else {
                        newSample.boot_time = boot_time;
                    }
                    cb(err);
                });
            }, function _getTimestamp(_, cb) {
                newSample.timestamp = new Date().toISOString();
                cb();
            }
        ]
    }, function onPipelineComplete(err) {
        self.samplerLock = false;

        if (err) {
            // mark as dirty so that we'll try again
            self.markDirty();
            self.log.error({err: err}, 'Failed to update sample');
        } else {
            self.sample = newSample;
            self.readySample = true;
            self.emit('status', self.sample);
        }
    });
};


StatusReporter.prototype.markDirty = function () {
    var self = this;
    self.isDirty = true;
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
        self.log.warn('No sample');
    }
};


StatusReporter.prototype.startWatchers = function startWatchers() {
    var self = this;

    self.watchers = self.backend.startWatchers({
        dirtyFn: self.markDirty.bind(self),
        log: self.log,
        serverUuid: self.serverUuid
    });
};


StatusReporter.prototype.stopWatchers = function stopWatchers() {
    var self = this;

    if (self.watchers) {
        self.backend.stopWatchers({
            serverUuid: self.serverUuid
        }, self.watchers);
    }
};


StatusReporter.prototype.start = function () {
    var self = this;

    self.startWatchers();

    // every max_interval we force an update but we send the state to the
    // best of our knowledge every status_interval ms.
    self.maxInterval = setInterval(
        self.markDirty.bind(self), self.max_interval);
    self.pingInterval = setInterval(
        self.checkEmitStatus.bind(self), self.status_interval);
};


module.exports = StatusReporter;
