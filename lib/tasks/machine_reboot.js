var Task = require('../task_agent/task');
var VM = require('/usr/vm/node_modules/VM');
var execFile = require('child_process').execFile;
var common = require('../common');

var MachineRebootTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineRebootTask);

function start(callback) {
    var self = this;

    VM.logger = common.makeVmadmLogger(self);
    VM.logname = 'machine_reboot';

    var uuid = self.req.params.uuid;
    var force = self.req.params.force;

    VM.reboot(uuid, force || false, function (error) {
        if (error) {
            var msg = error instanceof Error ? error.message : error;
            self.fatal('VM.reboot error: ' + msg);
            return;
        }
        self.progress(100);
        self.finish();
    });
}

MachineRebootTask.setStart(start);
