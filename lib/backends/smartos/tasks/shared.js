/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * Functionalities shared between two or more cn-agent tasks
 */

var child_process = require('child_process');
var execFile = child_process.execFile;
var fs = require('fs');

var async = require('async');
var dns = require('dns');
var restify = require('restify');

var sdcconfig = require('../smartdc-config');

// TODO: This is pretty much duplicated code from app.js. It would be desirable
// to update app.js in order to use this code if possible.
function refreshAgents(opts, cb) {
    var log = opts.log;

    var cnapiaddr;
    var uuid;
    var agents;

    async.waterfall([
        function retrieveCnapiAddresses(callback) {
            sdcconfig.sdcConfig(function (error, cfg) {
                if (error) {
                    return callback(error);
                }

                var domainName = 'cnapi.' + cfg.datacenter_name + '.' +
                    cfg.dns_domain;

                log.info({
                    domainName: domainName
                }, 'cnapi domain name');

                return dns.resolve(domainName, function (dnserror, addrs) {
                    if (dnserror) {
                        return callback(dnserror);
                    }

                    if (!addrs.length) {
                        return callback('No CNAPI addresses found');
                    }

                    cnapiaddr = addrs[0];
                    return callback();
                });
            });
        },
        function getSysinfo(callback) {
            execFile('/usr/bin/sysinfo', ['-f'], function (err, stdo, stde) {
                if (err) {
                    return callback(Error(stde.toString()));
                }
                var obj = JSON.parse(stdo.toString());
                agents = obj['SDC Agents'];
                uuid = obj.UUID;
                return callback();
            });
        },
        function getAgentsImages(callback) {
            var agents_dir = '/opt/smartdc/agents/lib/node_modules';
            return fs.readdir(agents_dir, function (err, files) {
                if (err) {
                    return callback(err);
                }
                return async.each(files, function getImageAndUUID(name, _cb) {
                    var uuid_path = '/opt/smartdc/agents/etc/' + name;
                    var uuidFileExists;
                    var agentUuid;
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
                                agentUuid = agent_uuid.trim();
                                return next();
                            });
                        }
                    ], function seriesCb(er2, results) {
                        if (er2) {
                            return _cb(er2);
                        }
                        agents.forEach(function (a) {
                            if (a.name === name) {
                                a.image_uuid = image_uuid;
                                if (agentUuid) {
                                    a.uuid = agentUuid;
                                }
                            }
                        });
                        return _cb();
                    });
                }, function (er3) {
                    if (er3) {
                        return callback('Cannot get agents image versions');
                    }
                    return callback();
                });
            });
        },
        function postAgentsToCnapi(callback) {
            var url = 'http://' + cnapiaddr;

            var restifyOptions = {
                url: url,
                connectTimeout: 5000,
                requestTimeout: 5000
            };

            log.info('cnapi ip was %s', cnapiaddr);
            var client = restify.createJsonClient(restifyOptions);

            client.post('/servers/' + uuid, {
                agents: agents
            }, function (err) {
                if (err) {
                    log.warn({
                        error: err
                    }, 'posting agents to cnapi');
                } else {
                    log.info('posted agents info to cnapi');
                }
                return callback();
            });
        }
    ], function waterfallCb(err) {
        return cb(err);
    });
}

module.exports = {
    refreshAgents: refreshAgents
};
