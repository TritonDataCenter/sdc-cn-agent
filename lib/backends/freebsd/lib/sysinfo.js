/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * To use this, you should create a file in /opt/smartdc/etc/config.json that
 * looks something like:
 *
 * {
 *    "datacenter_name": "coal",
 *    "dns_domain": "joyent.us",
 *    "nic_tags": {
 *        "00:50:56:27:61:65": ['admin'],
 *        "00:0c:29:ca:65:57": ['external']
 *    }
 * }
 *
 * to fill in the required information that we'd usually get via setup/boot
 * parameters. When this does not exist, we'll gather what we can, but consider
 * the CN not setup.
 *
 */

var child_process = require('child_process');
var fs = require('fs');

var assert = require('assert-plus');
var jsprim = require('jsprim');
var vasync = require('vasync');


var LOAD_SYSCTLS = {
    'hw.model': { // Intel(R) Xeon(R) CPU E5-2670 0 @ 2.60GHz
        name: 'CPU Type'
    },
    'hw.ncpu': { // 4
        func: parseNumber,
        name: 'CPU Total Cores'
    },
    'hw.physmem': { // 4259975168
        func: parseMemory,
        name: 'MiB of Memory'
    },
    'kern.boottime': {
        func: parseBootTime, // { sec = 1515699598, usec = 978236 } Thu Jan 11 11:39:58 2018
        name: 'Boot Time'
    },
    'kern.hostname': {
        name: 'Hostname'
    }
};

var SMBIOS_SYSTEM_KEYS = {
    Family: 'HW Family',
    Manufacturer: 'Manufacturer',
    'Product Name': 'Product',
    'Serial Number': 'Serial Number',
    'SKU Number': 'SKU Number',
    UUID: 'UUID',
    Version: 'HW Version',
};

function parseBootTime(str) {
    assert.string(str, 'str');

    var matches;

    matches = str.match(/^.*sec = ([0-9]+),/);
    assert.array(matches, 'matches');

    return matches[1];
}

function parseMemory(str) {
    assert.string(str, 'str');

    var result;

    result = jsprim.parseInteger(str, {});

    assert.number(result, 'result');

    return Math.floor(result / (1024 * 1024)).toString();
}

function parseNumber(str) {
    assert.string(str, 'str');

    var result;

    result = jsprim.parseInteger(str, {});

    assert.number(result, 'result');

    return result;
}

function loadBuildstamp(sysinfo, callback) {
    //
    // /etc/buildstamp is expected to contain something like:
    //
    // 20180111T162941Z
    //
    fs.readFile('/etc/buildstamp', function _onRead(err, data) {
        assert.ifError(err, 'should be able to load buildstamp');

        // TODO: check that this matches what we expect

        sysinfo['Live Image'] = data.toString().trim();

        callback();
    });
}

function loadNics(sysinfo, callback) {
    child_process.exec('/sbin/ifconfig -a',
        function _onExec(err, stdout, stderr) {
            var idx;
            var iface;
            var ifaces = {};
            var line;
            var lines;
            var matches;

            if (err) {
                callback(err);
                return;
            }

            lines = stdout.split('\n');

            for (idx = 0; idx < lines.length; idx++) {
                line = lines[idx];

                if (matches =
                    line.match(/^([a-z][a-z0-9]*)\: flags=.*<([^\>]*)>/)) {

                    iface = matches[1];
                    if (iface.match(/^lo[0-9]/)) {
                        // skip loopback devices
                        continue;
                    }
                    assert.ok(ifaces[iface] === undefined,
                        'ifaces[iface] should be undefined');
                    ifaces[iface] = {
                        'Link Status':
                            (matches[2].match(/\bUP\b/) ? 'up' : 'down')
                    };
                } else {
                    assert.string(iface, 'iface');
                    if (iface.match(/^lo[0-9]/)) {
                        // skip loopback devices
                        continue;
                    }
                    line = line.trim();
                    if (matches = line.match(/^ether ([0-9a-f\:]*)$/)) {
                        ifaces[iface]['MAC Address'] = matches[1];
                    } else if (matches = line.match(/^inet ([0-9\.]*)/)) {
                        ifaces[iface]['ip4addr'] = matches[1];
                    }
                }
            }

            sysinfo['Network Interfaces'] = ifaces;

            callback();
        }
    );
}

function loadSysctls(sysinfo, callback) {
    child_process.exec('/sbin/sysctl -e ' + Object.keys(LOAD_SYSCTLS).join(' '),
        function _onExec(err, stdout, stderr) {
            assert.ifError(err, 'should be able to load sysctls');

            var idx;
            var key;
            var lines;
            var parts;
            var sysctl;
            var value;

            lines = stdout.split(/\n/);
            for (idx = 0; idx < lines.length; idx++) {
                if (lines[idx].indexOf('=') !== -1) {
                    parts = lines[idx].split('=');

                    key = parts.shift().trim();
                    value = parts.join('=').trim();

                    assert.object(LOAD_SYSCTLS[key],
                        'LOAD_SYSCTLS[' + key + ']');

                    sysctl = LOAD_SYSCTLS[key];

                    if (sysctl.hasOwnProperty('func')) {
                        sysinfo[sysctl.name] = sysctl.func(value);
                    } else {
                        sysinfo[sysctl.name] = value;
                    }
                }
            }

            callback();
        }
    );
}

function loadSmbios(sysinfo, callback) {
    child_process.exec('/usr/local/sbin/dmidecode -t system',
        function _onExec(err, stdout, stderr) {
            assert.ifError(err, 'should be able to load dmidecode');

            var idx;
            var key;
            var lines;
            var parts;
            var value;

            lines = stdout.replace(/\t/g, ' ').split(/\n/);
            for (idx = 0; idx < lines.length; idx++) {
                if (lines[idx].indexOf(':') !== -1) {
                    parts = lines[idx].split(':');

                    key = parts.shift().trim();

                    if (!SMBIOS_SYSTEM_KEYS.hasOwnProperty(key)) {
                        continue;
                    }

                    key = SMBIOS_SYSTEM_KEYS[key];
                    value = parts.join(':').trim();

                    // Special case in order to match SmartOS's sysinfo
                    if (value === 'Not Specified') {
                        value = '';
                    }

                    if (key === 'UUID') {
                        value = value.toLowerCase();
                    }

                    sysinfo[key] = value;
                }
            }

            callback();
        }
    );
}

function loadZpoolInfo(sysinfo, callback) {
    var poolName = sysinfo.Zpool;

    child_process.exec(
        '/sbin/zfs get -Hpo value available,creation,used ' + poolName,
        function _onExec(err, stdout, stderr) {
            assert.ifError(err, 'should be able to load zpool info');

            var available;
            var creation;
            var poolInfo = stdout.trim().split('\n');
            var size;
            var used;

            assert.array(poolInfo, 'poolInfo');
            assert.ok(poolInfo.length === 3, 'unexpected number of fields');

            available = jsprim.parseInteger(poolInfo[0], {});
            creation = jsprim.parseInteger(poolInfo[1], {});
            used = jsprim.parseInteger(poolInfo[2], {});

            assert.number(available, 'available');
            assert.number(creation, 'creation');
            assert.number(used, 'used');

            size = Math.floor((used + available) / 1024 / 1024 / 1024);

            sysinfo['Zpool Creation'] = creation;
            sysinfo['Zpool Size in GiB'] = size;

            callback();
        }
    );
}

function loadZpoolName(sysinfo, callback) {
    child_process.exec('/sbin/zpool list -Hpo name',
        function _onExec(err, stdout, stderr) {
            assert.ifError(err, 'should be able to load zpool name');

            var name = stdout.trim();

            assert.ok(name.indexOf('\n') === -1, 'should only be one zpool');
            assert.ok(name.length > 0, 'zpool should have a name');

            sysinfo['Zpool'] = name;

            callback();
        }
    );
}

// TODO:
//
// This needs to figure out which disks from the disk list are in the
// pool and which profile we're using.
//
// Looks like:
//
//  "Zpool Disks": "c0t5000A72030087CF2d0,c10t5000CCA0168E01E5d0,<...>",
//  "Zpool Profile": "mirror",
//
// The SmartOS version does:
//
//  function get_zpool_disks()
//  {
//      local zpool=$1
//      local disks=$(/usr/bin/disklist -n)
//      ZSTAT=$(/usr/sbin/zpool status ${zpool} | awk '/[a-z]/{ print $1 }')
//      Zpool_disks=
//
//      for disk in ${disks}; do
//          if [[ "${ZSTAT}" =~ "${disk}" ]]; then
//              Zpool_disks="${Zpool_disks},${disk}"
//          fi
//      done
//
//      Zpool_disks=${Zpool_disks/#,/}
//  }
//
//  function get_zpool_profile()
//  {
//      local zpool=$1
//      local profiles=( mirror raidz3 raidz2 raidz )
//      Zpool_profile="striped"
//
//      for profile in ${profiles[*]}; do
//          if [[ "${ZSTAT}" =~ "${profile}" ]]; then
//              Zpool_profile=${profile}
//              break
//          fi
//      done
//  }
//
function loadZpoolStatus(sysinfo, callback) {
    var poolName = sysinfo.Zpool;

    assert.string(sysinfo['Zpool'], 'sysinfo["Zpool"]');
    assert.number(sysinfo['Zpool Size in GiB'], 'sysinfo["Zpool Size in GiB"]');

    // This is just fake for now until SWSUP-1023
    sysinfo['Zpool Disks'] = 'da0';
    sysinfo['Zpool Profile'] = 'mirror';
    sysinfo['Disks'] = {
        da0: {
            'Size in GB':
                Math.floor((sysinfo['Zpool Size in GiB'] * 1024 * 1024 * 1024 )
                    / (1000 * 1000 * 1000))
        }
    };

    callback();
}

function loadAgents(sysinfo, callback) {
    sysinfo['SDC Agents'] = [{
        // XXX don't hardcode, should come from:
        //
        //  /opt/smartdc/agents/lib/node_modules/*/package.json
        //
        name: 'cn-agent',
        version: '2.0.1'
    }];

    callback();
}

function loadConfig(sysinfo, callback) {
    fs.readFile('/opt/smartdc/etc/config.json', function _onRead(err, data) {
        var config;
        var idx;
        var ifaces;
        var iface;

        if (err && err.code === 'ENOENT') {
            sysinfo['Setup'] = false;
            callback();
            return;
        }

        assert.ifError(err, 'should be able to load config.json');

        // This will throw if JSON is bad
        config = JSON.parse(data);

        assert.object(config, 'config');
        assert.optionalString(config.datacenter_name, 'config.datacenter_name');
        assert.optionalString(config.dns_domain, 'config.dns_domain');
        assert.optionalObject(config.nic_tags, 'config.nic_tags');

        // Consider setup complete if config exists
        sysinfo['Setup'] = 'true';

        if (config.datacenter_name) {
            sysinfo['Datacenter Name'] = config.datacenter_name;
        }

        if (config.nic_tags) {
            assert.object(sysinfo['Network Interfaces'], 'sysinfo["Network Interfaces"]');

            ifaces = Object.keys(sysinfo['Network Interfaces']);
            for (idx = 0; idx < ifaces.length; idx++) {
                iface = sysinfo['Network Interfaces'][ifaces[idx]];

                if (config.nic_tags[iface['MAC Address']]) {
                    sysinfo['Network Interfaces'][ifaces[idx]]['NIC Names']
                        = config.nic_tags[iface['MAC Address']];
                }
            }
        }

        callback();
    });
}

function findAdminNic(sysinfo) {
    var admin_nic;
    var idx;
    var iface;
    var keys;
    var nics = sysinfo['Network Interfaces'];

    keys = Object.keys(nics);
    for (idx = 0; idx < keys.length; idx++) {
        iface = keys[idx];
        if (nics[iface]['NIC Names'] && nics[iface]['NIC Names'].indexOf('admin') !== -1) {
            admin_nic = nics[iface]['MAC Address'];
            break;
        }
    }

    return admin_nic;
}

function loadMissing(sysinfo, callback) {
    // Fills in dummy data for missing pieces (e.g. waiting on SWSUP-1023)
    var admin_nic;
    var bootparams = {
    };

    sysinfo['SDC Version'] =  '7.0';
    sysinfo['System Type'] = 'FreeBSD';
    sysinfo['Ur Agent'] = false;

    if (!sysinfo['VM Capable']) {
        sysinfo['VM Capable'] = true;
    }

    if (!sysinfo['CPU Virtualization']) {
        sysinfo['CPU Virtualization'] = 'vmx';
    }

    if (!sysinfo['CPU Physical Cores']) {
        sysinfo['CPU Physical Cores'] = 2;
    }

    if (!sysinfo['Virtual Network Interfaces']) {
        sysinfo['Virtual Network Interfaces'] = {};
    }

    if (!sysinfo['Link Aggregations']) {
        sysinfo['Link Aggregations'] = {};
    }

    if (!sysinfo['Boot Parameters']) {
        admin_nic = findAdminNic(sysinfo); // might be undefined

        sysinfo['Boot Parameters'] = {
            admin_nic: admin_nic,
            boot_args: '',
            bootargs: '',
            console: 'ttyb'
        };
    }

    callback();
}

function sysinfo() {
}

sysinfo.prototype.get = function get(opts, callback) {
    assert.object(opts, 'opts');
    assert.func(callback, 'callback');

    var result = {};

    // TODO: check cache (/tmp/.sysinfo.json) first, write to cache on complete

    vasync.pipeline({
        arg: result,
        funcs: [
            loadBuildstamp,
            loadNics,
            loadAgents,
            loadConfig,
            loadSmbios,
            loadSysctls,
            loadZpoolName,
            loadZpoolInfo,
            loadZpoolStatus,
            loadMissing
        ]
    }, function afterPipeline(err) {
        assert.ifError(err, 'should not have error running pipeline');
        callback(null, result);
    });
};

module.exports = sysinfo;

if (require.main === module) {
    var sysinfoGetter = new sysinfo();
    sysinfoGetter.get({}, function onSysinfo(err, info) {
        assert.ifError(err, 'unexpected error loading sysinfo');
        console.log(JSON.stringify(info, null, 4));
    });
}
