var Task = require('../task_agent/task');
var zfs = require('zfs').zfs;

var ZFSDestroyDatasetTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(ZFSDestroyDatasetTask);

function start(callback) {
    var self = this;
    var dataset = self.req.params.dataset;

    return (zfs.destroy(dataset, function (err) {
        if (err) {
            return (self.fatal('failed to destroy ZFS dataset "' + dataset +
                '": ' + err.message));
        }

        return (self.finish());
    }));
}

ZFSDestroyDatasetTask.setStart(start);
