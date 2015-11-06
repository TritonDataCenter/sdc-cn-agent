/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var testCase = require('nodeunit').testCase;
var Logger = require('bunyan');
var common = require('../lib/common');

var client;

function setup(cb) {
    common.getClient(function (err, result) {
        if (err) {
            cb(err);
            return;
        }

        client = result;
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

module.exports = {
    setUp: setup,
    tearDown: teardown,
    'execute a task via http': testExecuteTaskHttp,
    'execute a non-task via http': testExecuteNonTaskHttp
};
