/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var async = require('async');
var cp = require('child_process');
var dns = require('dns');
var exec = require('child_process').exec;
var os = require('os');
var path = require('path');
var restify = require('restify');
var semver = require('semver');
var tty = require('tty');
var verror = require('verror');
var assert = require('assert-plus');
var http = require('http');
var once = require('once');
var StatusReporter = require('./heartbeater');


var createHttpTaskDispatchFn
    = require('./task_agent/dispatch').createHttpTaskDispatchFn;
var sdcconfig = require('./smartdc-config');
var TaskAgent = require('./task_agent/task_agent');


function App(options) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');

    this.options = options;
    this.log = options.log;
}


function shuffleArray(array) {
    for (var i = array.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var temp = array[i];
        array[i] = array[j];
        array[j] = temp;
    }
    return array;
}


/**
 * Return a list of addresses of CNAPI instances for this particular
 * datacentre.
 */

App.prototype.retrieveCnapiAddresses = function (callback) {
    var self = this;

    sdcconfig.sdcConfig(function (error, config) {
        if (error) {
            callback(new verror.VError(
                error, 'looking up sdc config'));
            return;
        }

        var domainName
            = 'cnapi.' + config.datacenter_name + '.' + config.dns_domain;

        self.log.info({ domainName: domainName }, 'cnapi domain name');

        dns.resolve(domainName, function (dnserror, addrs) {
            if (dnserror) {
                callback(new verror.VError(
                    dnserror, 'resolving cnapi address'));
                return;
            }

            callback(error, addrs);
        });
    });
};


// Need to find a valid CNAPI instance. We will retrieve the list of all
// CNAPI's via DNS, then iterate over them until we find a valid one. If no
// valid instances are found, sleep for a bit, then try again.

App.prototype.findValidCnapi = function (callback) {
    var self = this;

    self.retrieveCnapiAddresses(function (error, addrs) {
        if (error) {
            callback(new verror.VError(error, 'retrieving cnapi addreseses'));
            return;
        }

        if (!addrs.length) {
            callback(new verror.VError('no cnapi addresses found'));
            return;
        }

        callback(null, addrs[0]);
    });
};


App.prototype.startHeartbeater = function () {
    var self = this;
    var statusReporter = new StatusReporter({ log: self.log });

    self.findValidCnapi(function (error, cnapiaddr) {
        if (error) {
            var retryIntervalSeconds = 10;
            self.log.error({ error: error },
                'finding cnapi address; retrying in %ds', retryIntervalSeconds);
            setTimeout(function () {
                self.startHeartbeater();
            }, retryIntervalSeconds * 1000);
            return;
        }

        var url = 'http://' + cnapiaddr;

        var restifyOptions = {
            url: url,
            connectTimeout: 5000,
            requestTimeout: 5000
        };

        self.log.info('cnapi ip was %s', cnapiaddr);
        self.client = restify.createJsonClient(restifyOptions);
        var statusurlpath = '/servers/' + self.uuid + '/events/status';
        var hburlpath = '/servers/' + self.uuid + '/events/heartbeat';

        statusReporter.on('heartbeat', function () {
            self.client.post({ path: hburlpath }, {}, function (err) {
                if (err) {
                    self.log.warn({ error: err }, 'posting status to cnapi');
                    return;
                }
                self.log.info('posted heartbeat to cnapi');
            });
        });

        statusReporter.on('status', function (status) {
            self.log.trace({ status: status }, 'status report');

            self.client.post({ path: statusurlpath }, status, function (err) {
                if (err) {
                    self.log.warn({ error: err }, 'posting status to cnapi');
                    return;
                }
                self.log.info('posted status to cnapi');

            });

        });

        statusReporter.start();
    });
};


App.prototype.start = function () {
    var self = this;

    var agent = new TaskAgent(self.options);
    var tasksPath = self.options.tasksPath;

    var queueDefns = [
        {
        name: 'machine_creation',
            maxConcurrent: os.cpus().length,
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            tasks: [ 'machine_create', 'machine_reprovision' ]
        },
        {
            name: 'image_import_tasks',
            maxConcurrent: 1,
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            tasks: [ 'image_ensure_present' ]
        },
        {
            name: 'server_tasks',
            maxConcurrent: os.cpus().length,
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            tasks: [
                'server_overprovision_ratio'
            ]
        },
        {
            name: 'server_nic_tasks',
            maxConcurrent: 1,
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            tasks: [
                'server_update_nics'
            ]
        },
        {
            name: 'machine_tasks',
            maxConcurrent: os.cpus().length,
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            tasks: [
                'machine_boot',
                'machine_destroy',
                'machine_kill',
                'machine_reboot',
                'machine_shutdown',
                'machine_update',
                'machine_update_nics',
                'machine_screenshot',
                'machine_create_snapshot',
                'machine_rollback_snapshot',
                'machine_delete_snapshot'
            ]
        },
        {
            name: 'machine_images',
            expires: 60, // expire messages in this queue after a minute
            maxConcurrent: 64,
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            tasks: [
                'machine_create_image'
            ]
        },
        {
            name: 'image_query',
            expires: 60, // expire messages in this queue after a minute
            maxConcurrent: 64,
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            logging: false,
            tasks: [
                'image_get'
            ]
        },
        {
            name: 'machine_query',
            expires: 60, // expire messages in this queue after a minute
            maxConcurrent: 64,
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            logging: false,
            tasks: [
                'machine_load',
                'machine_info'
            ]
        },
        {
            name: 'zfs_tasks',
            maxConcurrent: os.cpus().length,
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            tasks: [
                'zfs_create_dataset',
                'zfs_destroy_dataset',
                'zfs_rename_dataset',
                'zfs_snapshot_dataset',
                'zfs_rollback_dataset',
                'zfs_clone_dataset',
                'zfs_set_properties'
            ]
        },
        {
            name: 'zfs_query',
            maxConcurrent: os.cpus().lenth,
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            tasks: [
                'zfs_get_properties',
                'zfs_list_datasets',
                'zfs_list_snapshots',
                'zfs_list_pools'
            ]
        },
        {
            name: 'fw_tasks',
            maxConcurrent: 1,
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            tasks: [
                'fw_add',
                'fw_del',
                'fw_update'
            ]
        },
        {
            name: 'test_sleep',
            maxConcurrent: 3,
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            tasks: [ 'sleep' ]
        },
        {
            name: 'nop',
            maxConcurrent: 1,
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            tasks: [ 'nop' ]
        },
        {
            name: 'test_subtask',
            maxConcurrent: 3,
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            tasks: [ 'test_subtask' ]
        }
    ];

    async.waterfall([
        function (cb) {
            sdcconfig.sdcConfig(function (error, config) {
                if (error) {
                    cb(new verror.VError(
                        error, 'looking up sdc config'));
                    return;
                }
                self.sdcconfig = config;
                cb();
            });
        },
        function (cb) {
            sdcconfig.sysinfo(function (error, sysinfo) {
                if (error) {
                    cb(new verror.VError(
                        error, 'looking up sysinfo'));
                    return;
                }
                self.sysinfo = sysinfo;
                cb();
            });
        }
    ],
    function (error) {
        self.uuid = self.sysinfo.UUID;
        self.startHeartbeater();


        // AGENT-640: Ensure we clean up any stale machine creation guard
        // files, then set queues up as per usual.
        var cmd = '/usr/bin/rm -f /var/tmp/machine-creation-*';
        exec(cmd, function (execerror, stdout, stderr) {
            agent.useQueues(queueDefns);
            agent.start();
        });
    });
};


module.exports = App;
