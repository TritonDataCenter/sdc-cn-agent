var Task = require('task_agent/task');
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
    var timeout = self.req.params.timeout || 5000;
    setTimeout(function () {
        self.finish();
    }, timeout);
}
