var smartdc_config = require('./smartdc-config');

/**
 * Use /usr/bin/sysinfo and /lib/sdc/config.sh to determine AMQP
 * credentials or fall back to ENV variables.
 *
 * This method should be monkey-patched into an object's prototype.
 */

function configureAMQP(callback) {
    var self = this;

    self.config.amqp = self.config.amqp || {};

    if (!self.config.use_system_config ||
            ['0', 'false'].indexOf(
                process.env['AMQP_USE_SYSTEM_CONFIG']) !== -1) {

        self.uuid = self.config.uuid || process.env.SERVER_UUID;
        setAMQPConfig(
                self.config.amqp.login || process.env['AMQP_LOGIN'],
                self.config.amqp.password || process.env['AMQP_PASSWORD'],
                self.config.amqp.host || process.env['AMQP_HOST'],
                self.config.amqp.port || process.env['AMQP_PORT'],
                self.config.amqp.vhost || process.env['AMQP_VHOST']);
        callback();
    } else {
        smartdc_config.sysinfo(function (error, sysinfo) {
            self.sysinfo = sysinfo;

            // Look up and set the UUID of the machine the agent will run on.
            if (self.config.uuid || process.env['SERVER_UUID']) {
                self.uuid = self.config.uuid || process.env['SERVER_UUID'];
            } else {
                self.uuid = self.sysinfo['UUID'];
                if (!self.uuid) {
                    throw new Error(
                        'Could not find "UUID" in `sysinfo` output.');
                }
            }

            smartdc_config.sdcConfig(function (configError, sdcconfig) {
                self.sdcConfig = sdcconfig;
                var rabbitmq = sdcconfig['rabbitmq'].split(':');
                if (!rabbitmq) {
                    throw new Error(
                        'Could not find "rabbitmq" parameter from'
                        + ' /lib/sdc/config.sh');
                }
                setAMQPConfig.apply(undefined, rabbitmq);
                callback();
            });
        });
    }

    function setAMQPConfig(login, password, host, port, vhost) {
        self.config.amqp.login = login || 'guest';
        self.config.amqp.password = password || 'guest';
        self.config.amqp.host = host || 'localhost';
        self.config.amqp.port = port || 5672;
        self.config.amqp.vhost = vhost || '/';
    }
}


// generate random 4 byte hex strings
function genId() {
    return Math.floor(Math.random() * 0xffffffff).toString(16);
}


function dotjoin() {
    return Array.prototype.join.call(arguments, '.');
}


module.exports = {
    dotjoin: dotjoin,
    genId: genId,
    configureAMQP: configureAMQP
};
