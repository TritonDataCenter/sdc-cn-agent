var Task = require('../task_agent/task');
var zfs = require('zfs').zfs;

var ZFSRenameDatasetTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(ZFSRenameDatasetTask);

function start(callback) {
    var self = this;
    var dataset = self.req.params.dataset;
    var newname = self.req.params.newname;

    return (zfs.rename(dataset, newname, function (err) {
        if (err) {
            return (self.fatal('failed to rename ZFS dataset "' + dataset +
                '" to "' + newname+ '": ' + err.message));
        }

        return (self.finish());
    }));
}

ZFSRenameDatasetTask.setStart(start);
