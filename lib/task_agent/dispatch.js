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
    return function (req) {
        var child = agent.runner.dispatch(req);
        setupHttpChildEventHandlers(agent, child, req);
    };
}

function setupHttpChildEventHandlers(agent, child, req, http) {
    child.on('finish', function () {
        req.finish();
    });

    child.on('progress', function (value) {
        req.progress(value);
    });

    child.on('event', function (eventName, event) {
        req.event(eventName, event);
    });
}

function setupChildEventHandlers(agent, child, req) {
    child.on('finish', function () {
        req.finish();
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
