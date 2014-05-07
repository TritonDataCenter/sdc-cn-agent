var Task = require('../task_agent/task');
var zfs = require('zfs').zfs;

var ZFSRollbackDatasetTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(ZFSRollbackDatasetTask);

function start(callback) {
    var self = this;
    var dataset = self.req.params.dataset;

    return (zfs.rollback(dataset, function (err) {
        if (err) {
            return (self.fatal('failed to rollback ZFS dataset "' + dataset +
                '": ' + err.message));
        }

        return (self.finish());
    }));
}

ZFSRollbackDatasetTask.setStart(start);
