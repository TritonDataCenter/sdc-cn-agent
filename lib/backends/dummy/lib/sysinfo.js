/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var fs = require('fs');

var assert = require('assert-plus');

var common = require('../common');

function sysinfo() {
}

sysinfo.prototype.get = function get(opts, callback) {
    assert.object(opts, 'opts');
    assert.uuid(opts.serverUuid, 'opts.serverUuid');
    assert.func(callback, 'callback');

    var filename = common.SERVER_ROOT + '/' + opts.serverUuid + '/sysinfo.json';

    fs.readFile(filename, function onData(err, data) {
        var sinfo;

        if (err) {
            callback(err);
            return;
        }

        sinfo = JSON.parse(data.toString());
        callback(null, sinfo);
    });
};

module.exports = sysinfo;

if (require.main === module) {
    var sysinfoGetter = new sysinfo();
    var uuid = process.argv[2];

    assert.uuid(uuid, 'uuid');

    sysinfoGetter.get({
        serverUuid: uuid
    }, function onSysinfo(err, info) {
        assert.ifError(err, 'unexpected error loading sysinfo');
        console.log(JSON.stringify(info, null, 4));
    });
}
