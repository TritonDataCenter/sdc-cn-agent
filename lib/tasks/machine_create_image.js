/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * A provisioner task to create an image from a VM.
 */

var Task = require('../task_agent/task');
var VM = require('/usr/vm/node_modules/VM');
var execFile = require('child_process').execFile;
var common = require('../common');
var imgadm = require('../imgadm');


// ---- internal support stuff

function clip(s, len) {
    if (s.length > len) {
        var elide = '\n... content elided (full message was ' +
            String(s.length) + ' characters) ...\n';
        var front = Math.floor((len - elide.length) / 2);
        var back = len - front - elide.length;
        s = s.slice(0, front) + elide + s.slice(-back);
    }
    return s;
}


// ---- the task

var MachineCreateImageTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineCreateImageTask);

function start(callback) {
    var self = this;
    var params = self.req.params;

    params.log = self.log;

    // TODO: find a way to get meaningful progress from imgadm create
    imgadm.createImage(params, function (error) {
        if (error) {
            if (error.body) {
                // We pass back a structured error (from `imgadm -E ...`) if
                // possible.
                self.fatal(JSON.stringify(error.body));
            } else {
                // Be *somewhat* of a good citizen and limit the size of a
                // message being sent via Rabbit back to CNAPI. FWIW, this is
                // the same clipping limit that IMGAPI applies in the create
                // image workflow.
                var LIMIT = 20000;
                self.fatal(clip(error.message, LIMIT));
            }
            return;
        }

        self.progress(100);
        self.finish();
    });
}

MachineCreateImageTask.setStart(start);
