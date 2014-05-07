var Task = require('../task_agent/task');
var zfs = require('zfs').zfs;

function ZFSListSnapshotsTask(req) {
    Task.call(this);
    this.req = req;
}

Task.createTask(ZFSListSnapshotsTask);

function start(callback) {
    var self = this;

    var dataset = self.req.params.dataset || '';

    zfs.list(
        dataset,
        { type: 'snapshot', recursive: true },
        function (err, fields, rows) {
            if (err) {
                self.fatal('failed to list ZFS datasets: ' + err.message);
                return;
            }

            /*
             * Convert zfs list output to an array of objects.
             */
            var datasets = [];
            for (var ii = 0; ii < rows.length; ii++) {
                dataset = {};
                for (var jj = 0; jj < fields.length; jj++) {
                    dataset[fields[jj]] = rows[ii][jj];
                }
                datasets.push(dataset);
            }

            self.progress(100);
            self.finish(datasets);
        });
}

ZFSListSnapshotsTask.setStart(start);

module.exports = ZFSListSnapshotsTask;
