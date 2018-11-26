/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018 Joyent, Inc.
 */

/*
 * This task installs agents on this mock CN. The only parameter accepted is
 * 'image_uuid' which is expected to be an image that exists in the local
 * DC's imgapi.
 *
 * The task will:
 *
 *  * download the manifest (to memory)
 *  * download the file (to /var/tmp/<server_uuid>/)
 *  * check vs. the sha1 and size from the manifest
 *  * name the file according to the compression
 *  * confirm the file contains image_uuid (it's an agent image)
 *  * extract image_uuid and package.json into place in
 *    (SERVER_ROOT/<server_uuid>/agents/<agent>/)
 *  * delete the temporary file from /var/tmp/<server_uuid>/
 *  * refresh CNAPI's view of the agents
 *
 * if there are errors at any point in this process, it will leave things as
 * they are for investigation.
 *
 * This task should be idempotent as running multiple times with the same
 * image_uuid should result in that version of the agent being installed.
 *
 *  "SELF-UPDATING" cn-agent:
 *
 *  Since updating agents here does not actually modify the running cn-agent,
 *  updating cn-agent works the same as every other agent. In the future we may
 *  want to make this behave slightly differently with cn-agent in order to
 *  mimick the real update behavior.
 *
 */


var child_process = require('child_process');
var execFile = child_process.execFile;
var fs = require('fs');
var path = require('path');

var assert = require('assert-plus');
var vasync = require('vasync');

var backendCommon = require('../../common');
var common = require('../common');
var shared = require('./shared');
var Task = require('../../../task_agent/task');

var SERVER_ROOT = common.SERVER_ROOT;


function AgentInstallTask(req) {
    Task.call(this);
    this.req = req;
}


Task.createTask(AgentInstallTask);

function start() {
    var self = this;

    assert.object(self.sysinfo, 'self.sysinfo');
    assert.uuid(self.sysinfo.UUID, 'self.sysinfo.UUID');

    var imgapiUrl;
    var imageUuid = self.req.params.image_uuid;
    var tmpdir = path.join('/var/tmp/', self.sysinfo.UUID);

    vasync.pipeline({ arg: { server_uuid: self.sysinfo.UUID }, funcs: [
        function getImgapiAddress(ctx, cb) {
            common.getSdcConfig(function onConfig(err, config) {
                if (!err) {
                    imgapiUrl = 'http://imgapi.' + config.datacenter_name + '.'
                        + config.dns_domain;
                }
                cb(err);
            });
        },
        function mkTempDir(ctx, cb) {
            fs.mkdir(tmpdir, function onMkdir(err) {
                if (err && err.code !== 'EEXIST') {
                    cb(err);
                    return;
                }

                cb();
            });
        },
        function getImage(ctx, cb) {
            backendCommon.getAgentImage(imageUuid, {
                imgapiUrl: imgapiUrl,
                log: self.log,
                outputDir: tmpdir,
                outputPrefix: imageUuid
            }, function _gotAgentImage(err, file, name) {
                if (err) {
                    return cb(err);
                }

                self.log.debug('downloaded agent %s image %s to %s',
                    name, imageUuid, file);

                ctx.package_file = file;
                return cb();
           });
        },
        function installAgent(ctx, cb) {
            shared.installAgent({
                agentFile: ctx.package_file,
                log: self.log,
                serverUuid: self.sysinfo.UUID
            }, cb);
        },
        function sendAgentsToCNAPI(ctx, cb) {
            // Since the agent has been updated at this point, the task will
            // return success. So any failure to tell CNAPI is logged only.
            shared.refreshAgents({
                log: self.log,
                serverUuid: self.sysinfo.UUID
            }, function (err) {
                if (err) {
                    self.log.error({
                        err: err
                    }, 'Error posting agents to CNAPI');
                } else {
                    self.log.info('Agents info updated in CNAPI');
                }
                return cb();
            });
        }
    ]}, function agentInstallTaskCb(err) {
        if (err) {
            self.fatal('AgentInstall error: ' + err.message);
            return;
        }

        self.progress(100);
        self.finish();
    });
}

AgentInstallTask.setStart(start);

module.exports = AgentInstallTask;
