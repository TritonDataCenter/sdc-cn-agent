/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var restify = require('restify');

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

module.exports = {
    setUp: setup,
    tearDown: teardown,
    '':
}
