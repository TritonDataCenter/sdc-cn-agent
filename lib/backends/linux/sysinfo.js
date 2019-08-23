/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

// This file gathers all the data required for the sysinfo command.

var cp = require('child_process');
var EventEmitter = require('events').EventEmitter;
var exec = cp.exec;
var execFile = cp.execFile;
var fs = require('fs');
var os = require('os');
var spawn = cp.spawn;
var util = require('util');

var assert = require('assert-plus');
var async = require('async');
var sprintf = require('sprintf').sprintf;
var vasync = require('vasync');
var verror = require('verror');
var zfs = require('zfs').zfs;
var zpool = require('zfs').zpool;

var smartdc_config = require('./smartdc-config');

var LOG = null;

function getBasicInfo(callback)
{
    var sysinfo = {
        'SDC Version': '7.0',
        'Hostname': os.hostname(),
        'System Type': os.platform(),
        'VM Capable': false,
        'Bhyve Capable': false,
        'HVM API': false,
        'Live Image': '20190401T000000Z',   // XXX-mg fix
        'Admin NIC Tag': 'admin',           // XXX-mg fix
        'Boot Time': fs.statSync('/proc').birthtime.getTime()

        // Datacenter Name
        // Setup
        // Admin IP
        // Boot parameters
        // SDC Agents
    };

    callback(null, sysinfo);
}

/*
 * Gather the following sysinfo items:
 *
 * 'CPU Type'               "model name" from /proc/cpuinfo
 * 'CPU Physical Cores'     Not what you would think: # of sockets
 * 'CPU Total Cores'        Also misleading: # of threads
 * 'CPU Virtualization'     "vmx" (Intel), "svm" (AMD), or none
 */
function getCpuInfo(callback)
{
    fs.readFile('/proc/cpuinfo', function readCpuInfo(err, data) {
        if (err) {
            callback(err);
            return;
        }
        var model = null;
        var sockets = new Set();
        var threads = 0;
        var virt = '';      // XXX-mg verify

        var nextcpu = false;
        var lines = data.asciiSlice().split('\n');
        for (var line of lines) {

            // Don't bother splitting lines that will be of no interest
            if (line === '') {
                nextcpu = false;
                continue;
            }
            if (nextcpu) {
                continue;
            }

            var [key, value] = line.split(/\s*: /);

            if (key === 'processor') {
                threads++;
                continue;
            }
            if (key === 'physical id') {
                sockets.add(value);
                if (threads > 1) {
                    nextcpu = true;
                    continue;
                }
            }
            if (key === 'model name') {
                model = value;
                continue;
            }
            if (key === 'flags') {
                var flags = value.split(' ');
                if (flags.indexOf('vmx') !== -1) {
                    virt = 'vmx';
                } else if (flags.indexOf('svm') !== -1) {
                    virt = 'svm';
                }
            }
        }

        var sysinfo = {
            'CPU Type': model,
            'CPU Physical Cores': sockets.size,
            'CPU Total Cores': threads,
            'CPU Virtualization': virt
        }

        callback(null, sysinfo);
    });
}

/*
 * Gather the following sysinfo item:
 *
 * 'MiB of Memory'
 */
function getMemInfo(callback)
{
    fs.readFile('/proc/meminfo', function readMemInfo(err, data) {
        if (err) {
            callback(err);
            return;
        }
        var lines = data.asciiSlice().split('\n');

        for (var line of lines) {
            var [key, value, units] = line.split(/:\s*| /);
            if (key === 'MemTotal') {
                assert(units === 'kB');

                // XXX-mg SmartOS returns the value as a string.  Number OK?
                var sysinfo = {
                    'MiB of Memory': Math.floor(value / 1024)
                };

                callback(null, sysinfo);
                return;
            }
        }
    });
}

/*
 * Gather the following info about disks for sysinfo:
 *
 *  'Disks': {                          // XXX-mg lsblk -d -J -o name,size
 *     'sdc': {'Size in GB': 447},
 *     'sdd': {'Size in GB': 447},
 *  }
 */
function getDiskInfo(callback)
{
    execFile('/bin/lsblk', ['-Jbd', '-o', 'name,size'],
        function lsBlk(err, stdout, stderr) {

        var sysinfo = {
            'Disks': {}
        };

        if (err) {
            callback(err, {stdout: stdout, stderr: stderr});
            return;
        }

        var disks = JSON.parse(stdout);
        if (!disks.blockdevices) {
            callback(null, sysinfo);
            return;
        }
        disks = disks.blockdevices;

        for (var disk of disks) {
            sysinfo['Disks'][disk.name] = {
                'Size in GB': Math.floor(disk.size / 1000000000)
            };
        }

        callback(null, sysinfo);
    });
}

/*
 * Gather the following info about the system zfs pool:
 *
 * 'Zpool'              The system zpool
 * 'Zpool Disks'        The disks in that pool
 * 'Zpool Profile'      The layout (striped, raidz, etc.)
 * 'Zpool Creation'     When it was created
 * 'Zpool Size in GiB'  zfs used + available
 */
function getZpoolInfo(callback)
{
    var sysinfo = {};

    /*
     * There can be many pools on the system.  sysinfo is only concerned with
     * the system pool, which has a file .system_pool in the root directory of
     * the top-level dataset.
     *
     * In order to find the .system_pool file, we need to know where each
     * pool's top-level dataset is mounted.  Getting all other zfs properties
     * that we may need at the same time as we find the mount point is just
     * about free. Thus, we use one invocation of zfs(8) to get all the
     * zfs properties we may need and one invocation of zpool to get the pool
     * properties layout.
     */
    vasync.waterfall([
        function getRootDatasetProps(next) {
            var props = ['name', 'mountpoint', 'mounted', 'creation', 'used',
                'available'];
            execFile('/sbin/zfs', ['list', '-Hpo', props.join(','), '-d', '1'],
                function zfsList(err, stdout, stderr) {

                if (err) {
                    next(err);
                    return;
                }

                var dsprops = {};
                var lines = stdout.split('\n');

                for (var line of lines) {
                    var vals = line.split('\t');
                    var pool = vals[0];
                    dsprops[pool] = {};

                    for (var i in props) {
                        dsprops[pool][props[i]] = vals[i];
                    }
                }

                next(null, dsprops);
            });
        }, function selectSystemPool(dsprops, next) {
            vasync.forEachParallel({
                inputs: Object.keys(dsprops),
                func: function isSystemPool(pool, done) {
                    var props = dsprops[pool];

                    if (props.mounted !== 'yes') {
                        if (LOG) {
                            LOG.info({props: props},
                                'getZpoolInfo: top level dataset of pool ' +
                                pool + ' not mounted: not a system pool');
                            done();
                            return;
                        }
                    }
                    fs.access(props.mountpoint + '/.system_pool',
                        function dotSystemPoolExists(err) {

                        if (err) {
                            if (LOG) {
                                LOG.debug({props: props},
                                    'getZpoolInfo: not a system pool: ' + err);
                            }
                            done();
                        } else {
                            if (LOG) {
                                LOG.debug({props: props},
                                    'getZpoolInfo: found a system pool');
                            }
                            done(null, props);
                        }
                    });
                }
            },
            function systemPoolSelection(err, results) {
                if (err) {
                    next(err);
                    return;
                }
                var syspools = [];
                for (var result of results.successes) {
                    if (!result || !result.hasOwnProperty('name')) {
                        continue;
                    }

                    syspools.push(result.name);
                }

                if (syspools.length == 0) {
                    next(new Error('no system zfs pools'));
                    return;
                }
                if (syspools.length != 1) {
                    next(new Error('multiple system zfs pools: ' +
                        syspools.join(', ')));
                    return;
                }

                var selected = dsprops[syspools[0]];
                sysinfo['Zpool'] = selected.name;
                sysinfo['Zpool Size in GiB'] = Math.floor(
                    (Number(selected.used) + Number(selected.available)) /
                    (1024 * 1024 * 1024));
                sysinfo['Zpool Creation'] = Number(selected.creation);


                next(null, selected.name);
            });
        }, function getSystemPoolProfile(pool, next) {
            cp.execFile('/sbin/zpool', ['status', pool],
                function zpoolStatus(err, stdout, stderr) {

                if (err) {
                    next(err);
                    return;
                }

                var disks = [];
                var profile = 'stripe';

                // Pool config comes after first two newlines and has two
                // newlines after it.
                var lines = stdout.split('\n\n')[1].split('\n');

                for (var line of lines) {
                    // Skip header line and the line with pool name
                    if (!line.startsWith('\t ')) {
                        continue;
                    }

                    // We ignore the possibility of a mixture of vdev types, as
                    // that's bad idea and only allowed by zpool(8) with a force
                    // option.
                    var m = line.match(/\t +(mirror|raidz3|raidz2|raidz)-/);
                    if (m) {
                        profile = m[1];
                        continue;
                    }

                    m = line.match(/\t +([^\s]+)\s+/);
                    if (m) {
                        disks.push(m[1]);
                    }
                }

                sysinfo['Zpool Disks'] = disks;
                sysinfo['Profile'] = profile;

                next();
            });
        }],
        function getZpoolInfoDone(err) {
            callback(err, sysinfo);
        });
}

/*
 * Generates network elements in sysinfo. If sysinfo already has any of these
 * elements, they are replaced or removed to reflect the current state.
 *
 * Example elements:
 * 
 *  "Network Interfaces": {
 *    "igb0": {
 *      "MAC Address": "00:25:90:94:35:ac",
 *      "ip4addr": "",
 *      "Link Status": "up",
 *      "NIC Names": []
 *    },
 *    "ixgbe0": {
 *      "MAC Address": "90:e2:ba:2a:bb:e8",
 *      "ip4addr": "",
 *      "Link Status": "up",
 *      "NIC Names": []
 *    },
 *    "ixgbe1": {
 *      "MAC Address": "90:e2:ba:2a:bb:e9",
 *      "ip4addr": "",
 *      "Link Status": "up",
 *      "NIC Names": []
 *    },
 *    "aggr1": {
 *      "MAC Address": "90:e2:ba:2a:bb:e9",
 *      "ip4addr": "10.10.64.155",
 *      "Link Status": "up",
 *      "NIC Names": [
 *        "external",
 *        "internal",
 *        "sdc_underlay",
 *        "admin"
 *      ]
 *    }
 *  },
 *  "Virtual Network Interfaces": {
 *    "external0": {
 *      "MAC Address": "90:b8:d0:85:45:f8",
 *      "ip4addr": "165.225.170.229",
 *      "Link Status": "up",
 *      "Host Interface": "aggr1",
 *      "VLAN": "3105"
 *    },
 *    "sdc_underlay0": {
 *      "MAC Address": "90:b8:d0:3b:cc:06",
 *      "ip4addr": "172.24.1.14",
 *      "Link Status": "up",
 *      "Host Interface": "aggr1",
 *      "Overlay Nic Tags": [
 *        "sdc_overlay"
 *      ],
 *      "VLAN": "99"
 *    }
 *  },
 *  "Link Aggregations": {
 *    "aggr1": {
 *      "LACP mode": "active",
 *      "Interfaces": [
 *        "ixgbe1",
 *        "ixgbe0"
 *      ]
 *    }
 *  }
 * 
 */
function getNetInfo(callback)
{
    var sysinfo;

    execFile('/sbin/ip', ['-json', 'addr'], function ipA(err, stdout, stderr) {
        if (err) {
            callback(err, {'stdout': stdout, 'stderr': stderr});
            return;
        }
        var nets = JSON.parse(stdout);
        var netinfo = ipAddrToNetInfo(JSON.parse(stdout))

        var sysinfo = {
            'Network Interfaces': netinfo.nics,
            'Virtual Network Interfaces': netinfo.vnics,
            'Link Aggregations': netinfo.aggrs
        };

        callback(null, sysinfo);
    });
}

function ipAddrToNetInfo(nets)
{
    var nics = {};
    var vnics = {};
    var aggrs = {};
    var aggr_ifs = {};

    // XXX-mg does not handle vlan, vxlan.  vnic and aggr are questionable.
    for (var net of nets) {
        if (net.link_type !== 'ether') {
            continue;
        }

        var nic = {
            'MAC Address': net.address,
            'Link Status': net.operstate == 'UP' ? 'up' : 'down',
            'ip4addr': '',
            'NIC Names': []
        };
        nics[net.ifname] = nic;

        for (var addr of net.addr_info) {
            // XXX-mg what about inet6?
            if (addr.family !== 'inet') {
                continue;
            }
            if (addr.label === net.ifname) {
                nic.ip4addr = addr.local;
                continue;
            }

            // XXX-mg virtual IP as a vnic?  Is there something better?
            vnics[addr.label] = {
                'MAC Address': net.address,
                'ip4addr': addr.local,
                'Link Status': 'up',
                'Host Interface': net.ifname
            };
        }

        // Handle "link aggregation" (bond) lower links.  Order of keys in
        // 'ip a' output is not documented to have bond slave (lower link)
        // interfaces before master (bond, aggr) interfaces so stash the
        // mapping in a separate object for now.
        if (net.hasOwnProperty('master') && net.master != '') {
            if (!aggr_ifs.hasOwnProperty(net.master)) {
                aggr_ifs[net.master] = [];
            }
            aggr_ifs[net.master].push(net.ifname);
        }

        // Handle bond master links.
        if (net.flags.indexOf('MASTER') !== -1) {
            aggrs[net.ifname] = {
                'LACP mode': 'Unknown', // XXX-mg fix this
            };
        }
    }

    // Add slave links to master
    for (var aggr in aggrs) {
        aggrs[aggr]['Interfaces'] = aggr_ifs[aggr] || [];
    }

    return ({ nics: nics, vnics: vnics, aggrs: aggrs });
}

function getSmbiosInfo(callback)
{
    var sysinfo;

    execFile('/usr/sbin/dmidecode', ['-t', '1'],
        function dmiDecode(err, stdout, stderr) {

        if (err) {
            callback(err, {stdout: stdout, stderr: stderr});
            return;
        }

        // To match SmartOS smbios output
        var xlate = {
            'Family': 'HW_Family',
            'Manufacturer': 'Manufacturer',
            'Product Name': 'Product',
            'Serial Number': 'Serial_Number',
            'SKU Number': 'SKU_Number',
            // XXX-mg what's the deal with Fixed_UUID in SmartOS?
            'UUID': 'UUID',
            'Version': 'HW_Version'
        };

        var sysinfo = {};
        var lines = stdout.split(/\n\s*/);
        for (var line of lines) {
            var [key] = line.split(/: /, 1);
            if (xlate.hasOwnProperty(key)) {
                sysinfo[xlate[key]] = line.slice(key.length + 2);
            }
        }

        callback(null, sysinfo);
    });
}

function sysinfo(callback)
{
    vasync.parallel({
        'funcs': [
            getBasicInfo,
            getCpuInfo,
            getMemInfo,
            getDiskInfo,
            getZpoolInfo,
            getNetInfo,
            getSmbiosInfo
        ]
    }, function sysinfoDone(err, results) {
        var si = {};

        if (!err) {
            results.successes.unshift(si);
            Object.assign.apply(this, results.successes);
        }
        callback(err, si);
    });
}

module.exports = {
    log: LOG,
    sysinfo: sysinfo
};
