/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var fs = require('fs');

var async = require('async');

var common = require('../common');
var DummyVmadm = require('vmadm/lib/index.dummy_vminfod');
var Task = require('../../../task_agent/task');

var vmadm;
var MachineReprovisionTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
    this.zpool = req.params.zfs_storage_pool_name || 'zones';
};

Task.createTask(MachineReprovisionTask);


function start(callback) {
    var self = this;
    var provisionGuardFilename;

    // Create a new vmadm just for this server
    vmadm = new DummyVmadm({
        log: self.log,
        serverRoot: common.SERVER_ROOT,
        sysinfo: self.sysinfo,
        uuid: self.sysinfo.UUID
    });

    self.pre_check(function (error) {
        if (error) {
            self.fatal(error.message);
            return;
        }

        async.waterfall([
            function (cb) {
                common.provisionInProgressFile(
                    self.req.params.uuid,
                    function (err, filename) {
                        provisionGuardFilename = filename;
                        cb();
                        return;
                    });
            },
            self.ensure_dataset_present.bind(self),
            function (found, cb) {
                // The previous step (ensure..) returns a boolean indicating
                // whether the dataset was found. If that flag is set, we'll
                // run this (fetch) step and skip it if not.
                if (!found) {
                    return self.fetch_dataset(cb);
                } else {
                    return cb();
                }
            },
            self.reprovision_machine.bind(self)
        ],
        function (err) {
            fs.unlink(provisionGuardFilename, function () {
                var loadOpts = {};

                loadOpts.log = self.log;
                loadOpts.req_id = self.req.req_id;
                loadOpts.uuid = self.req.params.uuid;

                if (err) {
                    self.fatal(err.message);
                    return;
                }

                vmadm.load(
                    loadOpts,
                    function (loadError, machine)
                {
                    if (loadError) {
                        self.fatal('vmadm.load error: ' + loadError.message);
                        return;
                    }

                    self.finish({ vm: machine });
                });
            });
        });
    });
}

function pre_check(callback) {
    var opts = {};
    var self = this;

    opts.uuid = self.req.params.uuid;
    opts.log = self.log;

    async.waterfall([
        function (cb) {
            // fail if zone does not exist
            vmadm.exists(opts, function (err, exists) {
                if (err) {
                    cb(err);
                    return;
                } else if (!exists) {
                    cb(new Error('VM ' + opts.uuid + ' does not exist.'));
                    return;
                }
                cb();
            });
        }
    ],
    function (error) {
        if (error) {
            callback(error);
            return;
        }
        callback();
    });
}

function ensure_dataset_present(callback) {
    var self = this;

    var imageUuid = '<unknown>';
    var params = self.req.params;

    if (params.image_uuid) {
        imageUuid = params.image_uuid;
    }

    // TODO: check whether dataset exists, set callback arg appropriately.
    self.log.info('Dataset ' + imageUuid + ' exists.');
    callback(null, true);
}

function fetch_dataset(callback) {
    var self = this;

    var imageUuid = '<unknown>';
    var params = self.req.params;

    if (params.image_uuid) {
        imageUuid = params.image_uuid;
    }

    // This just pretends all images are already downloaded for now
    self.log.info('Dataset ' + imageUuid + ' exists, not fetching.');
    callback();
}

function reprovision_machine(callback) {
    var self = this;
    var opts = {};

    opts = self.req.params;
    opts.log = self.log;
    opts.req_id = self.req.req_id;
    opts.uuid = self.req.params.uuid;

    vmadm.reprovision(opts, function (error) {
        if (error) {
            var msg = error instanceof Error ? error.message : error;
            return callback(new Error('vmadm.reprovision error: ' + msg));
        }
        return callback();
    });
}

MachineReprovisionTask.setStart(start);

MachineReprovisionTask.createSteps({
    pre_check: {
        fn: pre_check,
        progress: 20,
        description: 'Pre-flight sanity check'
    },
    ensure_dataset_present: {
        fn: ensure_dataset_present,
        progress: 30,
        description: 'Checking for zone template dataset'
    },
    fetch_dataset: {
        fn: fetch_dataset,
        progress: 50,
        description: 'Fetching zone template dataset'
    },
    reprovision_machine: {
        fn: reprovision_machine,
        progress: 100,
        description: 'Reprovisioning machine'
    }
});
