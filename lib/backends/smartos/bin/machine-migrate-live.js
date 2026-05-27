/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2026 Edgecast Cloud LLC.
 */

/*
 * Overview: workhorse process for bhyve live-migration phases.
 *
 * Unlike machine-migrate-send.js (cold migration), this child does not own
 * the data plane.  RAM / device-state transfer, ZFS orchestration, and
 * bhyve control-socket handling all live in the per-CN
 * vmm-migrate-agent (mariana-trench, long-lived SMF service listening on
 * /var/run/vmm-migrate.sock).  This script's only job is to forward a
 * phase command — live-begin, live-sync, live-switch, live-abort — to
 * that agent, wait for a terminal state, and report one IPC result back
 * to the parent Task.
 *
 * This keeps the cn-agent surface trivial: no long-lived state per
 * migration, no bhyve or zvol handles.  The agent is the orchestrator;
 * cn-agent is a task broker.
 *
 * IPC protocol (matches machine-migrate-send.js):
 *   in:  { payload: { action, migrationTask, ... }, req_id, uuid }
 *   out: { error: { message, ... } } | { ok: true, state, phase, ... }
 *
 * `payload.action` is the agent verb (live-begin / live-sync /
 * live-switch / live-abort) set by the VMAPI workflow.
 * `payload.migrationTask.action` is the phase (begin / sync / switch)
 * and is carried through for cross-reference but not used for dispatch.
 *
 * Exactly one out-message per invocation.
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var net = require('net');
var util = require('util');

var AGENT_SOCKET = '/var/run/vmm-migrate.sock';
var SWITCH_POLL_INTERVAL_MS = 1000;
var SWITCH_POLL_TIMEOUT_MS = 15 * 60 * 1000;  // 15 min max for a cutover
var PHASE_TIMEOUT_MS = {
    'live-begin':  60 * 60 * 1000,   // full zfs send can take a while
    'live-sync':   30 * 60 * 1000,
    'live-switch': 15 * 60 * 1000,
    'live-abort':  2  * 60 * 1000
};

/*
 * Map VMAPI-workflow-level action names to the commands the
 * vmm-migrate-agent exposes on its local Unix socket.
 */
var AGENT_COMMAND_FOR_ACTION = {
    'live-begin':  'migrate-begin',
    'live-sync':   'migrate-sync',
    'live-switch': 'migrate-switch',
    'live-abort':  'migrate-abort'   // agent's abort command (if absent,
                                     // returns an error cleanly)
};

function setupLogging(action, req_id) {
    var streams = [];
    var logfile = util.format('%s/%s-%s-machine_migrate_live.log',
        process.env.logdir, process.env.logtimestamp, process.pid);
    streams.push({path: logfile, level: 'debug'});

    return bunyan.createLogger({
        name: 'machine-migrate-live',
        streams: streams,
        serializers: bunyan.stdSerializers,
        action: action,
        req_id: req_id
    });
}

/*
 * Send one JSON line to the agent, read one JSON line back.
 * The agent's wire protocol is newline-delimited JSON in both
 * directions (see mariana-trench/services/vmm-migrate-agent/src/api.rs).
 */
function agentCall(command, log, callback) {
    var sock = net.createConnection(AGENT_SOCKET);
    var buf = '';
    var settled = false;

    function settle(err, result) {
        if (settled) {
            return;
        }
        settled = true;
        sock.destroy();
        callback(err, result);
    }

    sock.on('connect', function () {
        log.debug({cmd: command}, 'agent connect');
        sock.write(JSON.stringify(command) + '\n');
    });

    sock.on('data', function (chunk) {
        buf += chunk.toString('utf8');
        var nl = buf.indexOf('\n');
        if (nl < 0) {
            return;
        }
        var line = buf.slice(0, nl);
        try {
            var resp = JSON.parse(line);
            log.debug({resp: resp}, 'agent response');
            settle(null, resp);
        } catch (e) {
            settle(new Error('invalid JSON from agent: ' + e.message));
        }
    });

    sock.on('error', function (err) {
        settle(new Error('agent socket error: ' + err.message));
    });

    sock.on('close', function () {
        if (!settled) {
            settle(new Error('agent closed connection before reply'));
        }
    });
}

/*
 * For the switch phase: migrate-switch returns immediately with
 * state=running, and the agent drives the cutover in the background.
 * Poll status until the state machine lands on a terminal value.
 */
function pollUntilTerminal(vm_uuid, deadline, log, callback) {
    // Remember the last (phase, inner_phase) we saw and log at info
    // level on every transition.  A switch can sit in 'running' for
    // minutes during baseline RAM push / convergence; without
    // progress log lines an operator watching a hung migration has
    // only the initial call and the final timeout to work with.
    var lastPhase = null;
    var lastInner = null;
    var started = Date.now();

    function tick() {
        if (Date.now() > deadline) {
            callback(new Error('switch timed out waiting for terminal ' +
                'state after ' + (Date.now() - started) + 'ms'));
            return;
        }
        agentCall({command: 'status', vm: vm_uuid}, log,
            function (err, resp) {
            if (err) {
              callback(err);
              return;
            }
            var state = resp && resp.state;
            var phase = resp && resp.phase;
            var inner = resp && resp.inner_phase;
            if (phase !== lastPhase || inner !== lastInner) {
                log.info({
                    state: state,
                    phase: phase,
                    inner_phase: inner,
                    elapsed_ms: Date.now() - started
                }, 'switch progress');
                lastPhase = phase;
                lastInner = inner;
            } else {
                log.debug({state: state, phase: phase}, 'poll');
            }
            if (state === 'successful' || state === 'failed' ||
                    state === 'aborted') {
                callback(null, resp);
                return;
            }
            setTimeout(tick, SWITCH_POLL_INTERVAL_MS);
        });
    }
    tick();
}

function runPhase(opts, callback) {
    var action = opts.action;
    var log = opts.log;
    var vm_uuid = opts.vm_uuid;
    var command = {command: AGENT_COMMAND_FOR_ACTION[action], vm: vm_uuid};

    // live-begin additionally needs the destination endpoint.  VMAPI's
    // workflow is expected to resolve target_server_uuid -> admin IP and
    // pass it in payload.target_admin_ip; we tack on the agent's TCP
    // listener port (:4567) here rather than let the workflow hardcode it.
    if (action === 'live-begin') {
        if (!opts.target_admin_ip) {
            callback(new Error('live-begin requires payload.target_admin_ip'));
            return;
        }
        command.dest = opts.target_admin_ip + ':4567';
    }

    agentCall(command, log, function (err, resp) {
        if (err) {
            callback(err);
            return;
        }

        // begin/sync return synchronously with state=successful|failed.
        // switch returns state=running; poll for the real outcome.
        if (action === 'live-switch' && resp && resp.state === 'running') {
            var deadline = Date.now() + SWITCH_POLL_TIMEOUT_MS;
            pollUntilTerminal(vm_uuid, deadline, log, callback);
            return;
        }
        callback(null, resp);
    });
}

process.on('message', function (message) {
    assert.object(message, 'message');
    assert.object(message.payload, 'payload');
    assert.string(message.req_id, 'req_id');
    assert.string(message.uuid, 'uuid');

    /*
     * Two action namespaces coexist in the payload:
     *   - `migrationTask.action` is the VMAPI phase ('begin' / 'sync' /
     *     'switch') — useful for logging but not for dispatch.
     *   - `payload.action` is the concrete agent verb ('live-begin' /
     *     'live-sync' / 'live-switch' / 'live-abort') set by the VMAPI
     *     workflow task (dispatchLiveSyncTask or the switch/abort tasks
     *     in vm-migration/live.js).
     * The workflow chose which verb to send; we dispatch strictly on
     * that, not on the phase, so sync can fan out to either live-begin
     * or live-sync depending on num_sync_phases.
     */
    assert.string(message.payload.action, 'payload.action');

    var action = message.payload.action;
    assert.ok(Object.prototype.hasOwnProperty.call(AGENT_COMMAND_FOR_ACTION,
        action), 'unknown live action: ' + action);

    var log = setupLogging(action, message.req_id);

    // Per-phase wall-clock ceiling so a stuck agent doesn't leave the
    // cn-agent task hanging indefinitely.
    var phaseTimeoutMs = PHASE_TIMEOUT_MS[action];
    var phaseTimer = setTimeout(function () {
        process.send({error: {message: 'live migration ' + action +
            ' timed out after ' + phaseTimeoutMs + 'ms'}});
        process.exit(1);
    }, phaseTimeoutMs);

    runPhase({
        action: action,
        log: log,
        vm_uuid: message.uuid,
        target_admin_ip: message.payload.target_admin_ip
    }, function (err, resp) {
        clearTimeout(phaseTimer);
        if (err) {
            log.error({err: err}, 'phase failed');
            process.send({error: {message: err.message}});
            return;
        }
        if (resp && resp.state && resp.state !== 'successful') {
            log.warn({resp: resp}, 'phase ended non-successful');
            process.send({error: {message: 'migration phase ' + action +
                ' ended with state ' + resp.state, agent_response: resp}});
            return;
        }
        log.info({resp: resp}, 'phase completed');
        process.send({ok: true, action: action, agent_response: resp});
    });
});
