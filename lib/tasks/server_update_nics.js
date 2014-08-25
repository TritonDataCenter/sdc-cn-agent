/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var async = require('async');
var execFile = require('child_process').execFile;
var Task = require('../task_agent/task');

var NICTAGADM = '/usr/bin/nictagadm';


function listTags(log, callback) {
    // list output looks like:
    //   external|00:50:56:3d:a7:95
    execFile(NICTAGADM, ['list', '-p', '-d', '|'],
        function (err, stdout, stderr) {
        if (err) {
            return callback(err);
        }

        log.debug('nictagadm output: ' + stdout);
        var tags = {};

        stdout.split('\n').forEach(function (line) {
            var tagData = line.split('|');
            if (tagData[1] === '-') {
                return;
            }

            tags[tagData[0]] = tagData[1];
        });

        return callback(null, tags);
    });
}


var NicUpdateTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(NicUpdateTask);


function start(callback) {
    var self = this;

    listTags(self.log, function (err, tagsBefore) {
        if (err) {
            self.log.error(err);
            return self.fatal({ error: 'nig tag list error: ' + err.message });
        }

        var admCommands = [];
        var seenMacs = {};
        var seenTags = {};

        self.progress(20);
        self.req.params.nics.forEach(function (nic) {
            seenMacs[nic.mac] = true;
            if (!nic.hasOwnProperty('nic_tags_provided')) {
                self.log.warn('nic "' + nic.mac
                    + '" has no nic_tags_provided property; skipping');
                return;
            }

            nic.nic_tags_provided.forEach(function (tag) {
                self.log.debug('nic=' + nic.mac + ', tag=' + tag);
                if (seenTags.hasOwnProperty(tag)) {
                    return;
                }

                seenTags[tag] = true;

                if (tagsBefore.hasOwnProperty(tag)) {
                    if (tagsBefore[tag] != nic.mac) {
                        // tag has moved from one nic to another: this is
                        // an update
                        admCommands.push(['update', tag, nic.mac]);
                    }

                    // tag has stayed the same: move along.
                    delete tagsBefore[tag];
                    return;
                }

                // This tag didn't exist before: this is an add
                admCommands.push(['add', tag, nic.mac]);
                delete tagsBefore[tag];
            });
        });


        for (var leftTag in tagsBefore) {
            if (seenMacs.hasOwnProperty(tagsBefore[leftTag])) {
                // We've updated a nic so that it used to have a tag and no
                // longer does: this is a delete
                admCommands.push(['delete', leftTag]);
            }
        }

        self.log.debug('commands to execute: '
            + JSON.stringify(admCommands, null, 2));

        return async.forEachSeries(admCommands, function _run(args, cb) {
            execFile(NICTAGADM, args, function (err2, stdout, stderr) {
                if (err2) {
                    return cb(err2);
                }

                return cb();
            });

        }, function (err3) {
            if (err3) {
                self.log.error(err3);
                return self.fatal({ error: err3.message });
            }

            return self.finish();
        });
    });
}

NicUpdateTask.setStart(start);
