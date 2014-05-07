var Task = require('../task_agent/task');
var VM = require('/usr/vm/node_modules/VM');
var execFile = require('child_process').execFile;
var fs = require('fs');
var common = require('../common');

var MachineLoadTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineLoadTask);

function start(callback) {
    var self = this;
    var uuid = self.req.params.uuid;
    var options = {};

    VM.logger = common.makeVmadmLogger(self);
    VM.logname = 'machine_screenshot';

    VM.sysrq(uuid, 'screenshot', options, function (error, response) {
        if (error) {
            var msg = error instanceof Error ? error.message : error;
            self.fatal('VM.sysrq error: ' + msg);
            return;
        }

        var ssFilename = '/zones/' + uuid + '/root/tmp/vm.ppm';
        self.log.info('vmadm screenshot success: ' + ssFilename);
        var ssContents = fs.readFileSync(ssFilename);
        self.log.info('file: ' + ssContents.length + ' bytes');

        self.event('screenshot', ssContents.toString('base64'));

        self.progress(100);
        self.finish();
    });
}

MachineLoadTask.setStart(start);
