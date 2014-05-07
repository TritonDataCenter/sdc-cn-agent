var net = require('net');
var events = require('events');
var util = require('util');

var createJsonChunkParser = function (handler) {
    return (function () {
        var buffer = '';
        var onData = function (data) {
            var chunk, chunks;
            buffer += data.toString();
            chunks = buffer.split('\n');
            while (chunks.length > 1) {
                chunk = chunks.shift();
                var msg;
                try {
                    msg = JSON.parse(chunk);
                    handler(msg);
                } catch (e) {
                    console.log('JSON PARSER ERROR!!!!!');
                    console.log(chunk);
                    console.log(e.message);
                    console.log(e.stack);
                }
            }
            buffer = chunks.pop();
        };

        return onData;
    }());
};

function encode(data) {
    return JSON.stringify(data);
}

function Client() {
    events.EventEmitter.call(this);
}

util.inherits(Client, events.EventEmitter);

/**
 * connect
 *
 * @param {String} socket (example: /tmp/vmadmd.sock)
 * @param {Function} callback callback to execute on a successful connection
 *
 * @return {Client} client
 */
Client.prototype.connect = function (sock, callback) {
    var self = this;

    this.connection = net.Stream();
    this.connection.setEncoding('utf8');

    if (typeof (callback) !== 'undefined') {
        this.on('connect', callback);
    }

    function onJSON(result) {
        self.emit('data', result);
        if (result.id) {
            self.emit('data-' + result.id, result);
        }
    }

    this.connection.on('data', createJsonChunkParser(onJSON));

    this.connection.on('connect', function (socket) {
        console.log('Connected to vmadmd socket');
        self.emit('connect', callback);
    });

    this.connection.connect(sock);

    return this;
};

/**
 * Sends an action to vmadmd with the provided payload
 *
 * @param {String} action Action to call (ie: shutdown/halt/create)
 * @param {Object} payload Payload to send with the action, optional
 * @param {Function} callback executes callback(result) on response
 */
Client.prototype.action = function (action, payload, callback) {
    if (arguments.length === 2 && typeof (payload) === 'Function') {
        callback = payload;
        payload  = null;
    }

    var id = (new Date()).getTime();

    var data = {
        'id': id,
        'action': action,
        'payload': payload
    };

    if (callback !== undefined) {
        this.on('data-'+id, function (response) {
            console.log(
                'Got response back from vmadmd action "%s": %s', action,
            response.type);
            return callback(response);
        });
    }

    this.connection.write(encode(data) + '\n\n');
};

exports.Client = Client;
