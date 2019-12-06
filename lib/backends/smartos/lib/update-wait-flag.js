/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 *
 * EXPLANATION:
 *
 * The "docker:wait_for_attach" flag is used to coordinate between docker_exec
 * and dockerinit. When a user does `docker run -it ubuntu` what the docker
 * client does (assuming we've already got the image) is:
 *
 *  * do a "create"
 *     * wait for that to return (which on sdc-docker means provision success)
 *  * call "attach"
 *     * DO NOT WAIT for it to be acknowledged
 *  * call "start" (typically 1~2ms after attach was called)
 *     * wait for start to complete
 *
 * The problem here for us is that when someone calls "attach" the job gets to
 * the CN before the VM has been started. As such, we need to wait until the VM
 * is started before we're able to zlogin -I to the console. However, if we just
 * naively poll, we may end up doing the zlogin *after* data has already been
 * written by the application in which case we will miss it.
 *
 * In order to solve this problem, when we get "attach" we immediately set the
 * "docker:wait_for_attach" flag in metadata to a timestamp 60 seconds in the
 * future. Then, when the start message comes in, dockerinit will check for this
 * metadata key. If it exists, we pause before running the user program. We
 * continue to pause until either:
 *
 *  a) the "docker:wait_for_attach" has been removed
 *  b) the timestamp in the value has passed
 *
 * If we hit a), we continue as normal. If we hit b) dockerinit will log a
 * message to /var/log/sdc-dockerinit.log and exit with a non-zero exit code.
 *
 * The "docker:wait_for_attach" will be removed, causing us to hit case a),
 * when the docker-stdio process forked by the docker_exec task gets a
 * connection and starts the zlogin session. This way the zlogin will be
 * connected to the zone's console while still in dockerinit and therefore
 * at the point where the user's program is run.
 *
 */

var fs = require('fs');
var lock = require('qlocker').lock;

function setWaitFlag(uuid, filename, timeout, log, callback)
{
    return updateWaitFlag(uuid, 'set', filename, timeout, log, callback);
}

function unsetWaitFlag(uuid, filename, timeout, log, callback)
{
    return updateWaitFlag(uuid, 'unset', filename, timeout, log, callback);
}

/*
 * uuid          - uuid of the VM this impacts
 * action        - either 'set' or 'unset'
 * filename      - the /zones/<uuid>/config/metadata.json name
 * timeout       - the time this request should expire
 * log           - a bunyan logger
 * callback(err) - to be called on completion
 *
 */
function updateWaitFlag(uuid, action, filename, timeout, log, callback)
{
    var lockpath = '/var/run/vm.' + uuid + '.config.lockfile';
    var unlock;

    log.debug('acquiring lock on ' + lockpath);
    lock(lockpath, function (err, _unlock) {
        if (err) {
            log.error('failed to acquire lock on ' + lockpath);
            callback(err);
            return;
        }
        log.debug('acquired lock on ' + lockpath);
        unlock = _unlock;

        fs.readFile(filename, 'utf8', function (error, data) {
            var mdata;
            var tmp_filename;

            if (error) {
                log.error(error, 'failed to load ' + filename);
                callback(error);
                return;
            }

            try {
                mdata = JSON.parse(data);
            } catch (e) {
                callback(e);
                return;
            }

            if (action === 'unset') {
                if (timeout && mdata.internal_metadata['docker:wait_for_attach']
                     === timeout) {

                    log.debug('removing "docker:wait_for_attach"');
                    delete mdata.internal_metadata['docker:wait_for_attach'];
                } else if (!timeout) {
                    log.debug('removing "docker:wait_for_attach" (no timeout)');
                    delete mdata.internal_metadata['docker:wait_for_attach'];
                } else {
                    log.debug('not removing "docker:wait_for_attach" as '
                        + 'timestamp does not match');
                }
            } else if (action === 'set') {
                log.debug('setting "docker:wait_for_attach" = ' + timeout);
                mdata.internal_metadata['docker:wait_for_attach']
                    = timeout.toString();
            } else {
                throw new Error('Unknown action: ' + action);
            }

            tmp_filename = filename + '.tmp.' + process.pid;
            fs.writeFile(tmp_filename, JSON.stringify(mdata, null, 2), 'utf8',
                function (write_err) {

                if (write_err) {
                    log.error(write_err, 'failed to write ' + tmp_filename);
                    callback(write_err);
                    return;
                } else {
                    fs.rename(tmp_filename, filename, function (rename_err) {
                        if (rename_err) {
                            log.error(rename_err, 'failed to rename '
                                + tmp_filename + ' to ' + filename);
                            callback(rename_err);
                            return;
                        }
                        log.debug('releasing lock on ' + lockpath);
                        unlock(function (unlock_err) {
                            if (unlock_err) {
                                callback(unlock_err);
                                return;
                            }
                            log.debug('released lock on ' + lockpath);
                            callback();
                        });
                    });
                }
            });
        });
    });
}

module.exports = {
    setWaitFlag: setWaitFlag,
    unsetWaitFlag: unsetWaitFlag
};
