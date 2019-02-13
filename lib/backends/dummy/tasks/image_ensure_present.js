/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

var assert = require('assert-plus');

var Task = require('../../../task_agent/task');

function ImageEnsurePresentTask(req) {
    Task.call(this);
    this.req = req;
}

Task.createTask(ImageEnsurePresentTask);

function start() {
    var self = this;

    assert.object(self.log, 'self.log');
    assert.object(self.req, 'self.req');
    assert.object(self.req.params, 'self.req.params');

    // XXX
    //
    // ensure_image doesn't really seem necessary. If the image doesn't exist
    // but we need it, we'll import it at create_machine.
    //

    self.log.info({
        params: self.req.params
    }, 'Pretending to ensure_image');

    self.finish();
}

ImageEnsurePresentTask.setStart(start);

module.exports = ImageEnsurePresentTask;
