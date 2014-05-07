var Task = require('../task_agent/task');
var fw = require('/usr/fw/lib/fw');
var VM = require('/usr/vm/node_modules/VM');
var common = require('../common');

var FwAddTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(FwAddTask);

function start(callback) {
    var self = this;

    VM.logger = common.makeVmadmLogger(self);
    VM.logname = 'fw_add';

    return VM.lookup({}, { 'full': true }, function (err, vms) {
        if (err) {
            var msg = err instanceof Error ? err.message : err;
            return self.fatal('VM.lookup error: ' + msg);
        }

        self.progress(50);

        var opts = self.req.params;
        opts.vms = vms;
        opts.logName = 'provisioner_fw_add';

        return fw.add(opts, function (err2, res) {
            if (err2) {
                return self.fatal('fw.add error: ' + err2.message);
            }

            self.progress(100);
            return self.finish();
        });
    });
}

FwAddTask.setStart(start);
