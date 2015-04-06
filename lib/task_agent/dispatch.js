/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * This file includes code responsible for setting up the event handlers used
 * by the task child processes (task_worker).
 */

var path = require('path');

function createHttpTaskDispatchFn(agent) {
    return function (req, cb) {
        var now = (new Date()).getTime();
        if (req.queue.expires && req.created &&
                now - req.created.getTime() > req.queue.expires * 1000) {
            req.event('error', 'Task expired');
            req.finish();
            return cb();
        }

        var child = agent.runner.dispatch(req);
        setupHttpChildEventHandlers(agent, child, req, cb);
    };
}

function setupHttpChildEventHandlers(agent, child, req, cb, http) {
    child.on('finish', function () {
        req.finish();
        if (cb)
            cb();
    });

    child.on('progress', function (value) {
        req.progress(value);
    });

    child.on('event', function (eventName, event) {
        req.event(eventName, event);
    });
}

function setupChildEventHandlers(agent, child, req, cb) {
    child.on('finish', function () {
        req.finish();
        if (cb)
            cb();
    });

    child.on('progress', function (value) {
        req.progress(value);
    });

    child.on('event', function (eventName, event) {
        req.event(eventName, event);
    });
}

module.exports = {
    createHttpTaskDispatchFn: createHttpTaskDispatchFn
};
