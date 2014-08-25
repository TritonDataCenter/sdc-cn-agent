/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var Task = require('../task_agent/task');
var sqlite3 = require('/usr/node/node_modules/sqlite3');
var util = require('util');
var fs = require('fs');
var async = require('async');
var common = require('../common');

var QueryTask = module.exports = function (req) {
    Task.call(this);
};

Task.createTask(QueryTask);

QueryTask.setStart(start);

function start(callback) {
    var self = this;
    var req = this.req;
    var networkReport;
    var configReport;

    var database_path
        = req.params.zonetracker_database_path ||
          self.sdcConfig.zonetracker_database_path;

    async.waterfall([
        function (cb) {
            if (isNaN(new Date(req.params.time_start).getTime()) ||
                isNaN(new Date(req.params.time_end).getTime())) {

                cb(new Error('Invalid range given.'));
                return;
            }

            req.params.time_start
                = new Date(req.params.time_start).toISOString();
            req.params.time_end
                = new Date(req.params.time_end).toISOString();
            cb();
        },
        function (cb) {
            queryConfiguration(
                database_path, req.params,
                function (error, report) {
                    configReport = report;
                    cb(error);
                });
        },
        function (cb) {
            queryNetwork(database_path, req.params, function (error, report) {
                networkReport = report;
                cb(error);
            });
        }
    ],
    function (error) {
        if (error) {
            self.fatal(error.message);
            return;
        }

        var report = {};
        var result = {
            time_start: req.params.time_start,
            time_end: req.params.time_end,
            zones: report
        };

        Object.keys(configReport).forEach(function (zone) {
            if (!report[zone]) {
                report[zone] = {};
            }

            if (!report[zone].configuration) {
                report[zone].configuration = {};
            }

            report[zone].configuration.history = configReport[zone].history;
            report[zone].owner_uuid = configReport[zone].owner_uuid;
            report[zone].zone_uuid = configReport[zone].zone_uuid;
        });

        Object.keys(networkReport).forEach(function (zone) {
            if (!report[zone]) {
                report[zone] = {};
            }

            if (!report[zone].metering) {
                report[zone].metering = {};
            }

            report[zone].metering.network = networkReport[zone];
        });

        self.finish(result);
    });
}

var queryConfiguration = function (dbfilename, msg, callback) {
    var owner_uuid = msg.owner_uuid;
    var zone = msg.zone;
    var zone_uuid = msg.zone_uuid;

    var sql = [];
    var placeHolders = [];

    /*
     * First step:
     *
     *   For each zone returned by the given (zone, zone_uuid, owner_uuid
     *   given), find the event immediately preceding it. We will union this
     *   query with the next query (see below), which returns the bulk of the
     *   result.
     */

    sql = sql.concat([
        'SELECT tcb.timestamp     AS timestamp,',
        '       tca.zone          AS zone,',
        '       tca.zone_uuid     AS zone_uuid,',
        '       tca.owner_uuid    AS owner_uuid,',
        '       tca.configuration AS configuration',
        '  FROM track_configuration tca',
        '  JOIN (   SELECT zone, timestamp',
        '             FROM track_configuration',
        '            WHERE timestamp < ?',
        '         GROUP BY zone',
        '         ORDER BY zone ASC, timestamp ASC',
        '       ) tcb',
        '    ON tca.zone=tcb.zone'
    ]);

    placeHolders.push(msg.time_start);

    sql = sql.concat([
        WHERE_CLAUSE(
            {
                'tca.zone':       zone,
                'tca.zone_uuid':  zone_uuid,
                'tca.owner_uuid': owner_uuid
            },
            placeHolders),
        'GROUP BY tca.zone'
    ]);

    /*
     * Second step:
     *
     *   Fetch the rest of the result rows.
     */

    sql = sql.concat([
        'UNION',
        'SELECT timestamp, zone, zone_uuid, owner_uuid,',
        'configuration',
        'FROM track_configuration',
        WHERE_CLAUSE(
            {
                'zone':       zone,
                'zone_uuid':  zone_uuid,
                'owner_uuid': owner_uuid
            },
            placeHolders,
            [
                'timestamp >  ?',
                'timestamp <= ?'
            ]),
        'ORDER BY zone ASC, timestamp ASC'
    ]);

    placeHolders.push(msg.time_start);
    placeHolders.push(msg.time_end);

    function WHERE_CLAUSE(params, ph, addtl) {
        var whereClause = [];

        Object.keys(params).forEach(function (k) {
            searchBy(k, params[k]);
        });

        if (addtl && Array.isArray(addtl) && addtl.length) {
            whereClause = whereClause.concat(addtl);
        }

        return whereClause.length ? 'WHERE ' + whereClause.join(' AND ') : '';

        function searchBy(fieldName, value) {
            if (isString(value)) {
                whereClause.push(fieldName + ' = ?');
                ph.push(value);
            } else if (isArray(value)) {
                whereClause.push(
                    [
                        fieldName,
                        'IN (',
                        placeholderstr(value.length),
                        ')'
                    ].join(' '));
                ph.push.apply(ph, value);
            }
        }
    }

    sql = sql.join('\n');
    //   console.log('SQL: ' + sql + '\n');
    //   console.dir(placeHolders);

    var database = new sqlite3.Database();
    database.open(
        dbfilename,
        function () {
            database.execute(
                sql,
                placeHolders,
                function (error, rows) {
                    if (error) {
                        callback(error);
                        return;
                    }

                    var report = configurationReportFromRows({
                        time_start: msg.time_start,
                        time_end:   msg.time_end,
                        rows:       rows
                    });

                    database.close(function () {});
                    callback(null, report);
                });
        });
};

var configurationReportFromRows = function (args) {
    var rows = args.rows;
    var report = {};
    var prevRow, prevRows = {};

    for (var i = rows.length; i--; ) {
        var row = rows[i];

        if (!prevRows[row.zone]) {
            prevRows[row.zone] = {};
        }

        prevRow = prevRows[row.zone];

        if (!report[row.zone]) {
            report[row.zone] = { history: [] };
        }

        var period_start;
        var period_end;

        if (prevRow) {
            period_start = row.timestamp;
            period_end = prevRow.timestamp;
        } else {
            period_start = row.timestamp;
            period_end = prevRow.timestamp;
        }

        prevRows[row.zone] = row;

        var event = {
            timestamp: row.timestamp,
            period_start: period_start,
            period_end: period_end,
            configuration: JSON.parse(row.configuration)
        };

        if (!report[row.zone].owner_uuid) {
            report[row.zone].owner_uuid = row.owner_uuid;
        }
        if (!report[row.zone].zone_uuid) {
            report[row.zone].zone_uuid = row.zone_uuid;
        }
        report[row.zone].history.unshift(event);
    }

    return report;
};

function queryNetwork(dbfilename, msg, callback) {
    var owner_uuid = msg.owner_uuid;
    var zone = msg.zone;
    var zone_uuid = msg.zone_uuid;

    var sql = [];
    var placeHolders = [];

    /*
     * First step:
     *
     *   For each zone returned by the given (zone, zone_uuid, owner_uuid
     *   given), find the event immediately preceding it. We will union this
     *   query with the next query (see below), which returns the bulk of the
     *   result.
     */

    /*
     * Second step:
     *
     *   Fetch the rest of the result rows.
     */

    sql = sql.concat([
        'SELECT',
        'timestamp, zone, zone_uuid, owner_uuid,',
        'link, received, sent, counter_start',
        'FROM track_network',
        WHERE_CLAUSE(
            {
                'zone':       zone,
                'zone_uuid':  zone_uuid,
                'owner_uuid': owner_uuid
            },
            placeHolders,
            [
                'timestamp >=  ?',
                'timestamp <= ?'
            ]),
            'ORDER BY zone ASC, timestamp ASC'
    ]);

    placeHolders.push(msg.time_start);
    placeHolders.push(msg.time_end);

    function WHERE_CLAUSE(params, ph, addtl) {
        var whereClause = [];

        Object.keys(params).forEach(function (k) {
            searchBy(k, params[k]);
        });

        if (addtl && Array.isArray(addtl) && addtl.length) {
            whereClause = whereClause.concat(addtl);
        }

        return whereClause.length ? 'WHERE ' + whereClause.join(' AND ') : '';

        function searchBy(fieldName, value) {
            if (isString(value)) {
                whereClause.push(fieldName + ' = ?');
                ph.push(value);
            } else if (isArray(value)) {
                whereClause.push(
                    [
                        fieldName,
                        'IN (',
                        placeholderstr(value.length),
                        ')'
                    ].join(' '));

                ph.push.apply(ph, value);
            }
        }
    }

    sql = sql.join('\n');
    //   console.log('SQL: ' + sql + '\n');
    //   console.dir(placeHolders);

    var database = new sqlite3.Database();
    database.open(
        dbfilename,
        function () {
            database.execute(
                sql,
                placeHolders,
                function (error, rows) {
                    if (error) {
                        callback(error);
                        return;
                    }

                    var report = networkReportFromRows({
                        time_start: msg.time_start,
                        time_end:   msg.time_end,
                        rows:       rows
                    });

                    database.close(function () {});
                    callback(null, report);
                });
        });
}

var networkReportFromRows = function (args) {
    var rows = args.rows;
    var report = {};
    var prevRow, prevRows = {};

    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];

        if (!prevRows[row.zone]) {
            prevRows[row.zone] = {};
        }

        prevRow = prevRows[row.zone][row.link];

        if (!report[row.zone]) {
            report[row.zone] = {};
        }

        if (!report[row.zone][row.link]) {
            report[row.zone][row.link] = { history: [] };
        }

        var sent = 0;
        var received = 0;
        var period_start;
        var period_end;

        if (prevRow) {
            if (prevRow.counter_start != row.counter_start) {
                sent = Number(row.sent);
                received = Number(row.received);
            } else {
                sent = row.sent - prevRow.sent;
                received = row.received - prevRow.received;
            }

            period_start = prevRow.timestamp;
        } else {
            sent = Number(row.sent);
            received = Number(row.received);

            period_start = null;
        }

        period_end = row.timestamp;

        prevRows[row.zone][row.link] = row;

        if (period_start != null) {
            var record = {
                period_start: period_start,
                period_end: period_end,
                bytes_sent: sent,
                bytes_received: received
                //           counter_start: row.counter_start,
                //           absolute_sent: row.sent,
                //           absolute_received: row.received,
                //           timestamp: row.timestamp,
            };

            report[row.zone][row.link].history.push(record);
        }
    }

    return report;
};

function isString(obj) {
    return Object.prototype.toString.call(obj) === '[object String]';
}

function isArray(obj) {
    return Array.isArray(obj);
}

function placeholderstr(n) {
    return repeat('?', n).split('').join(', ');
}

function repeat(str, num) {
    return new Array(num + 1).join(str);
}
