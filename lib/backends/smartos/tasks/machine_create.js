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
var kvmdebug = require('./kvmdebug');
var path = require('path');
var restify = require('restify');
var smartdcconfig = require('../smartdc-config');
var spawn = require('child_process').spawn;
var util = require('util');
var zfs = require('zfs').zfs;

var kvm_debugging = false;

var MachineCreateTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
    this.zpool = req.params.zfs_storage_pool_name || 'zones';
};

Task.createTask(MachineCreateTask);


function start(callback) {
    var self = this;

    var creationGuardFilename;

    async.waterfall([
        function (cb) {
            cb = common.wrapCallbackForTracing(self._span, 'pre_check', cb);
            self.pre_check(function (error) {
                if (error) {
                    self.fatal(error.message);
                    return;
                }
                cb();
            });
        },
        function (cb) {
            cb = common.wrapCallbackForTracing(self._span, 'sysinfo', cb);
            smartdcconfig.getFirstAdminIp(function onGetIp(err, adminIp) {
                if (err) {
                    cb(err);
                    return;
                }

                self.adminip = adminIp;
                cb();
            });
        },
        function (cb) {
            cb = common.wrapCallbackForTracing(self._span,
                'create_guard_file', cb);
            common.provisionInProgressFile(
                self.req.params.uuid,
                function (err, filename) {
                    creationGuardFilename = filename;
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
                cb = common.wrapCallbackForTracing(self._span,
                    'fetch_dataset', cb);
                return self.fetch_dataset(cb);
            } else {
                return cb();
            }
        },
        self.add_firewall_rules.bind(self),
        self.create_machine.bind(self),
        function (cb) {
            cb = common.wrapCallbackForTracing(self._span,
                'remove_guard_file', cb);
            fs.unlink(creationGuardFilename, function (unlinkError) {
                if (unlinkError) {
                    self.log.error(unlinkError.message);
                }
                cb();
            });
        },
        function (cb) {
            if (kvm_debugging) {
                cb = common.wrapCallbackForTracing(self._span,
                    'stop_kvm_debugging', cb);
                kvmdebug.stopKVMDebugging(self.log);
                kvm_debugging = false;
            }
            cb();
        }
    ],
    function (waterfallError) {
        var loadOpts = {};

        loadOpts.log = self.log;
        loadOpts.req_id = self.req.req_id;
        loadOpts.uuid = self.req.params.uuid;
        loadOpts.include_dni = self.req.params.include_dni === true ||
            self.req.params.include_dni === 'true';
        loadOpts.vmadmLogger = self.vmadmLogger;
        loadOpts.span = self._span;

        vmadm.load(
            loadOpts,
            function (loadError, machine)
        {
            if (waterfallError) {
                if (machine) {
                    self.fatal(waterfallError.message, null, { vm: machine });
                    return;
                } else {
                    self.fatal(waterfallError.message);
                    return;
                }
            } else {
                if (loadError) {
                    self.log.error(loadError.message);
                    self.finish();
                    return;
                }

                self.finish({ vm: machine });
            }
        });
    });
}


function pre_check(callback) {
    var self = this;
    var zoneDataset = path.join(self.zpool, self.req.params.uuid);

    async.waterfall([
        function (cb) {
            /*
             * fail if zone with uuid exists
             *
             * NOTE: this doesn't take into account do_not_inventory because
             * we're checking whether we can use the uuid and even if it's
             * do_not_inventory, the uuid is used. This is where the lie breaks
             * down.
             */
            common.zoneList(self.req.params.uuid, function (error, zones) {
                if (zones[self.req.params.uuid]) {
                    cb(new Error(
                        'Machine ' + self.req.params.uuid + ' exists.'));
                    return;
                }
                cb();
            });
        },
        function (cb) {
            // If we don't get an error on this `list` it means the dataset
            // exists.
            zfs.list(
            zoneDataset, { type: 'all' }, function (error, fields, list) {
                if (list && list.length) {
                    cb(new Error('Dataset ' + zoneDataset + ' exists.'));
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

    callback = common.wrapCallbackForTracing(self._span,
        'ensure_dataset_present', callback);

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

function add_firewall_rules(callback) {
    var self = this;

    callback = common.wrapCallbackForTracing(self._span, 'add_firewall_rules',
        callback);

    if (!self.req.params.firewall_rules) {
        self.log.info('No firewall_rules property in params: not adding');
        callback();
        return;
    }

    if (self.req.params.firewall_rules.length === 0) {
        self.log.info('No firewall rules to add in params');
        callback();
        return;
    }

    var fwClient = restify.createJsonClient({
        url: 'http://' + self.adminip + ':2021',
        headers: {
            'x-request-id': self.req.req_id
        }
    });

    self.log.debug('Adding firewall rules');

    async.each(self.req.params.firewall_rules, function (rule, cb) {
        var putOpts = {
            path: '/rules/' + rule.uuid
        };

        fwClient.put(putOpts, rule, function (err, res) {
            if (err) {
                self.log.error({ err: err, rule: rule },
                    'Error adding firewall rule');
            } else {
                self.log.info('Added firewall rule');
            }

            cb(err);
            return;
        });
    }, function (doneErr) {
        fwClient.close();

        self.log.debug('Added firewall rules');
        callback(doneErr);
        return;
    });
}

function normalizeError(error) {
    if (error instanceof String || typeof (error === 'string')) {
        return new Error(error);
    }
    return error;
}

function create_machine(callback) {
    var self = this;
    var opts = {};
    var req = self.req;

    callback = common.wrapCallbackForTracing(self._span, 'create_machine',
        callback);

    if (req.params.brand === 'kvm') {
        kvmdebug.startKVMDebugging(self.log, function (cmd, args, output) {
            var cmdline = cmd + ' ' + args.join(' ');
            self.log.debug({cmdline: cmdline, output: output});
        });
        kvm_debugging = true;
    }

    opts = req.params;
    opts.log = self.log;
    opts.req_id = req.req_id;
    opts.vmadmLogger = self.vmadmLogger;
    opts.span = self._span;

    vmadm.create(opts, function (error, info) {
        if (error) {
            return callback(error);
        }
        return callback();
    });
}

MachineCreateTask.setStart(start);

MachineCreateTask.createSteps({
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
    add_firewall_rules: {
        fn: add_firewall_rules,
        progress: 60,
        description: 'Adding firewall rules'
    },
    create_machine: {
        fn: create_machine,
        progress: 100,
        description: 'Creating machine'
    }
});
