/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var Task = require('../task_agent/task');
var zfs = require('zfs').zfs;

var ZFSGetPropsTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(ZFSGetPropsTask);

function start(callback) {
    var self = this;
    var dataset = self.req.params.dataset || '';
    var properties = self.req.params.properties || [ 'all' ];

    return (zfs.get(dataset, properties, true, function (err, values) {
        if (err) {
            return (self.fatal('failed to get ZFS properties for dataset "' +
                dataset + '": ' + err.message));
        }

        return (self.finish(values));
    }));
}

ZFSGetPropsTask.setStart(start);
