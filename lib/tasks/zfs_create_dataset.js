var Task = require('../task_agent/task');
var zfs = require('zfs').zfs;

var ZFSCreateDatasetTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(ZFSCreateDatasetTask);

function start(callback) {
    var self = this;
    var dataset = self.req.params.dataset;

    return (zfs.create(dataset, function (err) {
        if (err) {
            return (self.fatal('failed to create ZFS dataset "' + dataset +
                '": ' + err.message));
        }

        return (self.finish());
    }));
}

ZFSCreateDatasetTask.setStart(start);
