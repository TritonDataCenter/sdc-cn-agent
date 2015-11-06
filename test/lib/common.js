
var restify = require('restify');
var smartdcconfig = require('../lib/smartdc-config');

var PROVISIONER_PORT = 5309;

function firstAdminIp(sysinfo) {
    var interfaces;

    interfaces = sysinfo['Network Interfaces'];

    for (var iface in interfaces) {
        if (!interfaces.hasOwnProperty(iface)) {
            continue;
        }

        var nic = interfaces[iface]['NIC Names'];
        var isAdmin = nic.indexOf('admin') !== -1;
        if (isAdmin) {
            var ip = interfaces[iface].ip4addr;
            return ip;
        }
    }

    throw new Error('No NICs with name "admin" detected.');
}

exports.getClient = function getClient(cb) {
    smartdcconfig.sysinfo(function (err, sysinfo) {
        var adminip;

        if (err) {
            cb(err);
            return;
        }

        adminip = firstAdminIp(sysinfo);
        if (!adminip) {
            throw new Error('failed to find admin IP');
        }

        cb(null, restify.createJsonClient({
            agent: false,
            url: 'http://' + adminip + ':' + PROVISIONER_PORT
        }));
    });
};
