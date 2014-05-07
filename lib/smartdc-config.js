var execFile = require('child_process').execFile;

function execFileParseJSON(bin, args, callback) {
    execFile(
        bin,
        args,
        function (error, stdout, stderr) {
            if (error) {
                callback(Error(stderr.toString()));
                return;
            }
            var obj = JSON.parse(stdout.toString());
            callback(null, obj);
        });
}

function sysinfo(callback) {
    execFileParseJSON(
        '/usr/bin/sysinfo',
        [],
        function (error, config) {
            if (error) {
                callback(error);
                return;
            }
            callback(null, config);
        });
}

function sdcConfig(callback) {
    execFileParseJSON(
        '/bin/bash',
        [ '/lib/sdc/config.sh', '-json' ],
        function (error, config) {
            if (error) {
                callback(error);
                return;
            }
            callback(null, config);
        });
}

module.exports = {
    sdcConfig: sdcConfig,
    sysinfo: sysinfo,
    execFileParseJSON: execFileParseJSON
};
