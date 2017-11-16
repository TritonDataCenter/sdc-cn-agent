/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var vmio = require('../lib/vmio');

var SERVER_CLOSE_TIMEOUT = 30;

/*
 * vmio.setupTritonExecution({
 *     req_id: 'bf35ae98-3361-ea9c-f948-a78bebbea29a',
 *     command: {
 *         detached: false
 *     }
 * }, function (err, response) {
 *
 * });
 */

process.on('message', function (message) {
    var opts = {
        req_id: message.req_id,
        brand: message.brand,
        command: message.command,
        platform: message.platform,
        uuid: message.uuid,
        timeoutSeconds: message.timeoutSeconds || SERVER_CLOSE_TIMEOUT
    };

    vmio.setupTritonExecution(opts, function (err, response) {
        process.send(response);
    });
});
