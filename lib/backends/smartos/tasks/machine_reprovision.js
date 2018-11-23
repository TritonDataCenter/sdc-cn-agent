/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var Task = require('../../../task_agent/task');
var vmadm = require('vmadm');
var async = require('async');
var common = require('../common');
var fs = require('fs');
var imgadm = require('../imgadm');
var path = require('path');
var spawn = require('child_process').spawn;
var util = require('util');
var zfs = require('zfs').zfs;

var MachineReprovisionTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
    this.zpool = req.params.zfs_storage_pool_name || 'zones';
};

Task.createTask(MachineReprovisionTask);

function start(callback) {
    var self = this;
    var provisionGuardFilename;

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

    var fullDataset;
    var params = self.req.params;


    // TODO Enable provisioner to be able to check a list of image_uuids and
    // fetch any that are not installed
    self.toImport = null;

    if (params.image_uuid) {
        self.toImport = params.image_uuid;
    } else if (self.req.params.disks && self.req.params.disks.length) {
        self.toImport = self.req.params.disks[0].image_uuid;
    }

    fullDataset = this.zpool + '/' + self.toImport;

    self.log.info(
        'Checking whether zone template dataset '
        + fullDataset + ' exists on the system.');

    zfs.list(
        fullDataset,
        { type: 'all' },
        function (error, fields, list) {
            if (!error && list.length) {
                self.log.info('Dataset ' + fullDataset + ' exists.');
                callback(null, true);
                return;
            } else if (error && error.toString().match(/does not exist/)) {
                self.log.info('Dataset template didn\'t appear to exist.');
                callback(null, false);
                return;
            }
        });
}

function fetch_dataset(callback) {
    var self = this;

    var options = {
        uuid: self.toImport,
        zpool: self.zpool,
        log: self.log
    };
    imgadm.importImage(options, function (err) {
        if (err) {
            self.log.error(err);
            callback(err);
            return;
        }
        callback();
    });
}

function normalizeError(error) {
    if (error instanceof String || typeof (error === 'string')) {
        return new Error(error);
    }
    return error;
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
