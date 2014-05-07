var Task = require('../task_agent/task');
var VM = require('/usr/vm/node_modules/VM');
var execFile = require('child_process').execFile;
var common = require('../common');

var MachineShutdownTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineShutdownTask);

function start(callback) {
    var self = this;
    var uuid = self.req.params.uuid;
    var force = self.req.params.force;

    VM.logger = common.makeVmadmLogger(self);
    VM.logname = 'machine_shutdown';

    VM.stop(uuid, force || false, function (error) {
        if (error) {
            var msg = error instanceof Error ? error.message : error;
            self.fatal('VM.shutdown error: ' + msg);
            return;
        }
        self.progress(100);
        self.finish();
        return;
    });
}

MachineShutdownTask.setStart(start);
