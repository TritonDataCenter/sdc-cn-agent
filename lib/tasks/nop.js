var Task = require('../task_agent/task');
var execFile = require('child_process').execFile;
var common = require('../common');

var Sleep = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(Sleep);

Sleep.setStart(start);

function start(callback) {
    var self = this;
    if (self.req.params.sleep) {
        setTimeout(function () {
            console.error('ALL DONE WAITING');
            self.finish();
        }, Number(self.req.params.sleep)*1000);
    } else {
        console.error('NOT WAITING');
        self.finish();
    }
}
