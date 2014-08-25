/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var Task = require('../task_agent/task');
var zpool = require('zfs').zpool;

var ZFSListPoolsTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(ZFSListPoolsTask);

function start(callback) {
    var self = this;

    return (zpool.list(function (err, fields, rows) {
        if (err) {
            return (self.fatal('failed to list ZFS pools: ' + err.message));
        }

        /*
         * The fields and rows output from zpool.list() isn't the greatest;
         * convert it to an array of objects here.
         */
        var pools = [];
        for (var ii = 0; ii < rows.length; ii++) {
            var pool = {};
            for (var jj = 0; jj < fields.length; jj++) {
                pool[fields[jj]] = rows[ii][jj];
            }
            pools.push(pool);
        }

        self.progress(100);
        return (self.finish(pools));
    }));
}

ZFSListPoolsTask.setStart(start);
