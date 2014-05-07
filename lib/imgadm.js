/**
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * A light wrapper around the `imgadm` tool. Currently this just shell's
 * out to `imgadm` rather than using a node.js API.
 */

var assert = require('assert');
var child_process = require('child_process'),
    spawn = child_process.spawn,
    execFile = child_process.execFile;
var format = require('util').format;
var crypto = require('crypto');
var fs = require('fs');
var zfs = require('zfs').zfs;


// ---- globals

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;


// ---- internal support stuff

function objCopy(obj) {
    var copy = {};
    Object.keys(obj).forEach(function (k) {
        copy[k] = obj[k];
    });
    return copy;
}



// ---- main functionality

/**
 * Import the given image.
 *
 * It is up to the caller to ensure this UUID is not already installed.
 *
 * @param {Object} options:
 *      - @param {UUID} uuid - The UUID of the remote image to import.
 *      - @param {String} zpool - The zpool to which to import.
 *      - @param {Object} log - A log object on which to call log.info
 *        for successful run output.
 * @param callback {Function} `function (err)`
 */
function importImage(options, callback) {
    assert.ok(options, 'options');
    assert.ok(options.uuid && UUID_RE.test(options.uuid), 'options.uuid');
    assert.ok(options.zpool && typeof (options.zpool) === 'string',
        'options.zpool');
    assert.ok(options.log, 'options.log');

    // Hack to workaround OS-2203 (imgadm import not supporting concurrent
    // imports).
    // 1hr timeout -- same as the CNAPI task in the provision workflow
    options.timeout = 1000 * 60 * 60;
    waitForConcurrentImageImport(options, function (waitErr) {
        if (waitErr) {
            callback(waitErr);
            return;
        }
        var argv = ['/usr/sbin/imgadm', 'import', '-q', '-P',
                    options.zpool, options.uuid];
        var env = objCopy(process.env);
        // Get 'debug' level logging in imgadm >=2.6.0 without triggering trace
        // level logging in imgadm versions before that. Trace level logging is
        // too much here.
        env.IMGADM_LOG_LEVEL = 'debug';
        var execOpts = {
            encoding: 'utf8',
            env: env
        };
        options.log.info('calling: ' + argv.join(' '));
        execFile(argv[0], argv.slice(1), execOpts,
            function (err, stdout, stderr) {
                if (err) {
                    callback(new Error(format(
                        'Error importing image %s to zpool %s:\n'
                        + '\targv: %j\n'
                        + '\texit status: %s\n'
                        + '\tstdout:\n%s\n'
                        + '\tstderr:\n%s', options.uuid, options.zpool,
                        argv, err.code, stdout.trim(), stderr.trim())));
                    return;
                }
                options.log.info(format(
                    'imported image %s: stdout=%s stderr=%s',
                    options.uuid, stdout.trim(), stderr.trim()));
                callback();
            });
    });
}


function waitForConcurrentImageImport(options, callback) {
    assert.ok(options, 'options');
    assert.ok(options.uuid && UUID_RE.test(options.uuid), 'options.uuid');
    assert.ok(options.zpool && typeof (options.zpool) === 'string',
        'options.zpool');
    assert.ok(options.timeout, 'options.timeout');
    assert.ok(options.log, 'options.log');

    var end = Date.now() + options.timeout;
    var INTERVAL = 10 * 1000; // 10s
    // Per -partial name in imgadm:
    // JSSTYLED
    // <https://github.com/joyent/smartos-live/blob/master/src/img/lib/imgadm.js#L1571-L1576>
    var partialDsName = format('%s/%s-partial', options.zpool, options.uuid);

    setTimeout(pollOnce, Math.random() * 1000);

    function pollOnce() {
        zfs.list(partialDsName, function (err, ds) {
            if (ds) {
                var now = Date.now();
                if (now >= end) {
                    callback(new Error(format('timeout waiting for partial'
                        + ' dataset "%s" to be removed', partialDsName)));
                } else {
                    options.log.info('"%s" dataset exists, waiting',
                        partialDsName);
                    setTimeout(pollOnce, INTERVAL);
                }
            } else if (err && err.message &&
                err.message.indexOf('dataset does not exist'))
            {
                // Expected error is:
                // JSSTYLED
                //      Command failed: cannot open 'zones/fac31b04-af9e-4c55-8f9d-74b0eead711f': dataset does not exist
                callback();
            } else {
                callback(new Error(format('unexpected error listing partial'
                    + ' dataset "%s"', partialDsName)));
            }
        });
    }
}

/**
 * Create an image from a given VM.
 *
 */
function createImage(options, callback) {
    assert.ok(options, 'options');
    assert.ok(options.compression, 'options.compression');
    assert.ok(options.imgapi_url, 'options.imgapi_url');
    assert.ok(options.manifest, 'options.manifest');
    assert.ok(options.uuid, 'options.uuid');
    assert.ok(options.manifest.uuid, 'options.manifest.uuid');
    // optionalBool(options.incremental);
    // optionalString(options.prepare_image_script);
    var log = options.log;

    var manifestFile = '/var/tmp/.provisioner-create-image-manifest-'
        + crypto.randomBytes(4).readUInt32LE(0) + '.json';
    fs.writeFileSync(manifestFile, JSON.stringify(options.manifest));
    var argv = [
        '/usr/sbin/imgadm',
        // Note: Verbose output disabled by now while imgadm 2.5.0 is in play
        // with much too verbose trace level output.
        // '-v',
        '-E',
        'create', '-m', manifestFile,
        '-c', options.compression,
        options.uuid,
        '--publish', options.imgapi_url
    ];
    if (options.incremental) {
        argv.push('--incremental');
    }
    if (options.max_origin_depth) {
        argv.push('--max-origin-depth', options.max_origin_depth);
    }
    var prepareFile;
    if (options.prepare_image_script) {
        prepareFile = '/var/tmp/.provisioner-create-image-prepare-'
            + crypto.randomBytes(4).readUInt32LE(0);
        fs.writeFileSync(prepareFile, options.prepare_image_script);
        argv.push('-s');
        argv.push(prepareFile);
    }
    var env = objCopy(process.env);
    // Get 'debug' level logging in imgadm >=2.6.0 without triggering trace
    // level logging in imgadm versions before that. Trace level logging is
    // too much here.
    env.IMGADM_LOG_LEVEL = 'debug';
    var execOpts = {
        env: env
    };
    log.info({argv: argv}, 'spawn imgadm create');
    var child = spawn(argv[0], argv.slice(1), execOpts);
    var stdout = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', function (chunk) {
        // TODO: could hook up progress here
        stdout.push(chunk);
    });
    var stderr = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', function (chunk) { stderr.push(chunk); });

    var exitStatus;
    var nFinish = 0;
    child.on('exit', function (code) {
        exitStatus = code;
        finish();
    });
    child.on('close', finish);

    function finish() {
        nFinish++;
        if (nFinish < 2 || nFinish > 2) {
            return;
        }

        fs.unlinkSync(manifestFile);
        if (prepareFile) {
            fs.unlinkSync(prepareFile);
        }
        stdout = stdout.join('');
        stderr = stderr.join('');

        log[exitStatus ? 'warn' : 'info'](
            {
                argv: argv,
                env: env,
                exitStatus: exitStatus,
                stdout: stdout,
                stderr: stderr
            },
            '%s creating and publishing image %s from VM %s',
            (exitStatus ? 'Error' : 'Success'),
            options.manifest.uuid,
            options.uuid);
        if (exitStatus) {
            // With 'imgadm -E' the last line of output is a structured
            // bunyan log line and the 'err' field will be error info.
            var err;
            var errLine = stderr.trim().split(/\n/g).slice(-1)[0];
            try {
                var errInfo = JSON.parse(errLine).err; // imgadm Error info
                err = new Error(errInfo.message);
                err.body = errInfo;
            } catch (e) {
                // If the last line is not parseable JSON, then it is likely
                // some crash output where we want more than the last line.
                // Let's try to get the whole stack trace up to a limit
                var LIMIT = 1024;
                var stack = stderr.trim().split(/\n\n/g).slice(-1)[0];
                if (stack.length > LIMIT) {
                    stack = stack.slice(-LIMIT);
                }
                err = new Error(stack);
            }
            callback(err);
        } else {
            callback();
        }
    }
}


/**
 * Get the given image.
 *
 * It is up to the caller to ensure this UUID is not already installed.
 *
 * @param {Object} options:
 *      - @param {UUID} uuid - The UUID of the image
 *      - @param {Object} log - A log object on which to call log.info
 *        for successful run output.
 * @param callback {Function} `function (err)`
 */
function getImage(options, callback) {
    assert.ok(options, 'options');
    assert.ok(options.uuid && UUID_RE.test(options.uuid), 'options.uuid');
    assert.ok(options.log, 'options.log');

    var argv = ['/usr/sbin/imgadm', 'get',  options.uuid];
    var env = objCopy(process.env);
    // Get 'debug' level logging in imgadm >=2.6.0 without triggering trace
    // level logging in imgadm versions before that. Trace level logging is
    // too much here.
    env.IMGADM_LOG_LEVEL = 'debug';
    var execOpts = {
        encoding: 'utf8',
        env: env
    };
    options.log.info('calling: ' + argv.join(' '));
    execFile(argv[0], argv.slice(1), execOpts, function (err, stdout, stderr) {
        if (err) {
            callback(new Error(format(
                'Error getting image %s: %s', options.uuid, stderr.trim())));
            return;
        }
        options.log.info(format(
            'got image %s: stdout=%s stderr=%s',
            options.uuid, stdout.trim(), stderr.trim()));
        var image = JSON.parse(stdout.trim()).manifest;
        callback(null, image);
    });
}


// ---- exports

module.exports = {
    importImage: importImage,
    createImage: createImage,
    getImage: getImage
};
