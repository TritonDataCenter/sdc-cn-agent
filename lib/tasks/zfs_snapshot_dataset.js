var Task = require('../task_agent/task');
var zfs = require('zfs').zfs;

var ZFSSnapshotDatasetTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(ZFSSnapshotDatasetTask);

function start(callback) {
    var self = this;
    var dataset = self.req.params.dataset;

    return (zfs.snapshot(dataset, function (err) {
        if (err) {
            return (self.fatal('failed to snapshot ZFS dataset "' + dataset +
                '": ' + err.message));
        }

        return (self.finish());
    }));
}

ZFSSnapshotDatasetTask.setStart(start);
