/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var Task = require('../task_agent/task');
var VM = require('/usr/vm/node_modules/VM');
var async = require('async');
var common = require('../common');
var net = require('net');
var util = require('util');



// --- Helpers


/**
 * Returns true if the object has no keys
 */
function objEmpty(hash) {
    /* jsl:ignore (for unused variable warning) */
    for (var k in hash) {
        return false;
    }
    /* jsl:end */

    return true;
}


/*
 * Converts a dotted IPv4 address to its integer value
 */
function aton(addr) {
    if (!addr || !net.isIPv4(addr)) {
        return null;
    }

    var octets = addr.split('.');
    return Number(octets[0]) * 16777216 +
        Number(octets[1]) * 65536 +
        Number(octets[2]) * 256 +
        Number(octets[3]);
}

/**
 * Add the start_num and end_num integer values to a network based on its
 * subnet
 */
function add_ip_nums(network) {
    var sub = network.subnet.split('/');
    if (sub.length !== 2) {
        return false;
    }
    var start_num = aton(sub[0]);
    if (start_num === null) {
        return false;
    }

    var end_num = start_num + Math.pow(2, 32 - Number(sub[1])) - 1;
    network.start_num = start_num;
    network.end_num = end_num;

    return true;
}

/**
 * Returns true if the nic's parameters indicate that it is on the network.
 */
function network_matches_nic(network, nic, ipNum) {
    if (network.vlan_id == nic.vlan_id && network.start_num <= ipNum &&
        ipNum < network.end_num && nic.netmask == network.netmask) {
        return true;
    }

    return false;
}


/**
 * Adds the appropriate combination of route set / remove parameters to
 * payload based on the new routes and old network
 */
function add_route_properties(payload, oldRoutes, newRoutes) {
    var haveOld = (oldRoutes && !objEmpty(oldRoutes));
    var haveNew = (newRoutes && !objEmpty(newRoutes));

    if (!haveOld && !haveNew) {
        return;
    }

    if (!haveOld && haveNew) {
        payload.set_routes = newRoutes;
        return;
    }

    if (haveOld && !haveNew) {
        payload.remove_routes = Object.keys(oldRoutes);
        return;
    }

    var r;
    var remove = {};
    var set = {};

    for (r in oldRoutes) {
        remove[r] = oldRoutes[r];
    }

    for (r in newRoutes) {
        if (!remove.hasOwnProperty(r)) {
            set[r] = newRoutes[r];
            continue;
        }

        delete remove[r];
        set[r] = newRoutes[r];
    }

    if (!objEmpty(set)) {
        payload.set_routes = set;
    }

    if (!objEmpty(remove)) {
        payload.remove_routes = Object.keys(remove);
    }
}



// --- Task and its methods



var MachineUpdateNicsTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineUpdateNicsTask);

function pre_check(callback) {
    var self = this;
    var invalid = [];
    var params = self.req.params;

    if (!params.hasOwnProperty('networks') || !util.isArray(params.networks) ||
        params.networks.length === 0) {
        invalid.push('networks');
    } else {
        for (var n in params.networks) {
            if (!add_ip_nums(params.networks[n])) {
                invalid.push('networks (' + params.networks[n].uuid + ')');
            }
        }
    }

    if (!params.hasOwnProperty('original_network') ||
        typeof (params.original_network) !== 'object' ||
        !params.original_network.hasOwnProperty('subnet')) {
        invalid.push('original_network');

    } else {
        if (!add_ip_nums(params.original_network)) {
            self.log.error('Error adding IP numbers to original network');
            invalid.push('original_network');
        }
    }

    if (invalid.length !== 0) {
        var invalidErr = new Error(util.format(
            'Invalid request parameter%s: %s',
            (invalid.length === 1 ? '' : 's'),
            invalid.join(', ')));
        self.log.error('Error validating parameters');
        self.log.error(invalidErr, 'Error validating parameters');
        callback(invalidErr);
        return;
    }

    callback();
}

function filter_vms(callback) {
    var self = this;
    var params = self.req.params;
    var orig = params.original_network;
    var lookup = {
        'nics.*.nic_tag': orig.nic_tag,
        'nics.*.netmask': orig.netmask,
        'nics.*.vlan_id': orig.vlan_id
    };
    var opts = {
        fields: [ 'uuid', 'nics', 'internal_metadata', 'routes' ]
    };
    var updates = [];

    VM.lookup(lookup, opts, function (err, results) {
        if (err) {
            err.message = 'Error looking up VMs: ' + err.message;
            callback(err);
            return;
        }

        // Further filter: make sure one of the VM's IPs is in the
        // original network (VM.lookup does not currently support this)
        results.forEach(function (vm) {
            var matched = false;
            var newRoutes = {};
            var setResolvers = true;
            var resolvers = [];
            var updateParams = {};

            if (vm.hasOwnProperty('internal_metadata') &&
                vm.internal_metadata.hasOwnProperty('set_resolvers') &&
                !vm.internal_metadata.set_resolvers) {
                self.log.info('VM "' + vm.uuid
                    + '" has set_resolvers=false: not updating');
                setResolvers = false;
            }

            vm.nics.forEach(function (nic) {
                var ipNum = aton(nic.ip);
                var isMatchingNetwork = false;

                if (!ipNum) {
                    self.log.warning(
                        util.format('VM %s: invalid or DHCP IP for nic',
                        vm.uuid));
                    self.log.warning(nic);
                    return;
                }

                if (network_matches_nic(orig, nic, ipNum)) {
                    // XXX: this double log (and others) is because the
                    // provisioner logger won't log the message if there's
                    // also an object as the first argument.
                    self.log.info(util.format('VM %s: matched nic %s',
                            vm.uuid, nic.mac));
                    self.log.info({ nic: nic });
                    matched = true;
                    isMatchingNetwork = true;
                }

                params.networks.forEach(function (network) {
                    if (!network_matches_nic(network, nic, ipNum)) {
                        return;
                    }

                    // Be very careful to only update the gateway for nics
                    // on the network we're updating
                    if (isMatchingNetwork &&
                        network.hasOwnProperty('gateway') &&
                        network.gateway != nic.gateway) {
                        if (!updateParams.hasOwnProperty('update_nics')) {
                            updateParams.update_nics = [];
                        }

                        updateParams.update_nics.push({
                            gateway: network.gateway,
                            mac: nic.mac
                        });
                    }

                    if (network.hasOwnProperty('resolvers') &&
                        network.resolvers.length !== 0) {
                        network.resolvers.forEach(function (r) {
                            if (resolvers.indexOf(r) === -1) {
                                resolvers.push(r);
                            }
                        });
                    }

                    if (network.hasOwnProperty('routes')) {
                        for (var rt in network.routes) {
                            newRoutes[rt] = network.routes[rt];
                        }
                    }
                });
            });

            if (matched) {
                if (setResolvers) {
                    updateParams.resolvers = resolvers;
                }

                var oldRoutes = vm.routes || {};
                var routeProps = {};
                add_route_properties(routeProps, oldRoutes, newRoutes);
                self.log.info(util.format('VM %s: added %d route properties',
                        vm.uuid, Object.keys(routeProps).length));
                self.log.info(routeProps);
                for (var prop in routeProps) {
                    updateParams[prop] = routeProps[prop];
                }

                if (!objEmpty(updateParams)) {
                    updates.push({
                        uuid: vm.uuid,
                        params: updateParams
                    });
                }
            }
        });

        self.log.info(util.format('%d VMs to update', updates.length));
        self.log.info({ updates: updates }, '%d VMs to update',
            updates.length);
        self.updates = updates;

        callback();
    });
}

function perform_updates(callback) {
    var self = this;
    if (!self.updates || self.updates.length === 0) {
        self.log.info('No updates to perform');
        callback();
        return;
    }

    async.forEachSeries(self.updates, function (update, cb) {
        self.log.info('Updating VM "' + update.uuid + '"');
        self.log.info(update.params);

        VM.update(update.uuid, update.params, function (err) {
            if (err) {
                self.log.error('Error updating VM "' + update.uuid + '"');
                err.message = 'Error updating VM "' + update.uuid + '": ' +
                    err.message;
                cb(err);
                return;
            }

            self.log.info('Updated VM "' + update.uuid + '"');
            cb();
        });
    }, function (err) {
        if (err) {
            callback(err);
            return;
        }

        self.progress(100);
        callback();
    });
}

function start(callback) {
    var self = this;

    VM.logger = common.makeVmadmLogger(self);
    VM.logname = 'machine_nics_update';

    async.waterfall([
        self.pre_check.bind(self),
        self.filter_vms.bind(self),
        self.perform_updates.bind(self)
    ], function (err) {
        if (err) {
            self.fatal(err.message);
            return;
        }
        self.finish();
    });
}

MachineUpdateNicsTask.setStart(start);

MachineUpdateNicsTask.createSteps({
    pre_check: {
        fn: pre_check,
        progress: 20,
        description: 'Pre-flight sanity check'
    },
    filter_vms: {
        fn: filter_vms,
        progress: 50,
        description: 'Filtering VMs'
    },
    perform_updates: {
        fn: perform_updates,
        progress: 100,
        description: 'Updating VMs'
    }
});
