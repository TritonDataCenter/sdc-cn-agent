/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * A dummy version of node-vmadm
 *
 * XXX eventually this could just go in node-vmadm probably.
 */

var cp = require('child_process');
var fs = require('fs');
var path = require('path');
var spawn = cp.spawn;
var stream = require('stream');
var util = require('util');

var assert = require('assert-plus');
var jsprim = require('jsprim');
var vasync = require('vasync');

var common = require('../common');


function vmadm() {}


function addSystemProperties(arg, callback) {
    // we know we loaded sysinfo if we got here
    assert.object(arg, 'arg');
    assert.object(arg.sysinfo, 'arg.sysinfo');
    assert.object(arg.vmobj, 'arg.vmobj');

    assert.uuid(arg.sysinfo.UUID, 'arg.sysinfo.UUID');
    arg.vmobj.server_uuid = arg.sysinfo.UUID;

    assert.string(arg.sysinfo['Datacenter Name'],
        'arg.sysinfo[\'Datacenter Name\']');
    arg.vmobj.datacenter_name = arg.sysinfo['Datacenter Name'];

    assert.string(arg.sysinfo['Live Image'], 'arg.sysinfo[\'Live Image\']');
    arg.vmobj.platform_buildstamp = arg.sysinfo['Live Image'];

    // zpool?

    callback();
}

function addInstanceExecutionInfo(arg, callback) {
    var last_modified;

    // XXX we just make stuff up for now
    assert.object(arg, 'arg');
    assert.object(arg.vmobj, 'arg.vmobj');

    if (arg.vmobj.state === undefined) {
        arg.vmobj.state = 'running';
    }

    if (arg.vmobj.state === 'running') {
        last_modified = (new Date(arg.vmobj.last_modified)).getTime();
        arg.vmobj.pid = Math.floor(last_modified / 1000) % 100000;
        if (arg.vmobj.boot_timestamp === undefined) {
            arg.vmobj.boot_timestamp = arg.vmobj.last_modified;
        }
    } else if (arg.vmobj.state === 'stopped') {
        arg.vmobj.exit_status = 0;
        if (arg.vmobj.exit_timestamp === undefined) {
            arg.vmobj.exit_timestamp = arg.vmobj.last_modified;
        }
    }

    callback();
}

function addHardcodedProperties(arg, callback) {
    // these make no sense here, so we hardcode them to something for compat
    assert.object(arg, 'arg');
    assert.object(arg.vmobj, 'arg.vmobj');

    assert.uuid(arg.vmobj.uuid, 'arg.vmobj.uuid');
    arg.vmobj.zonename = arg.vmobj.uuid;

    assert.string(arg.vmobj.state, 'arg.vmobj.state');
    arg.vmobj.zone_state = arg.vmobj.state;

    assert.optionalNumber(arg.vmobj.pid, 'arg.vmobj.pid');
    if (arg.vmobj.pid !== undefined) {
        arg.vmobj.zoneid = arg.vmobj.pid;
    }

    callback();
}

function loadTimestamp(arg, callback) {
    assert.object(arg, 'arg');
    assert.string(arg.file, 'arg.file');
    assert.object(arg.vmobj, 'arg.vmobj');

    fs.stat(arg.file, function _onStat(err, stats) {
        if (err) {
            callback(err);
            return;
        }

        arg.vmobj.last_modified = stats.mtime.toISOString();

        callback();
    });
}

function loadVm(opts, callback) {
   assert.object(opts, 'opts');
   assert.object(opts.sysinfo, 'opts.sysinfo');
   assert.uuid(opts.sysinfo.UUID, 'opts.sysinfo.UUID');
   assert.uuid(opts.uuid, 'opts.uuid');

   var filename;
   var server_uuid = opts.sysinfo.UUID;
   var sysinfo = opts.sysinfo;
   var uuid = opts.uuid;
   var vmobj = {};

   filename = path.join(common.SERVER_ROOT, server_uuid, 'vms', uuid + '.json');

   fs.readFile(filename, function _onRead(err, data) {
        if (err) {
            callback(err);
            return;
        }

        // XXX will throw on bad data
        vmobj = JSON.parse(data.toString());

        vasync.pipeline({
            arg: {
                file: filename,
                sysinfo: sysinfo,
                vmobj: vmobj
            },
            funcs: [
                loadTimestamp,
                addInstanceExecutionInfo,
                addSystemProperties,
                addHardcodedProperties
            ]
        }, function _afterPipeline(pipelineErr) {
            callback(pipelineErr, vmobj);
        });
    });
}

function loadVms(opts, callback) {
    var vmdir;

    vmdir = path.join(common.SERVER_ROOT, opts.sysinfo.UUID, 'vms');

    fs.readdir(vmdir, function _onReadDir(err, files) {
        var filename;
        var idx;
        var matches;
        var toLoad = [];

        if (err) {
            callback(err);
            return;
        }

        for (idx = 0; idx < files.length; idx++) {
            filename = files[idx];

            /* jsl:ignore (assignment in if()) */
            if (matches = filename.match(/^([a-f0-9\-]*).json$/)) {
                toLoad.push(matches[1]);
            } else {
                console.error('XXX WARNING: IGNORING: ' + filename);
            }
            /* jsl:end */
        }

        vasync.forEachParallel({
            func: function _loadVm(uuid, cb) {
                loadVm({
                    sysinfo: opts.sysinfo,
                    uuid: uuid
                }, cb);
            },
            inputs: toLoad
        }, function _afterLoading(loadErr, results) {
            callback(loadErr, results.successes);
        });
    });
}


/**
 * Check whether a VM exists or not.
 *
 * @param opts {Object} Options
 *      - uuid {String} The VM uuid.
 *      - log {Logger object}
 *      - include_dni {Boolean} If true, return VMs that have do_not_inventory
 *        set. default: false.
 * @param callback {Function} `function (err, exists)`
 *      - err is set on unhandled error
 *      - otherwise; exists will be true or false
 */

vmadm.exists = function vmExists(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    vmadm.load(opts, {fields: ['uuid']}, function _onLoad(err, vm) {
        if (err) {
            if (err.restCode === 'VmNotFound') {
                callback(null, false);
                return;
            }
            callback(err);
            return;
        }

        if (vm.do_not_inventory && !opts.include_dni) {
            /*
             * VM is marked do_not_inventory. And we don't have include_dni
             * option set indicating we want to include those, so we treat the
             * same as not existing.
             */
            opts.log.trace(err, 'vmadm.exists(): ' + opts.uuid +
                ' has do_not_inventory');
            callback(null, false);
            return;
        }

        callback(null, true);
        return;
    });
};


/**
 * Call `vmadm get UUID`.
 *
 * @param opts {Object} Options
 *      - uuid {String} The VM uuid.
 *      - log {Logger object}
 * @param vmopts {Object} Optional vm options
 *      - fields {Array} Return only the keys give in `fields` array
 *      - include_dni {Boolean} If true, return VMs that have do_not_inventory
 *        set. default: false.
 * @param callback {Function} `function (err)`
 */

vmadm.load = function vmLoad(opts, vmopts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');
    assert.object(opts.sysinfo, 'opts.sysinfo');
    assert.uuid(opts.sysinfo.UUID, 'opts.sysinfo.UUID');

    if (!callback) {
        callback = vmopts;
    }

    opts.log.trace({
        req_id: opts.req_id,
        uuid: opts.uuid
    }, 'loading VM');

    loadVm({
        sysinfo: opts.sysinfo,
        uuid: opts.uuid
    }, function _onVmLoad(err, vm) {
        var notFoundErr;

        if (err && err.code === 'ENOENT') {
            notFoundErr = new Error('vmadm load ' + opts.uuid +
                ' failed: No such zone');
            notFoundErr.restCode = 'VmNotFound';
            callback(notFoundErr);
            return;
        } else if (err) {
            callback(err);
            return;
        }

        if (vm.do_not_inventory && !opts.include_dni) {
            // Unless the caller is specifically asking for VMs that are
            // do_not_inventory, we treat them the same a VMs that don't exist.
            notFoundErr = new Error('vmadm load ' + opts.uuid +
                ' failed: No such zone');
            notFoundErr.restCode = 'VmNotFound';
            callback(notFoundErr);
            return;
        }

        if (opts.fields) {
            Object.keys(vm).forEach(function _removeUnwantedFields(field) {
                if (opts.fields.indexOf(field) === -1) {
                    // not a field we want
                    delete vm[field];
                }
            });
        }

        callback(null, vm);
        return;
    });
};


/**
 * Call `vmadm create`.
 *
 * @param opts {Object} Options
 *      - log {Logger object}
 * @param callback {Function} `function (err, info)`
 */

vmadm.create = function vmCreate(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.req_id, 'opts.req_id');

    var log = opts.log;
    var payload = opts;
    var sysinfo = jsprim.deepCopy(payload.sysinfo);
    var req_id;

    req_id = opts.req_id;

    delete payload.log;
    delete payload.req_id;
    delete payload.sysinfo;
    delete payload.vmadmLogger;

    log.trace({
        req_id: req_id,
        payload: payload
    }, 'creating VM');

    assert.uuid(payload.uuid, 'payload.uuid');

    payload.state = 'running';
    payload.autoboot = true;
    payload.create_timestamp = (new Date()).toISOString();

    // TODO:
    //
    //   strip out properties we don't care about, validate ones we do.
    //   convert disks to final versions
    //   fill in other fields that happen in real vmadm
    //

    writeVm(payload, {
        log: log,
        sysinfo: sysinfo
    }, function _onWrite(err) {
        callback(err);
    });
};


/**
 * Call `vmadm delete <uuid>`.
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID of VM to delete
 *      - log {Logger object}
 *      - include_dni {Boolean} If true, delete VMs that have do_not_inventory
 *        set. default: false.
 * @param callback {Function} `function (err)`
 */

vmadm.delete = function vmDelete(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    var filename;
    var vmdir;

    vmdir = path.join(common.SERVER_ROOT, opts.sysinfo.UUID, 'vms');

    opts.log.trace({
        req_id: opts.req_id,
        uuid: opts.uuid
    }, 'deleting VM');

    assert.uuid(opts.uuid, 'opts.uuid');
    filename = path.join(vmdir, opts.uuid + '.json');

    vasync.pipeline({
        funcs: [
            // TODO: stop the instance, do any other cleanup
            function _unlinkFile(_, cb) {
                fs.unlink(filename, function _onUnlink(err) {
                    if (err) {
                        cb(err);
                        return;
                    }

                    cb();
                });
            }
        ]
    }, function _onDeleted(err) {
        opts.log.info({err: err, uuid: opts.uuid}, 'delete VM');
        callback(err);
    });
};


/**
 * Call `vmadm update`.
 *
 * @param opts {Object} VMADM update payload
 *      - log {Logger object}
 *      - include_dni {Boolean} If true, update VMs that have do_not_inventory
 *        set. default: false.
 * @param callback {Function} `function (err)`
 */

vmadm.update = function vmUpdate(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    var log = opts.log;
    var payload = opts;
    var req_id = opts.req_id;

    delete payload.log;
    delete payload.req_id;
    delete payload.vmadmLogger;

    log.trace({
        payload: payload,
        req_id: req_id,
        uuid: opts.uuid
    }, 'updating VM');

    // TODO: this should actually update

    callback();
};


function writeVm(vmobj, opts, callback) {
    var fd;
    var filename;
    var finalFilename;
    var vmdir;

    vmdir = path.join(common.SERVER_ROOT, opts.sysinfo.UUID, 'vms');
    filename = path.join(vmdir, vmobj.uuid + '.json');

    if (opts.atomicReplace) {
        finalFilename = filename;
        filename = filename + '.' + process.pid;
    }

    vasync.pipeline({
        funcs: [
            function _openFile(_, cb) {
                fs.open(filename, 'wx', function _onOpen(err, openedFd) {
                    if (err) {
                        cb(err);
                        return;
                    }

                    fd = openedFd;
                    cb();
                });
            }, function _writeThenCloseFile(_, cb) {
                var buf = new Buffer(JSON.stringify(vmobj, null, 2));

                fs.write(fd, buf, 0, buf.length, null, function _onWrite(err) {
                    if (err) {
                        cb(err);
                        return;
                    }
                    fs.close(fd, function _onWritten() {
                        cb();
                    });
                });
            }, function _atomicReplace(_, cb) {
                if (!opts.atomicReplace) {
                    cb();
                    return;
                }

                fs.rename(filename, finalFilename, cb);
            }
        ]
    }, function _onWroteVm(err) {
        opts.log.info({err: err, uuid: vmobj.uuid}, 'wrote VM');
        callback(err);
    });
}


/**
 * Call `vmadm reboot <uuid>`.
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID of VM to reboot
 *      - force {Boolean} Whether to force the reboot.
 *      - log {Logger object}
 *      - include_dni {Boolean} If true, reboot VMs that have do_not_inventory
 *        set. default: false.
 * @param callback {Function} `function (err)`
 */

vmadm.reboot = function vmReboot(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    var args = [];

    if (opts.force) {
        args.push('-F');
    }

    opts.log.trace({
        args: args,
        force: Boolean(opts.force),
        req_id: opts.req_id,
        uuid: opts.uuid
    }, 'rebooting VM');

    // TODO: this should actually reboot

    callback();
};


/**
 * Call `vmadm lookup -j`.
 *
 * @param opts {Object} Options
 *      - uuid {String} The VM uuid.
 *      - log {Logger object}
 * @param vmopts {Object} Optional vm options
 *      - fields {Array} Return only the keys give in `fields` array
 *      - include_dni {Boolean} If true, return VMs that have do_not_inventory
 *        set. default: false.
 * @param callback {Function} `function (err, vms)`
 */

vmadm.lookup = function vmLookup(search, opts, callback) {
    assert.object(search, 'search');
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    opts.log.error({
        req_id: opts.req_id,
        search: search
    }, 'lookup VMs');


    // XXX can't we also specify fields in opts?

    loadVms({}, function _onLoadVms(err, loadedVms) {
        if (err) {
            callback(err);
            return;
        }

        if (JSON.stringify(search) === '{}') {
            // no search, just return all VMs
            callback(null, loadedVms);
            return;
        }

        assert.ok(false, 'Don\'t yet know how to handle search: ' + JSON.stringify(search));
    });
};


/**
 * Call `vmadm start <uuid>`.
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID of VM to start
 *      - log {Logger object}
 *      - include_dni {Boolean} If true, start VMs that have do_not_inventory
 *        set. default: false.
 * @param callback {Function} `function (err)`
 */

vmadm.start = function vmStart(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    opts.log.trace({
        req_id: opts.req_id,
        uuid: opts.uuid
    }, 'start VM');


    // TODO: this should actually do the start

    loadVm({
        sysinfo: opts.sysinfo,
        uuid: opts.uuid
    }, function _onLoad(err, vmobj) {
        if (err) {
            callback(err);
            return;
        }

        vmobj.autoboot = true;
        vmobj.state = 'running';

        writeVm(vmobj, {
            atomicReplace: true,
            log: opts.log,
            sysinfo: opts.sysinfo
        }, function _onWrite(writeErr) {
            callback(writeErr);
        });
    });
};


/**
 * Call `vmadm stop <uuid>`.
 *
 * @param opts {Object} Options
 *      - uuid {String} UUID of VM to stop
 *      - force {Boolean} Whether to force the stop
 *      - log {Logger object}
 *      - include_dni {Boolean} If true, stop VMs that have do_not_inventory
 *        set. default: false.
 *      - timeout {Number} If set, timeout in seconds between sending SIGTERM
 *        and SIGKILL when stopping docker containers.
 * @param callback {Function} `function (err)`
 */

vmadm.stop = function vmStop(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.optionalNumber(opts.timeout, 'opts.timeout');
    assert.string(opts.uuid, 'opts.uuid');
    assert.optionalBool(opts.include_dni, 'opts.include_dni');

    opts.log.trace({
        req_id: opts.req_id,
        uuid: opts.uuid
    }, 'stop VM');

    // TODO: this should actually do the stop

    loadVm({
        sysinfo: opts.sysinfo,
        uuid: opts.uuid
    }, function _onLoad(err, vmobj) {
        if (err) {
            callback(err);
            return;
        }

        vmobj.autoboot = false;
        vmobj.state = 'stopped';

        writeVm(vmobj, {
            atomicReplace: true,
            log: opts.log,
            sysinfo: opts.sysinfo
        }, function _onWrite(writeErr) {
            callback(err);
        });
    });
};


vmadm._deleteAllWatchers = function _deleteAllWatchers() {
    var self = this;
    var filename;
    var idx;
    var keys;

    keys = Object.keys(self.fileWatches);
    for (idx = 0; idx < keys.length; idx++) {
        filename = keys[idx];

        console.error('DELETE WATCH: ' + filename);

        self.fileWatches[filename].close();
        delete self.fileWatches[filename];
    }
};

// wrap handler in a closure so we can keep the filename
function wrapHandler(filename, handler) {
    var fn = filename.slice(0);

    return (function _onFileEvent(evt) {
        handler(evt, fn);
    });
}

function zoneFromFilename(filename) {
    var matches;

    /* jsl:ignore (assignment in if()) */
    if (matches = filename.match(/^(.*)\.json$/)) {
        assert.uuid(matches[1], 'zonename');
        return (matches[1]);
    }
    /* jsl:end */

    return undefined;
}

vmadm._dispatchEvent = function _dispatchEvent(evtName, zonename, opts, handler) {
    var self = this;

    assert.string(evtName, 'evtName');
    assert.uuid(zonename, 'zonename');
    assert.object(opts, 'opts');
    assert.object(opts.sysinfo, 'opts.sysinfo');
    assert.func(handler, 'handler');

    if (self.loadingVms[zonename]) {
        console.error('skipping ' + zonename
            + ' which is already being loaded');
        return;
    }
    self.loadingVms[zonename] = (new Date()).getTime();

    loadVm({
        sysinfo: opts.sysinfo,
        uuid: zonename
    }, function _onVmLoad(err, vmobj) {
        delete self.loadingVms[zonename];

        if (err && err.code === 'ENOENT') {
            if (evtName === 'delete') {
                handler({
                    type: 'delete',
                    vm: {},
                    zonename: zonename
                });
            } else {
                console.error('VM ' + zonename + ' unexpectedly disappeared '
                    + 'while loading after ' + evtName);
            }
            return;
        }

       if (err) {
            console.error('error loading ' + zonename + ': ' + err.message);
            return;
        }

        handler({
            type: evtName,
            vm: vmobj,
            zonename: zonename
        });
    });
};

vmadm.events = function vmEvents(opts, handler, callback) {
    var self = this;

    var vmdir = path.join(common.SERVER_ROOT, opts.sysinfo.UUID, 'vms');

    self.fileWatches = {};
    self.loadingVms = {};

    // load initial set of files so we know when things change
    fs.readdir(vmdir, function _onReadDir(err, files) {
        var filename;
        var idx;
        var modifyHandler;

        // XXX what to do on error

        self.instanceFiles = files;

        for (idx = 0; idx < files.length; idx++) {
            filename = files[idx];

            if (!zoneFromFilename(filename)) {
                console.error('ignoring non-vm: ' + filename);
                continue;
            }

            // need to make a closure with a copy of the filename since
            // node doesn't give it to us w/ the event.
            modifyHandler = wrapHandler(filename, function _onModify(evt, fn) {
                fs.exists(path.join(vmdir, fn), function _onExists(exists) {
                    if (exists) {
                        self._dispatchEvent('modify', zoneFromFilename(fn),
                            {sysinfo: opts.sysinfo}, handler);
                    } else {
                        console.error('ignoring modify event for deleted '
                            + 'file: ' + fn);
                    }
                });
            });

            self.fileWatches[filename] =
                fs.watch(path.join(vmdir, filename), {}, modifyHandler);
        }
    });

    self.fileWatches[vmdir] =
    fs.watch(vmdir, {}, function _onDirEvent(evt) {
        fs.readdir(vmdir, function _onRead(err, files) {
            var filename;
            var idx;
            var modifyHandler;

            // XXX what to do on error

            // XXX this is a pretty inefficient way to generate the
            // added/deleted

            for (idx = 0; idx < files.length; idx++) {
                filename = files[idx];

                if (!zoneFromFilename(filename)) {
                    console.error('ignoring non-vm: ' + filename);
                    continue;
                }

                if (self.instanceFiles.indexOf(filename) === -1) {
                    // didn't exist before, exists now: added
                    assert.equal(self.fileWatches[filename], undefined,
                        'file should not already have a watcher');

                    // need to make a closure with a copy of the filename since
                    // node doesn't give it to us w/ the event.
                    modifyHandler = wrapHandler(filename,
                        function _onModify(_, fn) {

                        fs.exists(path.join(vmdir, fn),
                            function _onExists(exists) {

                            if (exists) {
                                self._dispatchEvent('modify',
                                    zoneFromFilename(fn),
                                    {sysinfo: opts.sysinfo}, handler);
                            } else {
                                console.error('ignoring modify event for '
                                    + 'deleted file: ' + fn);
                            }
                        });
                    });

                    self.fileWatches[filename] =
                        fs.watch(path.join(vmdir, filename), {},
                            modifyHandler);

                    self._dispatchEvent('create', zoneFromFilename(filename),
                        {sysinfo: opts.sysinfo}, handler);
                }
            }

            for (idx = 0; idx < self.instanceFiles.length; idx++) {
                filename = self.instanceFiles[idx];
                if (files.indexOf(filename) === -1) {
                    // existed before, doesn't exist now: deleted
                    if (self.fileWatches[filename]) {
                        self.fileWatches[filename].close();
                        delete self.fileWatches[filename];
                    }

                    self._dispatchEvent('delete', zoneFromFilename(filename),
                        {sysinfo: opts.sysinfo}, handler);
                }
            }

            // replace with new list
            self.instanceFiles = files;
        });
    });

    callback(null, {
        ev: {
            date: (new Date()).toISOString(),
            type: 'ready'
            // uuid: ?
            // vms: { "uuid": { ...
        },
        stop: function _stop() {
            self._deleteAllWatchers();
        }
    });
};

module.exports = vmadm;
