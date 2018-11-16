/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * Functionalities shared between two or more cn-agent tasks
 */

var assert = require('assert-plus');
var restify = require('restify');
var vasync = require('vasync');

var common = require('../common');

function refreshAgents(opts, callback) {
    var log = opts.log;

    assert.object(opts, 'opts');
    assert.uuid(opts.serverUuid, 'opts.serverUuid');
    assert.func(callback, 'callback');

    var agents;
    var cnapiUrl;
    var serverUuid = opts.serverUuid;

    vasync.pipeline({funcs: [
        function retrieveCnapiAddresses(_, cb) {
            common.getSdcConfig(function onConfig(err, config) {
                if (err) {
                    cb(err);
                    return;
                }

                cnapiUrl = 'http://cnapi.' + config.datacenter_name + '.' +
                    config.dns_domain;

                log.info({
                    cnapiUrl: cnapiUrl
                }, 'cnapi URL');

                cb();
            });
        },
        function getAgents(_, cb) {
            common.getAgents({
                serverUuid: serverUuid
            }, function gotAgents(err, _agents) {
                if (!err) {
                    agents = _agents;
                    log.debug({
                        agents: agents,
                        serverUuid: serverUuid
                    }, 'loaded agents');
                }
                cb(err);
            });
        },
        function postAgentsToCnapi(_, cb) {
            var client;
            var url = 'http://' + cnapiUrl;

            var restifyOptions = {
                url: url,
                connectTimeout: 5000,
                requestTimeout: 5000
            };

            log.info(restifyOptions, 'cnapi URL was %s', cnapiUrl);

            client = restify.createJsonClient(restifyOptions);

            client.post('/servers/' + serverUuid, {
                agents: agents
            }, cb);
        }
    ]}, callback);
}

module.exports = {
    refreshAgents: refreshAgents
};
