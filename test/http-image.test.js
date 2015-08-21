/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var testCase = require('nodeunit').testCase;
var restify = require('restify');
var Logger = require('bunyan');
var smartdcconfig = require('../lib/smartdc-config');

var PROVISIONER_PORT = 5309;
var imageUuid = 'fd2cc906-8938-11e3-beab-4359c665ac99';
var nonImageUuid = 'hijklmno-pqrs-tuvw-xyza-bcdefghijklm';
var client;

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

function setup(cb) {
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

        client = restify.createJsonClient({
            agent: false,
            url: 'http://' + adminip + ':' + PROVISIONER_PORT
        });

        cb();
    });
}

function teardown(cb) {
    cb();
}

function testGetImageManifestHttp(test) {
    test.expect(3);
    var path = '/images/' + imageUuid;
    client.get(path, function (err, req, res, tasks) {
        test.ifError(err);
        if (!err) {
            test.ok(res, 'got a response');
            test.equal(res.statusCode, 200, 'GET /images/:uuid returned 200');
        }
        test.done();
    });
}

function testGetNonImageManifestHttp(test) {
    test.expect(2);
    var path = '/images/' + nonImageUuid;
    client.get(path, function (err, req, res, tasks) {
        if (err) {
            test.ok(res, 'got a response');
            test.equal(res.statusCode, 404, 'GET /images/:uuid returned 404');
        }
        test.done();
    });
}

function testGetImageFileHttp(test) {
    test.expect(3);
    var path = '/images/' + imageUuid + '/file';
    client.get(path, function (err, req, res, tasks) {
        test.ifError(err);
        if (!err) {
            test.ok(res, 'got a response');
            test.equal(res.statusCode, 200, 'GET /images/:uuid/file returned 200');
        }
        test.done();
    });
}

function testGetNonImageFileHttp(test) {
    test.expect(2);
    var path = '/images/' + nonImageUuid + '/file';
    client.get(path, function (err, req, res, tasks) {
        if (err) {
            test.ok(res, 'got a response');
            test.equal(res.statusCode, 404, 'GET /images/:uuid/file returned 404');
        }
        test.done();
    });
}

module.exports = {
    setUp: setup,
    tearDown: teardown,
    'retrieve an image manifest via http': testGetImageManifestHttp,
    'retrieve a non-image manifest via http': testGetNonImageManifestHttp,
    'retrieve an image file via http': testGetImageFileHttp,
    'retrieve a non-image file via http': testGetNonImageFileHttp
};
