/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var testCase = require('nodeunit').testCase;
var restify = require('restify');
var Logger = require('bunyan');
var smartdcconfig = require('../lib/smartdc-config');

var PROVISIONER_PORT = 5309;
var client;

function firstAdminIp(sysinfo) {
    var interfaces;

    interfaces = sysinfo['Network Interfaces'];

    for (var iface in interfaces) {
        if (!interfaces.hasOwnProperty(iface)) {
            continue;
        }

        var nic = interfaces[iface]['NIC Names'];
        var isAdmin = nic.indexOf('admin') !== -1;
        if (isAdmin) {
            var ip = interfaces[iface].ip4addr;
            return ip;
        }
    }

    throw new Error('No NICs with name "admin" detected.');
}

function setup(cb) {
    smartdcconfig.sysinfo(function (err, sysinfo) {
        var adminip;

        if (err) {
            cb(err);
            return;
        }

        adminip = firstAdminIp(sysinfo);
        if (!adminip) {
            throw new Error('failed to find admin IP');
        }

        client = restify.createJsonClient({
            agent: false,
            url: 'http://' + adminip + ':' + PROVISIONER_PORT
        });
        cb();
    });
}

function teardown(cb) {
    cb();
}

function testExecuteTaskHttp(test) {
    test.expect(3);
    client.get('/tasks', function (err, req, res, tasks) {
        test.ifError(err);
        if (!err) {
            test.ok(res, 'got a response');
            test.equal(res.statusCode, 200, 'GET /tasks returned 200');
        }
        test.done();
    });
}

module.exports = {
    setUp: setup,
    tearDown: teardown,
    'execute a task via http': testExecuteTaskHttp
};
