/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var net = require('net');
var assert = require('assert-plus');
var bunyan = require('bunyan');
var smartDcConfig = require('../lib/task_agent/smartdc-config');
var kstat = require('kstat');
var sprintf = require('sprintf').sprintf;

var SERVER_CLOSE_TIMEOUT = 60 * 1000; // 1 minute
var UPDATE_FREQUENCY = 1000; // every second

// For debugging - when true, will put log messages into own logs file.
var DO_OWN_LOGGING = false;

process.on('message', function (message) {
    assert.object(message, 'message');
    assert.object(message.payload, 'payload');
    assert.string(message.req_id, 'req_id');
    assert.string(message.uuid, 'uuid');
    assert.optionalNumber(message.timeoutSeconds, 'timeoutSeconds');

    var logStreams = [];
    if (DO_OWN_LOGGING) {
        var logfile = sprintf('%s/%s-%s', process.env.logdir, message.req_id,
                                process.env.task);
        logStreams.push({path: logfile, level: 'debug'});
     }
    var log = bunyan.createLogger({name: 'docker-stats',
                                    streams: logStreams,
                                    req_id: message.req_id});

    var opts = {
        log: log,
        req_id: message.req_id,
        payload: message.payload,
        uuid: message.uuid,
        timeoutSeconds: message.timeoutSeconds || SERVER_CLOSE_TIMEOUT
    };

    setupDockerStatsSocket(opts, function (err, response) {
        if (err) {
            process.send({ error: { message: err.message, err: err.stack } });
            return;
        }
        process.send(response);
    });
});


/**
 * Setup the stats tcp server and send back the server's host and port details.
 */
function setupDockerStatsSocket(opts, callback) {

    var log = opts.log;

    log.debug('opts.payload: ', opts.payload);

    opts.doStream = opts.payload.doStream;

    var onListening = function stats_onListening() {
        var addr = tcpServer.address();
        smartDcConfig.getFirstAdminIp(function (err, adminIp) {
            if (err) {
                callback(err);
                return;
            }
            log.info('ending DockerStatsTask');

            var hostAndPort = {
                host: adminIp,
                port: addr.port
            };
            callback(null, hostAndPort);
        });
    };

    var onConnection = function stats_onConnection(socket) {
        log.info('stats got connection on netServer', socket.address());

        // The client connection is made - no longer need the server.
        clearTimeout(serverTimeout);
        tcpServer.close();

        // Go and collect the stats.
        collectContainerStats(socket, opts);
    };

    log.info('starting DockerStatsTask');

    /**
     * Create TCP Server which will output the stats stream.
     */
    var tcpServer = net.createServer();

    // Close server if no connections are received within timeout
    var serverTimeout = setTimeout(function () {
        log.warn('Closing stream tcpServer after ' +
             SERVER_CLOSE_TIMEOUT + ' msec without connection');
        tcpServer.close();
    }, SERVER_CLOSE_TIMEOUT);

    tcpServer.on('listening', onListening);
    tcpServer.on('connection', onConnection);

    tcpServer.listen(0);
}


/**
 * Stats helper functions.
 */

function addNetworkStats(stats, name, data) {
    if (!stats.network) {
        stats.network = {
            'rx_bytes': 0,
            'rx_packets': 0,
            'rx_errors': 0,
            'rx_dropped': 0,
            'tx_bytes': 0,
            'tx_packets': 0,
            'tx_errors': 0,
            'tx_dropped': 0
        };
    }

    var n = stats.network;
    n.rx_bytes += data.rbytes;
    n.rx_packets += data.ipackets;
    n.rx_errors += data.ierrors;
    n.tx_bytes += data.obytes;
    n.tx_packets += data.opackets;
    n.tx_errors += data.oerrors;
    // XXX: Don't have rx_dropped | tx_dropped
}

function addCpuStats(stats, name, data, opts) {
    var i;
    var cpu_num;
    var percpu;
    var lastStats = opts.lastStats;

    if (!stats.cpu_stats) {
        stats.cpu_stats = {
            'cpu_usage': {
                'total_usage': 0,
                'percpu_usage': [],
                'usage_in_kernelmode': 0,
                'usage_in_usermode': 0
            },
            'system_cpu_usage': 0,
            'throttling_data': {
                'periods': 0,
                'throttled_periods': 0,
                'throttled_time': 0
            }
        };
        stats.precpu_stats = lastStats && lastStats.cpu_stats ||
        {
            'cpu_usage': {
                'total_usage': 0,
                'percpu_usage': [],
                'usage_in_kernelmode': 0,
                'usage_in_usermode': 0
            },
            'system_cpu_usage': 0,
            'throttling_data': {
                'periods': 0,
                'throttled_periods': 0,
                'throttled_time': 0
            }
        };
    }

    if (name.substr(0, 13) === 'cpucaps_zone_') {
        // Docker is using incremental values for it's cpu numbers, so we need
        // to combine with the lastStats value. Kstats gives the cpu as a
        // percentage, so allot 100 (percent) to the system_cpu_usage each call.
        if (lastStats) {
            stats.cpu_stats.cpu_usage.total_usage =
                lastStats.cpu_stats.cpu_usage.total_usage + data.usage;
            stats.cpu_stats.system_cpu_usage =
                lastStats.cpu_stats.system_cpu_usage + 100;
        } else {
            stats.cpu_stats.cpu_usage.total_usage = data.usage;
            stats.cpu_stats.system_cpu_usage = 100;
        }

    } else if (name.substr(0, 16) === 'cpucaps_project_') {
        cpu_num = parseInt(name.substr(16), 10);
        percpu = stats.cpu_stats.cpu_usage.percpu_usage;
        // Ensure any missing cpus are filled.
        if (cpu_num > percpu.length) {
            for (i = percpu.length; i < cpu_num; i++) {
                percpu.push(0);
            }
        }
        percpu.push(data.usage);
    }
}

function addMemoryStats(stats, name, data) {
    if (!stats.memory_stats) {
        stats.memory_stats = {
            'usage': 0,
            'max_usage': 0,
            'stats': {
                'active_anon': 0,
                'active_file': 0,
                'cache': 0,
                'hierarchical_memory_limit': 0,
                'hierarchical_memsw_limit': 0,
                'inactive_anon': 0,
                'inactive_file': 0,
                'mapped_file': 0,
                'pgfault': 0,
                'pgmajfault': 0,
                'pgpgin': 0,
                'pgpgout': 0,
                'rss': 0,
                'rss_huge': 0,
                'swap': 0,
                'total_active_anon': 0,
                'total_active_file': 0,
                'total_cache': 0,
                'total_inactive_anon': 0,
                'total_inactive_file': 0,
                'total_mapped_file': 0,
                'total_pgfault': 0,
                'total_pgmajfault': 0,
                'total_pgpgin': 0,
                'total_pgpgout': 0,
                'total_rss': 0,
                'total_rss_huge': 0,
                'total_swap': 0,
                'total_unevictable': 0,
                'total_writeback': 0,
                'unevictable': 0,
                'writeback': 0
            },
            'failcnt': 0,
            'limit': 0
        };
    }

    var mem = stats.memory_stats;
    mem.usage += data.rss;
    mem.limit += data.physcap;
    mem.failcnt += data.anon_alloc_fail;
    mem.stats.pgpgin += data.pgpgin;
    mem.stats.pgpgout += data.pagedout;
    mem.stats.swap += data.swap;
    mem.stats.total_swap += data.swapcap;
}

function addBlockIOStats(stats) {
    if (!stats.blkio_stats) {
        stats.blkio_stats = {
           'io_service_bytes_recursive': [],
           'io_serviced_recursive': [],
           'io_queue_recursive': [],
           'io_service_time_recursive': [],
           'io_wait_time_recursive': [],
           'io_merged_recursive': [],
           'io_time_recursive': [],
           'sectors_recursive': []
        };
    }
}

/*
 * Collect docker stat information from one kstat.read()
 */
function collectOneKstatRead(kst, opts) {
    var className;
    var data;
    var i;
    var stats = { 'read': new Date().toISOString() };
    var zoneUuid = opts.zoneUuid;

    for (i = 0; i < kst.length; i++) {
        data = kst[i].data;
        className = kst[i]['class'];
        if (data && data.zonename === zoneUuid) {
            console.log(kst[i].name + ', ' + kst[i]['class'] + ', ', data);
            if (className === 'net') {
                addNetworkStats(stats, kst[i].name, data);
            } else if (className === 'zone_memory_cap') {
                addMemoryStats(stats, kst[i].name, data);
            } else if (className === 'zone_caps') {
                addCpuStats(stats, kst[i].name, data, opts);
            } else if (className === 'project_caps') {
                addCpuStats(stats, kst[i].name, data, opts);
            }
        }
    }

    addBlockIOStats(stats);

    return stats;
}

/*
 * Periodically gather and then send stats records (json) back through the
 * socket.
 */
function collectContainerStats(socket, opts) {
    assert.object(socket, 'socket');
    assert.object(opts.log, 'log');
    assert.bool(opts.doStream, 'doStream');
    assert.string(opts.uuid, 'uuid');

    var collectorTimeout = -1;
    var doStream = opts.doStream;
    var kstatsReader = new kstat.Reader();
    var lastStats = null;
    var log = opts.log;
    var zoneUuid = opts.uuid;

    log.info('collectContainerStats - stream kstats for zone', zoneUuid);

    // Collect one set of stats and send back to the socket.
    function collectStats() {
        var kst;
        var stats;
        var data;
        var collectOpts;

        kst = kstatsReader.read();
        if (!kst) {
            log.info('No kstats.read() information returned');
            tryEnd();
            return;
        }

        collectOpts = {
            lastStats: lastStats,
            log: log,
            zoneUuid: zoneUuid
        };
        stats = collectOneKstatRead(kst, collectOpts);

        data = JSON.stringify(stats) + '\r\n';

        // opts.log.debug('collectOneKstatRead', data);

        socket.write(data);

        if (!doStream) {
            tryEnd();
            return;
        }

        lastStats = stats;

        collectorTimeout = setTimeout(collectStats, UPDATE_FREQUENCY);
    }

    // Socket error handler - close and return.
    function tryEnd() {
        clearTimeout(collectorTimeout);
        if (!socket.destroyed) {
            socket.destroy();
        }
        log.info('collectContainerStats - stopped kstat streaming');
    }

    socket.on('end', function () {
        log.info('zone stats socket has ended');
        tryEnd();
    });

    collectStats();
}
