var Task = require('../task_agent/task');
var zfs = require('zfs').zfs;

var ZFSListDatasetsTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(ZFSListDatasetsTask);

function start(callback) {
    var self = this;

    return (zfs.list('', { type: 'all' }, function (err, fields, rows) {
        if (err) {
            return (self.fatal('failed to list ZFS datasets: ' + err.message));
        }

        /*
         * The fields and rows output from zfs.list() isn't the greatest;
         * convert it to an array of objects here.
         */
        var datasets = [];
        for (var ii = 0; ii < rows.length; ii++) {
            var dataset = {};
            for (var jj = 0; jj < fields.length; jj++) {
                dataset[fields[jj]] = rows[ii][jj];
            }
            datasets.push(dataset);
        }

        self.progress(100);
        return (self.finish(datasets));
    }));
}

ZFSListDatasetsTask.setStart(start);
