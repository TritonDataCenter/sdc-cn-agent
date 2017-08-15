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
    var bodyObj = {
        params: {}
    };

    client.post(
        '/tasks?task=zfs_list_datasets',
        bodyObj,
        function (err, req, res, tasks) {
            test.ifError(err);
            if (!err) {
                test.ok(res, 'got a response');
                test.equal(res.statusCode, 200, 'POST /tasks returned 200');
            }
            test.done();
        });
}

function testExecuteNonTaskHttp(test) {
    test.expect(2);
    var bodyObj = {
        params: {}
    };

    client.post(
        '/tasks?task=this_is_not_a_task',
        bodyObj,
        function (err, req, res, tasks) {
            if (err) {
                test.ok(res, 'got a response');
                test.equal(res.statusCode, 404, 'POST /tasks returned 404');
            }
            test.done();
        });
}

function testPauseTaskHandlerHttp(test) {
    test.expect(3);
    client.post('/pause', {}, function (err, req, res) {
        test.ifError(err);
        if (!err) {
            test.ok(res, 'Got /pause response');
            test.equal(res.statusCode, 204, 'POST /pause returned 204');
        }
        test.done();
    });
}

function testCannotRunTaskPaused(test) {
    test.expect(2);
    var bodyObj = {
        params: {}
    };

    client.post(
        '/tasks?task=nop',
        bodyObj,
        function (err, req, res, tasks) {
            if (err) {
                test.ok(res, 'got a response');
                test.equal(res.statusCode, 503,
                        'POST /tasks paused returned 503');
            }
            test.done();
        });
}

function testResumeTaskHandlerHttp(test) {
    test.expect(3);
    client.post('/resume', {}, function (err, req, res) {
        test.ifError(err);
        if (!err) {
            test.ok(res, 'Got /resume response');
            test.equal(res.statusCode, 204, 'POST /resume returned 204');
        }
        test.done();
    });
}


function testCanRunTaskAfterResume(test) {
    test.expect(3);
    var bodyObj = {
        params: {}
    };

    client.post(
        '/tasks?task=nop',
        bodyObj,
        function (err, req, res, tasks) {
            test.ifError(err);
            if (!err) {
                test.ok(res, 'got a response');
                test.equal(res.statusCode, 200, 'POST /tasks returned 200');
            }
            test.done();
        });
}


function testTasksHistory(test) {
    test.expect(6);

    client.get(
        '/history',
        function (err, req, res, history) {
            test.ifError(err);
            if (!err) {
                test.ok(res, 'got a response');
                test.equal(res.statusCode, 200, 'GET /tasks returned 200');
                test.ok(Array.isArray(history), 'Tasks history is an array');
                test.ok(history.length, 'Tasks history contains tasks');
                test.ok(history[0].status, 'Tasks has status property');
            }
            test.done();
        });
}


/**
 * Check that a longer-running task does not run into the default 2 minute
 * socket timeout in node.
 */
function testTaskDurationDefaultTimeout(test) {
    test.expect(4);
    var bodyObj = {
        params: {sleep: 3 * 60}
    };

    var start = new Date();
    var TIMEOUT_MS = 60 * 2 * 1000;

    client.post(
        '/tasks?task=nop',
        bodyObj,
        function (err, req, res, tasks) {
            test.ifError(err);
            if (!err) {
                test.ok(res, 'got a response');
                test.equal(res.statusCode, 200, 'POST /tasks returned 200');
            }

            var diff = (new Date()) - start;

            test.ok(
                diff > TIMEOUT_MS,
                'task did not time out after 2 min');
            test.done();
        });
}

module.exports = {
    setUp: setup,
    tearDown: teardown,
    'execute a task via http': testExecuteTaskHttp,
    'execute a non-task via http': testExecuteNonTaskHttp,
    'pause task handler via http': testPauseTaskHandlerHttp,
    'cannot execute task paused': testCannotRunTaskPaused,
    'resume task handler via http': testResumeTaskHandlerHttp,
    'can execute task after resume': testCanRunTaskAfterResume,
    'test task duration beyond built-in default':
        testTaskDurationDefaultTimeout,
    'tasks history': testTasksHistory
};
