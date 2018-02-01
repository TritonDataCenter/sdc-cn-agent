/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var dockerstdio = require('../lib/docker-stdio');

var SERVER_CLOSE_TIMEOUT = 30;

process.on('message', function (message) {
    var opts = {
        req_id: message.req_id,
        path: message.path,
        uuid: message.uuid,
        mode: message.mode,
        admin_ip: message.admin_ip,
        no_overwrite_dir: message.no_overwrite_dir,
        timeoutSeconds: message.timeoutSeconds || SERVER_CLOSE_TIMEOUT,
        sysinfo: message.sysinfo
    };

    dockerstdio.setupDockerFileStream(opts, function (err, response) {
        if (err) {
            process.send({
                error: {
                    restCode: err.restCode,
                    message: err.message,
                    err: err.stack } });
            return;
        }
        process.send(response);
    });
});
