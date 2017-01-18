/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 *
 * apm.js - Ain't a Package Manager
 *
 * Drops Node.js packages into a given directory tree. Links up binaries. Runs
 * your lifecycle scripts.
 *
 * Eg. ./bin/apm.js list 2> >(bunyan)
 *
 */

var async = require('async');
var bunyan = require('bunyan');
var mkdirp = require('mkdirp');
var fs = require('fs');
var createHash = require('crypto').createHash;
var assert = require('assert');
var execFile = require('child_process').execFile;
var exec = require('child_process').exec;
var spawn = require('child_process').spawn;
var path = require('path');
var tty = require('tty');

var prefix = '/opt/smartdc/agents';
var tmp = '/var/tmp';
var modules = 'lib/node_modules';
var installdir = prefix + '/' + modules;
var bindir = prefix + '/bin';
var smfdir = prefix + '/smf';
var etcdir = prefix + '/etc';
var dbdir = prefix + '/db';
var log;

function readPackageJson(jsonPath, callback) {
    fs.readFile(jsonPath, function (error, json) {
        return callback(null, JSON.parse(json));
    });
}

function createPackageLibDirectory(thing, callback) {
    var dir = prefix + '/lib/node_modules/' + thing;
    log.debug('Creating directory, %s', dir);
    mkdirp(dir, function (error) {
        if (error) {
            log.error('Could not create directory, %s', dir);
            return callback(error);
        }
        return callback(error);
    });
}

function isPackageInstalled(pkg, callback) {
    var dir = path.join(installdir, pkg);
    log.info('Checking if package, %s, is installed.', dir);
    fs.exists(dir, function (exists) {
        if (!exists) {
            log.info('Package, %s, is not installed.', pkg);
            return callback(null, false);
        }
        return fs.stat(dir, function (error, stat) {
            if (error) {
                log.error('Package, %s, could not be stat: %s', error.message);
                return callback(error, false);
            }

            if (stat.isDirectory()) {
                log.info('Package, %s, is installed.', pkg);
                return callback(null, true);
            } else {
                log.warn(
                    'Package install location, %s, is not a directory?', dir);
                return callback(null, false);
            }
        });
    });
}

function tmpname() {
    return 'apm-' + Date.now() + Math.random();
}

function runLifecycleScript(which, packageJson, pkgPath, callback) {
    // Run lifecycle scripts.
    var scripts = packageJson.scripts;

    log.info('Checking for lifecycle script, %s.', which);

    if (!(scripts && scripts[which])) {
        log.info('No %s script found, continuing.', which);
        return callback();
    }

    var script = scripts[which];

    if (!script) {
        return callback();
    }

    process.chdir(pkgPath);

    return fs.stat(script, function (error, stat) {
        if (error) {
            log.warn(
                'Warning: Error could not stat lifescyle script %s.',
                error.message);
            return callback(error);
        }

        // Copy process.env
        var i;
        var env = {};
        for (i in process.env) {
            env[i] = process.env[i];
        }

        // Add our properties
        var addToEnv = {
            npm_config_prefix: prefix,
            npm_config_smfdir: smfdir,
            npm_package_name: packageJson.name,
            npm_package_version: packageJson.version,
            npm_config_etc: etcdir,
            npm_config_dbdir: dbdir
        };

        for (i in addToEnv) {
            if (addToEnv.hasOwnProperty(i)) {
                env[i] = addToEnv[i];
            }
        }

        log.info('Executing %s', script);
        var child = spawn(script, [], { env: env });

        child.stdout.on('data', function (data) {
            log.debug('stdout: ' + data.toString());
        });

        child.stderr.on('data', function (data) {
            log.debug('stderr: ' + data.toString());
        });

        return child.on('exit', function (code) {
            console.log('Finished executing ' + which);
            if (code) {
                log.error(which + ' exited with ' + code);
                return callback(new Error(which + ' returned ' + code));
            }
            return callback();
        });
    });
}

function uninstallPackage(pkg, cb) {
    log.info('Uninstalling package, %s.', pkg);

    var packageJson;
    var pkgPath = path.join(prefix, modules, pkg);

    async.waterfall([
        function (callback) {
            fs.stat(pkgPath, function (error, stat) {
                if (error) {
                    return callback(error);
                }
                process.chdir(pkgPath);
                return callback();
            });
        },
        function (callback) {
            // Parse the package's package.json file.
            readPackageJson(pkgPath + '/package.json', function (error, json) {
                packageJson = json;
                log.debug(packageJson);
                return callback();
            });
        },
        function (callback) {
            runLifecycleScript('preuninstall', packageJson, pkgPath,
                function (error) {
                    if (error) {
                        return callback(error);
                    }
                    return callback();
                });
        },
        function (callback) {
            runLifecycleScript(
                'postuninstall',
                packageJson,
                pkgPath,
                function (error) {
                    if (error) {
                        return callback(error);
                    }
                    return callback();
                });
        },
        function (callback) {
            // Iterate over packageJson bin entries and remove them from our
            // bin directory.
            if (!packageJson.bin || !Object.keys(packageJson.bin).length) {
                return callback();
            }

            var bins = packageJson.bin;
            var binNames = Object.keys(bins);

            return async.eachSeries(
                binNames,
                function (binName, _cb) {
                    var binLink = bindir + '/' + binName;

                    fs.stat(binLink, function (error) {
                        if (error) {
                            log.warn('Could not stat %s to unlink', binLink);
                            return _cb();
                        }

                        return fs.unlink(binLink, function (unlinkError) {
                            if (unlinkError) {
                                return _cb(unlinkError);
                            }
                            log.info('Unlinked %s', binLink);
                            return _cb();
                        });
                    });
                },
                function (error) {
                    log.info('Done removing bin entries');
                    return callback(error);
                });
        },
        function (callback) {
            process.chdir(path.join(prefix, modules));
            execFile('/usr/bin/rm', [ '-fr', pkgPath ],
                function (error, stdout, stderr) {
                    if (error) {
                        log.info(
                            'Error removing %s: %s',
                            pkgPath,
                            stderr.toString());
                        return callback(error);
                    }

                    return callback();
                });
        }
    ],
    function (error) {
        if (error) {
            log.error('Error uninstalling package');
            log.error(error);
            return cb();
        }
        return cb();
    });
}

function installPackage(toInstall, cb) {
    var localtmp = tmp + '/' + tmpname();
    var thingdir;
    var installeddir;
    var packageJson;
    var packagetmp = localtmp + '/package';

    async.waterfall([
        function (callback) {
            async.eachSeries(
                [ packagetmp, localtmp, installdir, bindir, smfdir, etcdir ],
                function (dir, _cb) {
                    mkdirp(dir, _cb);
                },
                callback);
        },
        function (callback) {
            fs.stat(toInstall, function (error, stat) {
                if (error) {
                    callback(error);
                    return;
                }

                if (stat.isDirectory()) {
                    execFile(
                        '/usr/bin/cp',
                        [ '-Pr', toInstall, packagetmp + '/pkg' ],
                        function (execError, stdout, stderr) {
                            if (execError) {
                                callback(
                                    new Error(
                                        'Error copying install source: '
                                        + execError.message));
                                return;
                            }
                            process.chdir(localtmp);
                            callback();
                            return;
                        });
                    return;
                } else if (stat.isFile()) {
                    var cmd = '/usr/bin/tar zxf ' + toInstall + ' -C ' +
                        packagetmp;

                    function onExec(err, stdout, stderr) {
                        if (err) {
                            log.error(stderr.toString());
                            log.error(err.message);
                            log.error(err.stack);
                            callback(error);
                        }
                        callback();
                    }

                    exec(cmd, onExec);
                    return;
                } else {
                    var msg = 'Installation source had unknown type.';
                    log.error(msg);
                    callback(new Error(msg));
                    return;
                }
            });
        },
        function (callback) {
            // Find a single package directory in `localtmp`.
            fs.readdir(packagetmp, function (error, list) {
                assert(list.length > 0,
                'There should be at least 1 directory in package tarball');
                thingdir = packagetmp + '/' + list[0];
                process.chdir(thingdir);
                return callback();
            });
        },
        function (callback) {
            // Parse the package's package.json file.
            readPackageJson(thingdir + '/package.json', function (error, json) {
                packageJson = json;
                return callback();
            });
        },
        function (callback) {
            var name = packageJson.name;
            isPackageInstalled(name, function (error, isInstalled) {
                if (isInstalled) {
                    log.warn(
                        'Detected %s as being already installed. '
                    + 'Uninstalling before continuing.', name);
                    uninstallPackage(name, callback);
                    return;
                } else {
                    callback();
                    return;
                }
            });
        },
        function (callback) {
            runLifecycleScript(
                'preinstall',
                packageJson,
                thingdir,
                function (error) {
                    if (error) {
                        return callback(error);
                    }
                    return callback();
                });
        },
        function (callback) {
            // Move the unpacked package directory into its final home.
            installeddir = installdir + '/' + packageJson.name;

            execFile('/usr/bin/mv', [thingdir, installeddir],
                function (error, stdout, stderr) {
                    log.info('Moving %s => %s', thingdir, installeddir);
                    return callback(
                        error ? new Error(stderr.toString()) : null);
                });
        },
        function (callback) {
            process.chdir(installeddir);
            // Move the unpacked package directory into its final home.
            execFile('/usr/bin/rm', [ '-fr', localtmp ],
                function (error, stdout, stderr) {
                    log.info('Deleting temp directory: %s', localtmp);
                    return callback(
                        error ? new Error(stderr.toString()) : null);
                });
        },
        function (callback) {
            var bins = packageJson.bin;
            var binNames;

            // Link up bin/ entries.
            if (!(bins && Object.keys(bins).length)) {
                return callback();
            }

            binNames = Object.keys(bins);

            return async.eachSeries(binNames, function (binName, _cb) {
                var from = bindir + '/' + binName;
                var to = [
                    '..',
                    modules,
                    packageJson.name,
                    packageJson.bin[binName].replace(new RegExp('^\\.\/'), '')
                ].join('/');

                var toPath = path.resolve(bindir, to);
                fs.chmod(toPath, parseInt('755', 8), function (error) {
                    if (error) {
                        log.error('Error chmod %s.', toPath);
                        return _cb(error);
                    }

                    return fs.symlink(to, from, function (symlinkError) {
                        if (symlinkError) {
                            log.error(
                                'Error symlinking %s to %s: %s',
                                from, toPath, symlinkError.message);
                            return _cb(error);
                        }
                        log.info('Symlinked %s => %s', from, toPath);
                        return _cb();
                    });
                });
            }, callback);
        },
        function (callback) {
            runLifecycleScript(
                'postinstall',
                packageJson,
                installeddir,
                function (error) {
                    if (error) {
                        return callback(error);
                    }
                    return callback();
                });
        }
    ], cb);
}


function updateSysinfo(callback) {
    execFile(
        '/usr/bin/sysinfo',
        ['-u'],
        function (error, stdout, stderr) {
            if (error) {
                callback(
                    new Error('Error running sysinfo: ' + stderr.toString()));
                return;
            }
            log.info('Updated sysinfo values');
            callback();
        });
}


function command_install(apm) {

    var things = process.argv.slice(3);

    apm.installPackages(things, function (err) {
        if (err) {
            process.exit(1);
        }
        return;
    });
}


function displayErrors(errors) {
    errors.forEach(function (error) {
        log.error('%s: %s', error.source, error.message);
        if (error.stack) {
            error.stack.split('\n').forEach(function (line) {
                log.error(line);
            });
        }
    });
}


function command_uninstall(apm) {
    var things = process.argv.slice(3);

    apm.uninstallPackages(things, function (err) {
        if (err) {
            process.exit(1);
        }

        return;
    });
}


function command_list(apm) {
    apm.getPackages(function (err, packages) {
        if (err) {
            process.exit(1);
        }
        packages.forEach(function (pkg) {
            process.stdout.write((pkg.name + ' ' + pkg.version || '') + '\n');
        });
    });
}


function APM(options) {
    log = options.log;
}


APM.prototype.installPackages = function (packages, callback) {

    var errors = [];

    async.eachSeries(packages, function (_package, cb) {
        installPackage(_package, function (error) {
            if (error) {
                log.error('Error installing %s: %s',
                        _package, error.message);
                errors.push({
                    source: _package,
                    message: error.message,
                    stack: error.stack
                });
                return cb();
            }
            return cb();
        });
    },
    function (error) {
        updateSysinfo(function (sysinfoError) {
            if (sysinfoError) {
                log.error(
                    'Error updating sysinfo: ',
                    sysinfoError.message);
            }
            log.info('Done installing all packages.');
            if (errors.length) {
                log.error({errors: errors},
                    'errors installing packages');
                if (callback) {
                    callback(new Error('Errors installing packages, ' +
                        'first error: ' + JSON.stringify(errors[0])));
                }
                return;
            }
            if (callback) {
                callback();
            }
            return;
        });
    });
};

APM.prototype.uninstallPackages = function (packages, callback) {
    var errors = [];

    async.eachSeries(packages, function (_package, cb) {
        uninstallPackage(_package, function (error) {
            if (error) {
                log.error('Error uninstalling %s: %s', _package, error.message);
                errors.push({
                    source: _package,
                    message: error.message,
                    stack: error.stack
                });
                return cb();
            }
            return cb();
        });
    },
    function (error) {
        updateSysinfo(function (sysinfoError) {
            if (sysinfoError) {
                log.error(
                    'Error updating sysinfo: ',
                    sysinfoError.message);
            }
            log.info('Done uninstalling all packages.');
            if (errors.length) {
                log.error('There were errors:');
                displayErrors(errors);
                process.exit(1);
            }
        });
    });
};

APM.prototype.getPackages = function (callback) {
    var packages = [];

    fs.readdir(installdir, function (dirError, files) {
        if (dirError) {
            log.error('Error reading ' + installdir);
            callback(dirError);
            return;
        }

        files = files.sort();

        async.each(files, function (f, cb) {
            var fn = path.join(installdir, f, 'package.json');
            var exists = fs.existsSync(fn);
            if (!exists) {
                log.warn(
                    'No package.json found in ' +
                    path.join(installdir, f));
                cb();
                return;
            }

            fs.readFile(fn, function (error, data) {
                var pkg = JSON.parse(data.toString());
                packages.push(pkg);
                cb();
            });
        }, function (error) {
            if (error) {
                log.error('Error: ' + error.message);
                callback(error);
            } else {
                callback(null, packages);
            }
        });
    });
};


function main(logger) {

    var apm;
    var commands = {
        install:   command_install,
        uninstall: command_uninstall,
        list:      command_list
    };

    var command = process.argv[2];

    apm = new APM({log: logger});

    if (!command) {
        console.warn('Command missing.');
        process.exit(1);
    }

    if (!commands.hasOwnProperty(command)) {
        console.warn('Unkown command: %s', command || '');
        process.exit(1);
    }

    commands[command](apm);
}

if (require.main === module) {
    log = bunyan.createLogger({
        name: 'apm',
        stream: process.stderr,
        level: 'debug'
    });

    main(log);
} else {
    module.exports = {
        APM: APM
    };
}
