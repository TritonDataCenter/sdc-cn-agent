var Task = require('../task_agent/task');
var zfs = require('zfs').zfs;

var ZFSCloneDatasetTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(ZFSCloneDatasetTask);

function start(callback) {
    var self = this;
    var snapshot = self.req.params.snapshot;
    var dataset = self.req.params.dataset;

    return (zfs.clone(snapshot, dataset, function (err) {
        if (err) {
            return (self.fatal('failed to clone ZFS snapshot "' + snapshot +
                '" into dataset "' + dataset + '": ' + err.message));
        }

        return (self.finish());
    }));
}

ZFSCloneDatasetTask.setStart(start);
