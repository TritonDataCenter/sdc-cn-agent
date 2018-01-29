/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var dns = require('dns');
var exec = require('child_process').exec;
var fs = require('fs');
var os = require('os');
var path = require('path');

var assert = require('assert-plus');
var async = require('async');
var backo2 = require('backo2');
var restify = require('restify');
var vasync = require('vasync');
var verror = require('verror');

var StatusReporter = require('./heartbeater');

var createHttpTaskDispatchFn
    = require('./task_agent/dispatch').createHttpTaskDispatchFn;
var TaskAgent = require('./task_agent/task_agent');

var DEFAULT_TASK_TIMEOUT_SECONDS = 60 * 60;

//
// 1.6 chosen here mostly randomly, just so we try a bit more often initially
// than with the default value of 2. If a more scientific value is arrived at,
// feel free to change. Same goes for the other values here. These seemed like
// reasonable places to start, but production experience will likely lead to
// improvement opportunities. Nothing is magical about these values.
//
var REGISTER_RETRY_FACTOR = 1.6;
var REGISTER_RETRY_JITTER = 0.2;
var REGISTER_RETRY_MAX_DELAY_MS = 120 * 1000;
var REGISTER_RETRY_MIN_DELAY_MS = 500;

function App(options) {
    assert.object(options, 'options');
    assert.object(options.agentserver, 'options.agentserver');
    assert.object(options.backend, 'options.backend');
    assert.object(options.config, 'options.config');
    assert.optionalObject(options.env, 'options.env');
    assert.object(options.log, 'options.log');
    assert.object(options.sdc_config, 'options.sdc_config');
    assert.object(options.sysinfo, 'options.sysinfo');
    assert.string(options.tasklogdir, 'options.tasklogdir');
    assert.uuid(options.uuid, 'options.uuid');

    var packageJson =
        JSON.parse(fs.readFileSync(path.join(__dirname, '/../package.json'),
        'utf8'));

    this.options = options;
    if (!options.env) {
        options.env = {};
    }

    this.agentserver = options.agentserver;
    this.backend = options.backend;
    this.config = options.config;
    this.log = options.log.child();
    this.registerBackoff = new backo2({
        factor: REGISTER_RETRY_FACTOR,
        jitter: REGISTER_RETRY_JITTER,
        max: REGISTER_RETRY_MAX_DELAY_MS,
        min: REGISTER_RETRY_MIN_DELAY_MS
    });
    this.sdc_config = options.sdc_config;
    this.sysinfo = options.sysinfo;
    this.userAgent = 'cn-agent/' + packageJson.version;
    this.uuid = options.uuid;

    this.log.info('started cn-agent for %s', this.uuid);
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

    // Allow overriding the IPs to use for CNAPI via the config
    if (self.config.cnapi_ips) {
        callback(null, self.config.cnapi_ips);
        return;
    }

    assert.string(self.sdc_config.dns_domain, 'options.sdc_config.dns_domain');
    assert.string(self.sdc_config.datacenter_name,
        'options.sdc_config.datacenter_name');

    var domainName
        = 'cnapi.' + self.sdc_config.datacenter_name + '.' +
            self.sdc_config.dns_domain;

    self.log.info({ domainName: domainName }, 'cnapi domain name');

    dns.resolve(domainName, function (dnserror, addrs) {
        if (dnserror) {
            callback(new verror.VError(
                dnserror, 'resolving cnapi address'));
            return;
        }

        callback(null, addrs);
    });
};


// Need to find a valid CNAPI instance. We will retrieve the list of all
// CNAPI's via DNS, then iterate over them until we find a valid one. If no
// valid instances are found, sleep for a bit, then try again.

App.prototype.ensureCnapiLookedUp = function (callback) {
    var self = this;

    retrieveOrWait();

    function retrieveOrWait() {
        retrieve(function (error, addr) {
            if (error) {
                var retryIntervalSeconds = 10;
                self.log.error({ error: error },
                    'finding cnapi address; retrying in %ds',
                    retryIntervalSeconds);
                setTimeout(function () {
                    retrieveOrWait();
                }, retryIntervalSeconds * 1000);
                return;
            }

            self.cnapiAddr = addr;
            self.agentserver.setCnapiAddress(addr);
            callback();
        });
    }

    function retrieve(cb) {
        self.retrieveCnapiAddresses(function (error, addrs) {
            if (error) {
                cb(
                    new verror.VError(error, 'retrieving cnapi addreseses'));
                return;
            }

            if (!addrs.length) {
                cb(new verror.VError('no cnapi addresses found'));
                return;
            }

            cb(null, addrs[0]);
        });
    }
};


App.prototype.updateAgents = function (callback) {
    var self = this;

    if (self.config.skip_agents_update) {
        self.log.warn('skip_agents_update set, skipping agents update');
        callback();
        return;
    }

    // We assume nobody will use this before initializing heartbeater,
    // otherwise we should complain:
    if (!self.client) {
        callback(new verror.VError('CNAPI client not initialized'));
        return;
    }
    // And the same for sysinfo:
    if (!self.sysinfo) {
        callback(new verror.VError('sysinfo not initialized'));
        return;
    }
    var agents = self.sysinfo['SDC Agents'];
    var agents_dir = '/opt/smartdc/agents/lib/node_modules';
    fs.readdir(agents_dir, function (err, files) {
        if (err) {
            callback(err);
            return;
        }
        async.each(files, function getImageAndUUID(name, cb) {
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
                            next(er2);
                            return;
                        }
                        image_uuid = img_uuid.trim();
                        next();
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
                        next();
                        return;
                    }
                    fs.readFile(uuid_path, {
                        encoding: 'utf8'
                    }, function (er2, agent_uuid) {
                        if (er2) {
                            next(er2);
                            return;
                        }
                        uuid = agent_uuid.trim();
                        next();
                    });
                }
            ], function seriesCb(er2, results) {
                if (er2) {
                    cb(er2);
                    return;
                }
                agents.forEach(function (a) {
                    if (a.name === name) {
                        a.image_uuid = image_uuid;
                        if (uuid) {
                            a.uuid = uuid;
                        }
                    }
                });
                cb();
            });
        }, function (er3) {
            if (er3) {
                callback(new verror.VError('Cannot get agents image versions'));
                return;
            }
            self.log.info({agents: agents}, 'Posting agents');
            self.client.post('/servers/' + self.uuid, {
                agents: agents
            }, function (er4) {
                if (er4) {
                    self.log.warn({ error: er4 }, 'posting agents to cnapi');
                } else {
                    self.log.info('posted agents info to cnapi');
                }
                callback();
                return;
            });
        });
    });
};


App.prototype.startHeartbeater = function () {
    var self = this;
    var statusReporter;
    var cnapiAddr = self.cnapiAddr;

    var url = 'http://' + cnapiAddr;

    var restifyOptions = {
        url: url,
        connectTimeout: 5000,
        requestTimeout: 5000
    };

    statusReporter = new StatusReporter({
        backend: self.backend,
        log: self.log
    });

    self.log.info('cnapi ip was %s', cnapiAddr);
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
};


// Whenever we start up, we want to ensure we've updated the sysinfo in CNAPI
// before we continue further. This ensures we've got the correct 'Boot Time'
// for example. (See also: TRITON-69)
App.prototype.registerServer = function registerServer(callback) {
    var self = this;

    var cnapiAddr = self.cnapiAddr;
    var restifyOptions;
    var url = 'http://' + cnapiAddr;
    var urlPath = path.join('/servers', self.uuid, 'sysinfo');

    restifyOptions = {
        connectTimeout: 5000,
        requestTimeout: 5000,
        url: url,
        userAgent: self.userAgent
    };

    self.client = restify.createJsonClient(restifyOptions);

    // Make an attempt, if that fails, schedule a new attempt with a delay
    self.client.post({
        path: urlPath
    }, {
        sysinfo: self.sysinfo
    }, function afterPost(err, req, res, obj) {
        var delay;

        if (err) {
            if (err.statusCode === 404 && err.restCode === 'ResourceNotFound') {
                // If we get a 404, that means we've got an old CNAPI that
                // doesn't support registering sysinfo. So we'll not keep
                // retrying in this case.
                self.log.warn({
                    err: err
                }, 'CNAPI does not seem to support sysinfo registration. ' +
                    'Skipping.');

                callback();
                return;
            }

            delay = self.registerBackoff.duration();

            self.log.warn({
                err: err,
                retryInMs: delay
            }, 'Error posting sysinfo to cnapi, will retry.');

            setTimeout(function _registerAgain() {
                registerServer.call(self, callback);
            }, delay);

            // Note: we don't call callback() because we wait until we're
            // successful.

            return;
        }

        self.log.debug({
            headers: res.headers,
            statusCode: res.statusCode
        }, 'posted sysinfo to cnapi');

        callback();
    });
};


App.prototype.start = function () {
    var self = this;

    var agent;
    var agentserver = self.options.agentserver;
    var logname = self.options.logname;
    var tasklogdir = self.options.tasklogdir;
    var taskspath = self.options.taskspath;
    var queueDefns;
    var uuid = self.uuid;

    queueDefns = self.backend.queueDefns;
    assert.object(queueDefns, 'queueDefns');

    agent = new TaskAgent({
        agentserver: agentserver,
        backend: self.backend,
        env: self.options.env,
        log: self.log,
        logname: logname,
        tasklogdir: tasklogdir,
        taskspath: taskspath,
        timeoutSeconds: DEFAULT_TASK_TIMEOUT_SECONDS,
        uuid: uuid
    });

    for (var i = 0; i < queueDefns.length; i++) {
        queueDefns[i].onhttpmsg = createHttpTaskDispatchFn(agent, taskspath);
    }

    vasync.pipeline({
        funcs: [
            function _ensureCnapiLookedUp(_, cb) {
                self.ensureCnapiLookedUp(cb);
            }, function _registerServer(_, cb) {
                self.registerServer(cb);
            }, function _startHeartbeater(_, cb) {
                self.startHeartbeater();
                cb();
            }, function _cleanupStaleLocks(_, cb) {
                if (self.backend.cleanupStaleLocks === undefined) {
                    cb();
                    return;
                }

                self.backend.cleanupStaleLocks(cb);
            }
        ]
    }, function onPipelineComplete(err) {
        if (err) {
            throw err;
        }

        agent.useQueues(queueDefns);
        self.log.info('starting cn-agent for %s', self.uuid);
        agent.start();
    });
};


module.exports = App;
