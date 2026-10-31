'use strict';
/* global describe, it */
const { expect } = require('chai');
const { DataController } = require('./dataController');

/**
 * Minimal adapter mock with in-memory objects and states.
 *
 * @param [states] initial states (IDs without namespace)
 */
function mockAdapter(states = {}) {
    const ns = 'opendtu.0';
    const objects = {};
    const store = {};
    for (const [id, st] of Object.entries(states)) {
        objects[`${ns}.${id}`] = { type: 'state' };
        store[`${ns}.${id}`] = { val: st.val, ts: st.ts || Date.now(), ack: true };
    }
    const full = id => (id.startsWith(`${ns}.`) ? id : `${ns}.${id}`);
    return {
        namespace: ns,
        name: 'opendtu',
        instance: 0,
        config: {},
        log: { debug() {}, info() {}, warn() {}, error() {} },
        store,
        async extendObjectAsync(id, obj) {
            objects[full(id)] = obj;
        },
        async subscribeStatesAsync() {},
        async getAdapterObjectsAsync() {
            return objects;
        },
        async getStateAsync(id) {
            return store[full(id)] || null;
        },
        async setStateChangedAsync(id, val) {
            store[full(id)] = { val, ts: Date.now(), ack: true };
        },
    };
}

const total = (yieldTotal, yieldDay) => ({
    Power: { v: 0, u: 'W', d: 1 },
    YieldDay: { v: yieldDay, u: 'Wh', d: 0 },
    YieldTotal: { v: yieldTotal, u: 'kWh', d: 3 },
});

describe('DataController: totals over all inverters', () => {
    it('total.yieldtotal does not drop while not all inverters answered (OpenDTU restart / midnight)', async () => {
        const adapter = mockAdapter();
        const dc = new DataController(adapter);
        const val = id => adapter.store[`opendtu.0.total.${id}`].val;

        dc.rememberYield('A', { v: 850.971 }, { v: 1200 });
        dc.rememberYield('B', { v: 455.794 }, { v: 800 });
        dc.rememberYield('C', { v: 2928.442 }, { v: 2500 });
        await dc.processTotalData(total(4235.207, 4500));
        expect(val('yieldtotal')).to.equal(4235.207);
        expect(val('yieldday')).to.equal(4500);

        // OpenDTU restart: only C answered, A and B report 0, DTU total drops to C alone
        dc.rememberYield('A', { v: 0 }, { v: 0 });
        dc.rememberYield('B', { v: 0 }, { v: 0 });
        dc.rememberYield('C', { v: 2928.45 }, { v: 2510 });
        await dc.processTotalData(total(2928.45, 2510));
        expect(val('yieldtotal')).to.equal(4235.215);
        expect(val('yieldday')).to.equal(4510);

        // all answered again
        dc.rememberYield('A', { v: 850.98 }, { v: 1210 });
        dc.rememberYield('B', { v: 455.8 }, { v: 805 });
        await dc.processTotalData(total(4235.23, 4525));
        expect(val('yieldtotal')).to.equal(4235.23);
        expect(val('yieldday')).to.equal(4525);
    });

    it('total.yieldday starts again at 0 on a new day', async () => {
        const adapter = mockAdapter();
        const dc = new DataController(adapter);
        dc.rememberYield('A', { v: 100 }, { v: 1200 });
        // value from yesterday
        dc.yieldDays.set('A', { v: 1200, day: new Date(Date.now() - 86400000).toDateString() });
        dc.rememberYield('A', { v: 100 }, { v: 0 });
        await dc.processTotalData(total(100, 0));
        expect(adapter.store['opendtu.0.total.yieldday'].val).to.equal(0);
    });

    it('a lower yield total of one inverter is ignored', async () => {
        const adapter = mockAdapter();
        const dc = new DataController(adapter);
        dc.rememberYield('A', { v: 500 }, undefined);
        dc.rememberYield('A', { v: 12.3 }, undefined);
        await dc.processTotalData(total(12.3, 0));
        expect(adapter.store['opendtu.0.total.yieldtotal'].val).to.equal(500);
    });

    it('after an adapter start, inverters that have not answered yet are taken from their states', async () => {
        const yesterday = Date.now() - 86400000;
        const adapter = mockAdapter({
            '111.yieldtotal': { val: 850.971 },
            '111.yieldday': { val: 1200 },
            '222.yieldtotal': { val: 455.794 },
            '222.yieldday': { val: 900, ts: yesterday },
            '333.yieldtotal': { val: 2900 },
            '333.dc.input_1.yieldtotal': { val: 1450 },
        });
        const dc = new DataController(adapter);
        dc.rememberYield('333', { v: 2928.442 }, { v: 2500 });
        await dc.processTotalData(total(2928.442, 2500));
        expect(adapter.store['opendtu.0.total.yieldtotal'].val).to.equal(4235.207);
        // B's yield of the day is from yesterday and does not count
        expect(adapter.store['opendtu.0.total.yieldday'].val).to.equal(3700);
    });
});
