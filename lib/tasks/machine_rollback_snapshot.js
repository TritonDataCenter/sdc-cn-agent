var Task = require('../task_agent/task');
var VM = require('/usr/vm/node_modules/VM');
var execFile = require('child_process').execFile;
var common = require('../common');

var MachineRollbackSnapshotTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineRollbackSnapshotTask);

function start(callback) {
    var self = this;

    VM.logger = common.makeVmadmLogger(self);
    VM.logname = 'machine_rollback_snapshot';

    var uuid = self.req.params.uuid;
    var snapname = self.req.params.snapshot_name;

    VM.rollback_snapshot(uuid, snapname, {}, function (error) {
        if (error) {
            var msg = error instanceof Error ? error.message : error;
            self.fatal('VM.rollback_snapshot error: ' + msg);
            return;
        }
        self.progress(100);
        self.finish();
    });
}

MachineRollbackSnapshotTask.setStart(start);
