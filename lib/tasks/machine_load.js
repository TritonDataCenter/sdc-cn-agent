var Task = require('../task_agent/task');
var VM  = require('/usr/vm/node_modules/VM');
var execFile = require('child_process').execFile;
var common = require('../common');

var MachineLoadTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineLoadTask);

function start(callback) {
    var self = this;
    var uuid = self.req.params.uuid;

    VM.logger = common.makeVmadmLogger(self);
    VM.logname = 'machine_load';

    VM.load(uuid, function (error, machine) {
        if (error) {
            var msg = error instanceof Error ? error.message : error;
            self.fatal('VM.load error: ' + msg);
            return;
        }
        self.progress(100);
        self.finish(machine);
    });
}

MachineLoadTask.setStart(start);
