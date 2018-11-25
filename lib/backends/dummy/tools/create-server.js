/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

//
// For now, we do the same function that booter would do wrt adding NICs. In
// the future we should probably instead include a dhcp client and actually send
// DHCPDISCOVER and DHCPREQUEST messages to booter to emulate actual booting.
//
// Assumptions made include:
//
//  * The VM running this is on the admin network
//  * The VM has customer_metadata keys:
//      * ufdsAdmin -- set to the uuid of the admin user in ufds
//      * dnsDomain -- set to the dns_domain from /usbkey/config
//  * This runs as root
//  * The DC we're attaching to is the same as `mdata-get sdc:datacenter_name`
//  * NAPI is at napi.<datacenterName>.<dnsDomain>
//  * If /var/tmp/latest-agentsshar.sh exists, install those agents for this new
//    CN.
//
// TODO:
//
//  * If MAC is used, generate a new one and try again instead of blowing up
//
// Eventually:
//
//  * allow custom disk setups
//  * allow customizing other parameters: cpus, memory, product, serial, etc.
//

var fs = require('fs');

var assert = require('assert-plus');
var bunyan = require('bunyan');
var child_process = require('child_process');
var jsprim = require('jsprim');
var NAPI = require('sdc-clients').NAPI;
var uuid = require('uuid');
var vasync = require('vasync');

var common = require('../common');
var shared = require('../tasks/shared');

var logger = bunyan.createLogger({
    level: 'debug',
    name: 'create-server.js'
});
var SERVER_ROOT = common.SERVER_ROOT;
var TEMPLATE = {
    'System Type': 'Virtual',
    'SDC Version': '7.0',
    'Manufacturer': 'Joyent',
    'Product': 'Joyent-Virtual-CN-0001',
    'SKU Number': '90210 rev 42',
    'HW Version': '1.0',
    'HW Family': 'JXX-0001',
    'Setup': 'true',
    'VM Capable': true,
    'Bhyve Capable': true,
    'Bhyve Max Vcpus': 32,
    'CPU Type': 'Intel(R) Xeon(R) CPU E5-2670 0 @ 2.60GHz',
    'CPU Virtualization': 'vmx',
    'CPU Physical Cores': 2,
    'CPU Total Cores': 32,
    'MiB of Memory': '262111',
    'Zpool': 'zones',
    'Zpool Disks': '',
    'Zpool Profile': 'mirror',
    'Disks': {
    },
    'Boot Parameters': {
        'console': 'ttyb',
        'boot_args': '',
        'bootargs': ''
    },
    'SDC Agents': [], // This is something we're trying to remove from Triton
    'Network Interfaces': {
        'dnet0': {'ip4addr': '', 'Link Status': 'up', 'NIC Names': ['admin']},
        'dnet1': {'ip4addr': '', 'Link Status': 'up', 'NIC Names': []}
    },
    'Virtual Network Interfaces': {},
    'Link Aggregations': {}
};
var OUI = '00:10:fe'; // thanks DEC!

function randomOctet() {
    var octet;

    octet = Math.floor(Math.random() * 256).toString(16);
    while (octet.length < 2) {
        octet = '0' + octet;
    }

    return (octet);
}

function generateMac() {
    var octetIdx;
    var mac = OUI;

    for (octetIdx = 3; octetIdx <= 5; octetIdx++) {
        mac = mac + ':' + randomOctet();
    }

    return (mac);
}

function populateNics(ctx, callback) {
    assert.object(ctx, 'ctx');
    assert.object(ctx.serverObj, 'ctx.serverObj');
    assert.object(ctx.serverObj['Network Interfaces'],
        'ctx.serverObj[Network Interfaces]');
    assert.func(callback, 'callback');

    var mac;
    var nicKeys;
    var nics;

    if (!ctx.napi) {
        ctx.napi = new NAPI({
            url: 'http://napi.' +
                ctx.datacenterName + '.' +
                ctx.dnsDomain
        });
    }

    nics = ctx.serverObj['Network Interfaces'];
    nicKeys = Object.keys(nics);

    function populateNic(nicName, cb) {
        if (!nics[nicName]['MAC Address']) {
            nics[nicName]['MAC Address'] = generateMac();
        }
        mac = nics[nicName]['MAC Address'];

        ctx.napi.getNic(mac, function (err, res) {
            var createParams = {};

            if (!err) {
                cb(new Error('NIC already exists in NAPI: ' +
                    JSON.stringify(res)));
                return;
            }
            if (err.name !== 'ResourceNotFoundError') {
                console.error('Unexpected error: ' + err.message);
                cb(err);
                return;
            }
            // Here we know the NIC doesn't exist, so we add it.
            if (nics[nicName]['NIC Names'].indexOf('admin') !== -1) {
                createParams.belongs_to_type = 'other'; // what booter does
                createParams.belongs_to_uuid = ctx.ufdsAdmin;
                createParams.mac = mac;
                createParams.nic_tags_provided = nics[nicName]['NIC Names'];
                createParams.owner_uuid = ctx.ufdsAdmin;

                ctx.napi.provisionNic('admin', createParams,
                    function onProvision(provErr, provRes) {

                    if (provErr) {
                        console.error(provErr, 'Error provisioning NIC[' + mac +
                            ']: ' + provErr.message);
                        cb(provErr);
                        return;
                    }

                    assert.string(provRes.ip, 'res.ip');
                    nics[nicName].ip4addr = provRes.ip;

                    cb();
                });
            } else {
                cb();
            }
        });
    }

    vasync.forEachPipeline({
        func: populateNic,
        inputs: nicKeys
    }, function (err) {
        callback(err);
    });
}

function generateUuid(ctx, callback) {
    ctx.serverObj.UUID = uuid.v4();
    callback();
}

function fillInBlanks(ctx, callback) {
    var shortId = ctx.serverObj.UUID.substr(0, 8).toUpperCase();
    var now = Math.floor((new Date()).getTime() / 1000);

    ctx.serverObj['Boot Time'] = now.toString(); // goofy, but compatible
    ctx.serverObj['Hostname'] = 'VC' + shortId;
    ctx.serverObj['Serial Number'] = shortId;
    ctx.serverObj['Zpool Creation'] = now;

    callback();
}

function diskName(idx) {
    var disk = '';
    var prefix = 'c' + idx + 't5000';
    var suffix = 'd0';

    disk = prefix +
        (randomOctet() +
        randomOctet() +
        randomOctet()).toUpperCase() +
        suffix;

    return (disk);
}

function addDisks(ctx, callback) {
    var disk;
    var idx = 0;

     ctx.serverObj['Zpool Size in GiB'] = 3770;
     for (idx = 0; idx < 16; idx++) {
         disk = diskName(idx);
         if (ctx.serverObj['Zpool Disks'].length > 0) {
             ctx.serverObj['Zpool Disks'] += ',';
         }
         ctx.serverObj['Zpool Disks'] += disk;
         ctx.serverObj['Disks'][disk] = {'Size in GB': 600};
     }

     callback();
}

function getDatacenterName(ctx, callback) {
    common.mdataGet('sdc:datacenter_name', function _onMdata(err, datacenter) {
        ctx.datacenterName = datacenter;
        ctx.serverObj['Datacenter Name'] = datacenter;
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

function getUfdsAdmin(ctx, callback) {
    common.mdataGet('ufdsAdmin', function _onMdata(err, ufdsAdmin) {
        assert.uuid(ufdsAdmin, 'ufdsAdmin');
        ctx.ufdsAdmin = ufdsAdmin;
        callback();
    });
}

function getPlatformBuildstamp(ctx, callback) {
    common.getPlatformBuildstamp(function _onBuildstamp(err, buildstamp) {
        if (!err) {
            ctx.serverObj['Live Image'] = buildstamp;
        }

        callback(err);
    });
}

function makeDirs(ctx, callback) {
    var serverDir = SERVER_ROOT + '/' + ctx.serverObj.UUID;

    child_process.execFile('/bin/mkdir', [
        '-p', serverDir + '/vms'
    ], function _onMkdir(err, stdout, stderr) {
        assert.ifError(err, 'mkdir should always work');

        ctx.serverDir = serverDir;

        callback(err);
    });
}

function writeSysinfo(ctx, callback) {
    var data;
    var filename = ctx.serverDir + '/sysinfo.json';

    data = JSON.stringify(ctx.serverObj, null, 4) + '\n';

    fs.writeFile(filename, data, function _wroteSysinfo(err) {
        if (!err) {
            console.log('wrote sysinfo (%s)', filename);
        }

        callback(err);
    });
}

function installAgents(ctx, callback) {
    assert.object(ctx, 'ctx');
    assert.object(ctx.serverObj, 'ctx.serverObj');
    assert.uuid(ctx.serverObj.UUID, 'ctx.serverObj.UUID');
    assert.func(callback, 'callback');

    var agentsShar = '/var/tmp/agentsshar-latest.sh';
    var serverUuid = ctx.serverObj.UUID;

    //
    // TODO: for now, we just assume someone else has installed the shar to
    //       /var/tmp/agentsshar-latest.sh for us. In the future, we should
    //       probably learn to download it ourselves when it's missing.
    //
    fs.access(agentsShar, fs.constants.F_OK, function onAccess(err) {
        var exists = (err ? false : true);

        if (!exists) {
            logger.warn({
                agentsShar: agentsShar,
                err: err
            }, 'unable to access agentsshar, skipping agents install');
            callback();
            return;
        }

        shared.installAgentsShar({
            log: logger,
            serverUuid: serverUuid,
            sharFile: agentsShar
        }, function onInstall(installErr) {
            if (installErr) {
                logger.warn({
                    agentsShar: agentsShar,
                    err: installErr
                }, 'failed to install agentsshar');
            }
            callback(installErr);
        });
    });
}

function createServer(callback) {
    var ctx = {};

    ctx.serverObj = jsprim.deepCopy(TEMPLATE);

    vasync.pipeline({
        arg: ctx,
        funcs: [
            getUfdsAdmin,
            getDatacenterName,
            getDNSDomain,
            generateUuid,
            makeDirs,
            populateNics,
            addDisks,
            getPlatformBuildstamp,
            fillInBlanks,
            writeSysinfo,
            installAgents
        ]
    }, function _pipelineComplete(err) {
        callback(err, ctx.serverObj);
    });
}

function main() {
    createServer(function _created(err, serverObj) {
        if (err) {
            console.error('failed to create server: ' + err.message);
            return;
        }
        console.error('created server: ' + serverObj.UUID);
    });
}

main();
