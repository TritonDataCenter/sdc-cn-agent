var kstat = require('kstat');
var prom = require('prom-client');

function MonitorAgent() {
    // kstat caps:1:cpucaps_zone_1:*
    var reader = new kstat.Reader(
        {
            'class': 'zone_caps',
            module: 'caps',
            name: 'cpucaps_zone_1',
            instance: '1'
    });
    var data = [];
    var gen = 0;
    var cpuCapsUsageGauge = new prom.gauge('cpucaps_z1_usage', 'z1hlp1');
    var cpuCapsBelowGauge = new prom.gauge('cpucaps_z1_below', 'z1hlp2');
    var cpuCapsAboveGauge = new prom.gauge('cpucaps_z1_above', 'z1hlp3');

    setInterval(function _getKstats() {
        data[gen] = reader.read()[0];
        gen ^= 1;

        if (!(data[0] && data[1])) {
            return;
        }

        cpuCapsUsageGauge.set(data[gen ^ 1].data.usage);
        cpuCapsBelowGauge.set(data[gen ^ 1].data.below_sec);
        cpuCapsAboveGauge.set(data[gen ^ 1].data.above_sec);
    }, 5000);

    //  kstat memory_cap:::, "rss" vs "physcap", "swap" vs "swapcap"
    var reader2 = new kstat.Reader(
        {
            'class': 'zone_memory_cap',
            module: 'memory_cap',
            instance: '1'
    });
    var data2 = [];
    var gen2 = 0;
    var memCapsRssGauge = new prom.gauge('memcaps_z1_rss', 'z1hl4');
    var memCapsSwapGauge = new prom.gauge('memcaps_z1_swap', 'z1hl5');
    var memCapsPageInGauge = new prom.gauge('memcaps_z1_anonpgin', 'z1hl6');
    var memCapsAllocFailGauge = new prom.gauge('memcaps_z1_allocfail', 'z1hl6');

    setInterval(function _getKstats2() {
        data2[gen2] = reader2.read()[0];
        gen2 ^= 1;

        if (!(data2[0] && data2[1])) {
            return;
        }

        memCapsRssGauge.set(data2[gen2 ^ 1].data.rss);
        memCapsSwapGauge.set(data2[gen2 ^ 1].data.swap);
        memCapsPageInGauge.set(data2[gen2 ^ 1].data.anonpgin);
        memCapsAllocFailGauge.set(data2[gen2 ^ 1].data.anon_alloc_fail);
    }, 5000);
}

MonitorAgent.prototype.getMetrics = function () {
    return prom.register.metrics();
};

module.exports = MonitorAgent;
