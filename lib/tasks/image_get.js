var Task = require('../task_agent/task');
var VM  = require('/usr/vm/node_modules/VM');
var execFile = require('child_process').execFile;
var common = require('../common');
var imgadm = require('../imgadm');

var ImageGetTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(ImageGetTask);

function start(callback) {
    var self = this;
    var params = { uuid: self.req.params.uuid, log: self.log };

    imgadm.getImage(params, function (error, image) {
        if (error) {
            var msg = error instanceof Error ? error.message : error;
            self.fatal('Image.get error: ' + msg);
            return;
        }
        self.progress(100);
        self.finish(image);
    });
}

ImageGetTask.setStart(start);
