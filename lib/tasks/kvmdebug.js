var cp = require('child_process');
var exec = cp.exec;
var spawn = cp.spawn;

var kvm_debug_handles = [];

function startKVMDebugging(log, handler) {

    function addHandler(cmd, args, fn) {
        fn(cmd, args, log, handler, function (err, h) {
            kvm_debug_handles.push(h);
        });
    }

    [
        {cmd: '/usr/bin/vmstat', args: ['-T', 'u', '1']},
        {cmd: '/usr/bin/arcstat', args: ['1']},
        {cmd: '/usr/bin/kstat', args: ['-T', 'u', 'unix:0:vminfo', '1']}
    ].forEach(function (cmdobj) {
        addHandler(cmdobj.cmd, cmdobj.args, spawnStatter);
    });
}

function stopKVMDebugging(log) {
    // call the cleanup functions
    kvm_debug_handles.forEach(function (fn) {
        fn();
    });
    kvm_debug_handles = [];
}

function spawnStatter(cmd, args, log, handler, callback)
{
    var buffer = '';
    var child;
    var child_pid;
    var cleanup;

    log.debug(cmd + ' ' + args.join(' '));
    child = spawn(cmd, args);
    child_pid = child.pid;
    log.debug(cmd + ' running with pid ' + child_pid);

    child.stdout.on('data', function (data) {
        var chunks;
        var output = '';

        buffer += data.toString();
        chunks = buffer.split('\n');
        while (chunks.length > 1) {
            output += chunks.shift() + '\n';
        }
        buffer = chunks.pop();

        if (output.length > 0) {
            handler(cmd, args, output);
        }
    });

    // doesn't take input.
    child.stdin.end();

    child.on('exit', function (code, signal) {
        if (buffer.length > 0) {
            handler(cmd, args, buffer);
            buffer = '';
        }
        if (code) {
            log.debug(cmd + '[' + child_pid + '] exited: ' +
                JSON.stringify(code));
        } else {
            log.debug(cmd + '[' + child_pid + '] exited on signal: ' + signal);
        }
    });

    cleanup = function _cleanupSpawnedStatter() {
        if (child) {
            child.kill();
            child = null;
        }
    };

    callback(null, cleanup);
}

module.exports = {
    startKVMDebugging: startKVMDebugging,
    stopKVMDebugging: stopKVMDebugging
};
