/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

// node
var fs = require('fs');
var path = require('path');

// node_modules
var assert = require('assert-plus');
var vasync = require('vasync');
var vmadm = require('../lib/vmadm');

// local
var common = require('../common');
var Task = require('../../../task_agent/task');

var DISK_PAYLOAD = {
    image_name: true,
    image_size: true,
    image_uuid: true,
    refreservation: true,
    size: true
};
var NIC_PAYLOAD = {
    belongs_to_type: false,
    belongs_to_uuid: false,
    cn_uuid: false,
    created_timestamp: false,
    ip: true,
    mac: true,
    modified_timestamp: false,
    mtu: true,
    netmask: true,
    network_uuid: true,
    nic_tag: true,
    primary: true,
    resolvers: false,
    state: false,
    owner_uuid: false,
    vlan_id: true
};
var VM_PAYLOAD = {
    alias: true,
    archive_on_delete: true,
    billing_id: true,
    brand: true,
    cpu_cap: true,
    cpu_shares: true,
    cpu_type: true,
    customer_metadata: true,
    dataset_url: false,
    dataset_url_compression: false,
    disk_driver: true,
    disks: true,
    firewall_enabled: false,
    image: false,
    image_uuid: true,
    gpus: true,
    max_lwps: true,
    max_physical_memory: true,
    max_swap: true,
    nic_driver: true,
    nics: true,
    owner_uuid: true,
    server_uuid: true,
    quota: true,
    ram: true,
    resolvers: true,
    uuid: true,
    vcpus: true,
    zfs_io_priority: false
};


var MachineCreateTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineCreateTask);


function start(callback) {
    var self = this;

    assert.object(self.sysinfo, 'self.sysinfo');
    assert.uuid(self.sysinfo.UUID, 'self.sysinfo.UUID');

    var creationGuardFilename;

    vasync.pipeline({
        arg: {
            sysinfo: self.sysinfo
        },
        funcs: [
            function _doPrecheck(_, cb) {
                self.pre_check(function _afterPrecheck(err) {
                    if (err) {
                        self.fatal(err.message);
                        return;
                    }
                    cb();
                });
            },
            function _createProvisionLockFile(_, cb) {
                common.provisionInProgressFile(
                    self.req.params.uuid,
                    function _afterCreateLock(err, filename) {
                        creationGuardFilename = filename;
                        cb();
                        return;
                    });
            },
            self.ensure_dataset_present.bind(self),
            self.fetch_dataset.bind(self),
            self.build_payload.bind(self),
            self.create_machine.bind(self),
            function _deleteProvisionLockFile(_, cb) {
                fs.unlink(creationGuardFilename, function _afterUnlink(err) {
                    if (err) {
                        self.log.error(err.message);
                    }
                    cb();
                });
            }
        ]
    }, function _afterPipeline(pipelineErr) {
        var loadOpts = {};

        loadOpts.log = self.log;
        loadOpts.req_id = self.req.req_id;
        loadOpts.sysinfo = self.sysinfo;
        loadOpts.uuid = self.req.params.uuid;

        vmadm.load(loadOpts, function _onLoad(loadError, machine) {
            if (pipelineErr) {
                if (machine) {
                    self.fatal(pipelineErr.message, null, {
                        vm: machine
                    });
                    return;
                } else {
                    self.fatal(pipelineErr.message);
                    return;
                }
            } else {
                if (loadError) {
                    self.log.error(loadError.message);
                    self.finish();
                    return;
                }

                self.finish({
                    vm: machine
                });
            }
        });
    });
}

function pre_check(callback) {
    var self = this;

    assert.uuid(self.req.params.uuid, 'params.uuid');
    assert.uuid(self.req.sysinfo.UUID, 'sysinfo.UUID');

    vasync.pipeline({
        funcs: [
            function _checkAlreadyExists(_, cb) {
                 // Fail if VM with uuid exists
                vmadm.exists({
                    include_dni: true,
                    log: self.log,
                    sysinfo: self.req.sysinfo,
                    uuid: self.req.params.uuid
                }, function _onExistsResult(err, exists) {
                    if (err) {
                        cb(err);
                        return;
                    }
                    if (exists) {
                        cb(new Error('Machine ' + self.req.params.uuid +
                            ' exists.'));
                        return;
                    }
                    cb();
                    return;
                });
            }, function _checkDatasetExists(_, cb) {
                // TODO: Fail if zfs dataset already exists
                cb();
                return;
            }
        ]
    }, function _afterPipeline(err) {
        callback(err);
    });
}

function ensure_dataset_present(arg, callback) {
    // TODO: check whether dataset exists, set arg.dataset_exists appropriately.
    arg.dataset_exists = true;

    callback();
}

function fetch_dataset(arg, callback) {
    var self = this;

    if (arg.dataset_exists) {
        self.log.info('dataset exists, not fetching');
        callback();
        return;
    }

    /* BEGIN JSSTYLED */
    //
    // TODO: fetch dataset
    //
    //    "image_uuid": "fd2cc906-8938-11e3-beab-4359c665ac99",
    //    "dataset_url_compression": "bzip2",
    //    "dataset_url": "http://10.192.0.21/images/fd2cc906-8938-11e3-beab-4359c665ac99/file",
    //
    // in req.params.* will tell us where/how to get the image.
    //
    /* END JSSTYLED */

    callback();
}

function map_thing(opts, MAP_PAYLOAD, name, things) {
    var idx;
    var key;
    var keys;
    var newThing;
    var newThings = [];
    var thing;
    var thingIdx;

    assert.arrayOfObject(things, 'things');

    for (thingIdx = 0; thingIdx < things.length; thingIdx++) {
        newThing = {};
        thing = things[thingIdx];

        keys = Object.keys(thing);
        for (idx = 0; idx < keys.length; idx++) {
            key = keys[idx];
            if (MAP_PAYLOAD[key] === undefined) {
                opts.ignored.push(name + '.' + thingIdx + '.' + key);
            } else if (MAP_PAYLOAD[key]) {
                newThing[key] = thing[key];
            }
        }

        newThings.push(newThing);
    }

    return newThings;
}

function map_payload(opts, payload) {
    var idx;
    var keys;
    var key;
    var newPayload = {};

    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(payload, 'payload');

    opts.ignored = [];

    keys = Object.keys(payload);
    for (idx = 0; idx < keys.length; idx++) {
        key = keys[idx];

        if (key === 'nics') {
            // special case, we want to map specific NIC fields
            newPayload[key] = map_thing(opts, NIC_PAYLOAD, 'nic', payload[key]);
        } else if (key === 'disks') {
            // special case, we want to map specific disk fields
            newPayload[key] = map_thing(opts, DISK_PAYLOAD, 'disk',
                payload[key]);
        } else if (VM_PAYLOAD[key] === undefined) {
            opts.ignored.push(key);
        } else if (VM_PAYLOAD[key]) {
            newPayload[key] = payload[key];
        }
    }

    // fill in things we want default values for
    if (newPayload.nics === undefined) {
        newPayload.nics = {};
    }
    if (['bhyve', 'kvm'].indexOf(newPayload.brand) !== -1) {
        if (newPayload.disks === undefined) {
            newPayload.disks = {};
        }
    }
    newPayload.autoboot = true;
    newPayload.datasets = [];
    newPayload.limit_priv = 'default';
    if (newPayload.max_locked_memory === undefined &&
        newPayload.max_swap !== undefined) {

        newPayload.max_locked_memory = newPayload.max_swap;
    }
    if (newPayload.zpool === undefined) {
        newPayload.zpool = 'zones';
    }
    newPayload.zfs_filesystem = newPayload.zpool + '/' + newPayload.uuid;
    newPayload.zonepath = '/' + newPayload.zfs_filesystem;
    if (newPayload.zfs_io_priority === undefined) {
        newPayload.zfs_io_priority = 100;
    }

    if (opts.ignored.length > 0) {
        opts.log.warn({ignored: opts.ignored},
            'Warning: ignored some unrecognized payload properties');
    }

    return newPayload;
}

function build_payload(arg, callback) {
    var self = this;
    var req = self.req;
    var payload;

    payload = map_payload({log: self.log}, req.params);

    self.log.info({payload: payload}, 'built payload');

    arg.payload = payload;

    callback();
}

function create_machine(arg, callback) {
    var self = this;
    var payload;
    var req = self.req;

    payload = arg.payload;

    // Unfortunately vmadm.create conflates the payload and the opts, so we need
    // to add the log and req_id and sysinfo which it then removes later. :/
    payload.log = self.log;
    payload.req_id = req.req_id;
    payload.sysinfo = self.sysinfo;

    vmadm.create(payload, function _onCreate(err, vmobj) {
        if (err) {
            return callback(err);
        }
        return callback();
    });
}

MachineCreateTask.setStart(start);

MachineCreateTask.createSteps({
    pre_check: {
        fn: pre_check,
        progress: 20,
        description: 'Performing pre-flight sanity check'
    },
    ensure_dataset_present: {
        fn: ensure_dataset_present,
        progress: 30,
        description: 'Checking for required image/dataset'
    },
    fetch_dataset: {
        fn: fetch_dataset,
        progress: 50,
        description: 'Fetching image/dataset'
    },
    build_payload: {
        fn: build_payload,
        progress: 60,
        description: 'Building VM payload'
    },
    create_machine: {
        fn: create_machine,
        progress: 100,
        description: 'Creating machine'
    }
});
