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
var fs = require('fs');
var path = require('path');
var restify = require('restify');
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


App.prototype.updateAgents = function (callback) {
    var self = this;
    // We assume nobody will use this before initializing heartbeater,
    // otherwise we should complain:
    if (!self.client) {
        return callback(new verror.VError('CNAPI client not initialized'));
    }
    // And the same for sysinfo:
    if (!self.sysinfo) {
        return callback(new verror.VError('sysinfo not initialized'));
    }
    var agents = self.sysinfo['SDC Agents'];
    var agents_dir = '/opt/smartdc/agents/lib/node_modules';
    return fs.readdir(agents_dir, function (err, files) {
        if (err) {
            return callback(err);
        }
        return async.each(files, function getImageAndUUID(name, cb) {
            var uuid_path = '/opt/smartdc/agents/etc/' + name;
            var uuidFileExists;
            var uuid;
            var image_uuid;
            async.series([
                function getImage(next) {
                    var fpath = agents_dir + '/' + name + '/image_uuid';
                    fs.readFile(fpath, {
                        encoding: 'utf8'
                    }, function (er2, img_uuid) {
                        if (er2) {
                            return next(er2);
                        }
                        image_uuid = img_uuid.trim();
                        return next();
                    });
                },
                function agentUuidFileExists(next) {
                    fs.exists(uuid_path, function (exists) {
                        if (exists) {
                            uuidFileExists = true;
                        }
                        next();
                    });
                },
                function getUUID(next) {
                    if (!uuidFileExists) {
                        return next();
                    }
                    return fs.readFile(uuid_path, {
                        encoding: 'utf8'
                    }, function (er2, agent_uuid) {
                        if (er2) {
                            return next(er2);
                        }
                        uuid = agent_uuid.trim();
                        return next();
                    });
                }
            ], function seriesCb(er2, results) {
                if (er2) {
                    return cb(er2);
                }
                agents.forEach(function (a) {
                    if (a.name === name) {
                        a.image_uuid = image_uuid;
                        if (uuid) {
                            a.uuid = uuid;
                        }
                    }
                });
                return cb();
            });
        }, function (er3) {
            if (er3) {
                return callback(new verror.VError(
                            'Cannot get agents image versions'));
            }
            self.log.info({agents: agents}, 'Posting agents');
            return self.client.post('/servers/' + self.uuid, {
                agents: agents
            }, function (er4) {
                if (er4) {
                    self.log.warn({ error: er4 }, 'posting agents to cnapi');
                } else {
                    self.log.info('posted agents info to cnapi');
                }
                return callback();
            });
        });
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
                self.log.debug('posted heartbeat to cnapi');
            });
        });

        statusReporter.on('status', function (status) {
            self.log.trace({ status: status }, 'status report');

            self.client.post({ path: statusurlpath }, status, function (err) {
                if (err) {
                    self.log.warn({ error: err }, 'posting status to cnapi');
                    return;
                }
                self.log.debug('posted status to cnapi');

            });

        });

        self.updateAgents(function (err) {
            if (err) {
                self.log.error({
                    err: err
                }, 'Error updating agents info into CNAPI');
            }
            statusReporter.start();
        });
    });
};


App.prototype.start = function () {
    var self = this;

    var agent = new TaskAgent(self.options);
    var tasksPath = self.options.tasksPath;

    var queueDefns = [
        {
        name: 'machine_creation',
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            concurrency: 4,
            tasks: [ 'machine_create', 'machine_reprovision' ]
        },
        {
            name: 'image_import_tasks',
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            concurrency: 4,
            tasks: [ 'image_ensure_present' ]
        },
        {
            name: 'server_tasks',
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            tasks: [
                'server_overprovision_ratio'
            ]
        },
        {
            name: 'docker_tasks',
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            concurrency: 8,
            tasks: [
                'docker_exec',
                'docker_copy',
                'docker_stats'
            ]
        },
        {
            name: 'server_nic_tasks',
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            tasks: [
                'server_update_nics'
            ]
        },
        {
            name: 'agents_tasks',
            maxConcurrent: 1,
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            tasks: [
                'agent_install',
                'shutdown_cn_agent_update'
            ]
        },
        {
            name: 'machine_tasks',
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            concurrency: 4,
            tasks: [
                'machine_boot',
                'machine_destroy',
                'machine_kill',
                'machine_proc',
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
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            concurrency: 2,
            tasks: [
                'machine_create_image'
            ]
        },
        {
            name: 'image_query',
            expires: 60, // expire messages in this queue after a minute
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            concurrency: 2,
            logging: false,
            tasks: [
                'image_get'
            ]
        },
        {
            name: 'machine_query',
            expires: 60, // expire messages in this queue after a minute
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            concurrency: 8,
            logging: false,
            tasks: [
                'machine_load',
                'machine_info'
            ]
        },
        {
            name: 'zfs_tasks',
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            concurrency: 4,
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
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            concurrency: 8,
            tasks: [
                'zfs_get_properties',
                'zfs_list_datasets',
                'zfs_list_snapshots',
                'zfs_list_pools'
            ]
        },
        {
            name: 'fw_tasks',
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            concurrency: 4,
            tasks: [
                'fw_add',
                'fw_del',
                'fw_update'
            ]
        },
        {
            name: 'test_sleep',
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            tasks: [ 'sleep' ]
        },
        {
            name: 'nop',
            onhttpmsg: createHttpTaskDispatchFn(agent, tasksPath),
            tasks: [ 'nop' ]
        },
        {
            name: 'test_subtask',
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
