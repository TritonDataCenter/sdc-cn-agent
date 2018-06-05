/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

//
// Assumptions made include:
//
//  * This runs as root
//  * The DC we're attaching to is the same as `mdata-get sdc:datacenter_name`
//  * CNAPI is at cnapi.<datacenterName>.<dnsDomain>
//  * NAPI is at napi.<datacenterName>.<dnsDomain>
//  * VMAPI is at vmapi.<datacenterName>.<dnsDomain>
//

var fs = require('fs');

var assert = require('assert-plus');
var CNAPI = require('sdc-clients').CNAPI;
var child_process = require('child_process');
var jsprim = require('jsprim');
var NAPI = require('sdc-clients').NAPI;
var uuid = require('uuid');
var vasync = require('vasync');
var VMAPI = require('sdc-clients').VMAPI;

var common = require('../common');

var SERVER_ROOT = common.SERVER_ROOT;

function getDatacenterName(ctx, callback) {
    common.mdataGet('sdc:datacenter_name', function _onMdata(err, datacenter) {
        assert.string(datacenter, 'datacenter');
        ctx.datacenterName = datacenter;
        callback();
    });
}

function getDNSDomain(ctx, callback) {
    common.mdataGet('dnsDomain', function _onMdata(err, dnsDomain) {
        assert.string(dnsDomain, 'dnsDomain');
        ctx.dnsDomain = dnsDomain;
        callback();
    });
}

function deleteServerDir(ctx, callback) {
    var server_uuid = ctx.server_uuid;
    var serverDir = SERVER_ROOT + '/' + server_uuid;

    child_process.execFile('/bin/rm', [
        '-rf', serverDir
    ], function _onRmdir(err, stdout, stderr) {
        if (!err) {
            console.error('> deleted directory');
        }
        callback(err);
    });
}

function deleteServerRecord(ctx, callback) {
    var server_uuid = ctx.server_uuid;

    if (!ctx.cnapi) {
        ctx.cnapi = new CNAPI({
            url: 'http://cnapi.' +
                ctx.datacenterName + '.' +
                ctx.dnsDomain
        });
    }

    ctx.cnapi.del('/servers/' + server_uuid, function _onDel(err, req, res) {
        var code;

        if (err) {
            code = err.statusCode;
        } else {
            code = res.statusCode;
        }

        console.error('> delete CNAPI server: ' + code);

        if (err && err.restCode !== 'ResourceNotFound') {
            callback(err);
            return;
        }

        callback();
    });
}

function deleteNics(ctx, target_uuid, callback) {

    if (!ctx.napi) {
        ctx.napi = new NAPI({
            url: 'http://napi.' +
                ctx.datacenterName + '.' +
                ctx.dnsDomain
        });
    }

    function _deleteNic(nicObj, cb) {
        var mac = nicObj.mac;

        ctx.napi.deleteNic(mac, {}, {}, function _onDelete(err) {
            if (err) {
                console.error('error: ');
                console.dir(err);
            } else {
                console.error('> deleted %s', mac);
            }
            cb(err);
        });
    }

    ctx.napi.getNics(target_uuid, {}, function _onGet(err, nics) {
        var idx;

        if (err) {
            console.error('error: ');
            console.dir(err);
            callback(err);
            return;
        } else {
            console.error('> found %d NICs in NAPI', nics.length);
        }

        vasync.forEachPipeline({
            func: _deleteNic,
            inputs: nics
        }, function (err) {
            callback(err);
        });
    });

}

function deleteVMs(ctx, callback) {
    var server_uuid = ctx.server_uuid;

    if (!ctx.vmapi) {
        ctx.vmapi = new VMAPI({
            url: 'http://vmapi.' +
                ctx.datacenterName + '.' +
                ctx.dnsDomain
        });
    }

    function _deleteVm(vmObj, cb) {
        if (['destroyed', 'failed'].indexOf(vmObj.state) !== -1) {
            console.error('> VM %s is already %s', vmObj.uuid, vmObj.state);
            // Still clean up straggler NICs
            deleteNics(ctx, vmObj.uuid, cb);
            return;
        }

        // Since we deleted the server, we can remove the VM from the list by
        // just doing a sync GET.
        ctx.vmapi.get('/vms/' + vmObj.uuid + '?sync=true',
            function _onGet(err, req, res, data) {

            if (err) {
                console.error('error deleting %s: %s', vmObj.uuid, err.message);
                cb(err);
            } else {
                console.error('> deleted VM %s', vmObj.uuid);
                // Now clean up straggler NICs
                deleteNics(ctx, vmObj.uuid, cb);
            }
        });
    }

    ctx.vmapi.listVms({server_uuid: server_uuid}, {},
        function _onList(err, vms) {

        if (err) {
            console.error('error:');
            console.dir(err);
            callback(err);
            return;
        } else {
            console.error('> found %d VMs in VMAPI', vms.length);
        }

        vasync.forEachPipeline({
            func: _deleteVm,
            inputs: vms
        }, function (err) {
            callback(err);
        });
    });
}

function deleteServer(server_uuid, callback) {
    var ctx = {};

    ctx.server_uuid = server_uuid;

    vasync.pipeline({
        arg: ctx,
        funcs: [
            getDatacenterName,
            getDNSDomain,
            deleteServerDir,
            deleteServerRecord,
            function _deleteNics(ctx, cb) {
                deleteNics(ctx, server_uuid, cb);
            },
            deleteVMs
        ]
    }, function _pipelineComplete(err) {
        callback(err);
    });
}

function main() {
    var server_uuid = process.argv[2];

    assert.uuid(server_uuid, 'server_uuid');

    console.error('deleting: %s', server_uuid);

    deleteServer(server_uuid, function _deleted(err) {
        if (err) {
            console.error('failed to delete server: ' + err.message);
            return;
        }
        console.error('DELETED');
    });
}

main();
