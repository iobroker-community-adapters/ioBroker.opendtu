'use strict';

const stateDefinition = require('./stateDefinition').stateDefinition;
const statesToSetZero = [
    'current',
    'irradiation',
    'power',
    'voltage',
    'frequency',
    'power_dc',
    'reactivepower',
    'temperature',
];

class DataController {
    /**
     * @param adapter adapter instance
     * @param [callbacks] optional: onEventCount(serial, count) when the number of event log entries changes,
     *        onReachable(serial) when an inverter is seen first or comes back online
     */
    constructor(adapter, callbacks = {}) {
        this.adapter = adapter;
        this.onEventCount = callbacks.onEventCount;
        this.onReachable = callbacks.onReachable;
        // last known number of event log entries per inverter
        this.eventCounts = new Map();
        // last known reachability per inverter (independent of the "set to 0" option)
        this.reachable = new Map();
        // last DC power per inverter for total.power_dc
        this.dcPower = new Map();
        // last valid yield total per inverter in kWh (never decreasing), for total.yieldtotal
        this.yieldTotals = new Map();
        // last yield of the day per inverter in Wh with the local day it was received ({ v, day }), for total.yieldday
        this.yieldDays = new Map();
        // true once yieldTotals / yieldDays were seeded from the existing states
        this.yieldSeeded = false;
        // last accepted relative limit per inverter, and until when a 0 % limit is expected after own commands
        this.lastLimit = new Map();
        this.zeroLimitUntil = new Map();
        // @KI_HINWEIS: kept per instance (not module-wide) so several instances can share one process in compact mode
        // IDs of objects already created in this run
        this.createCache = new Set();
        // serials of inverters currently offline
        this.inverterOffline = new Set();
    }

    async processInverterData(inverters) {
        for (const inverter of inverters) {
            if (!this.createCache.has(inverter.serial)) {
                if (this.onReachable) {
                    this.onReachable(inverter.serial);
                }
                const deviceObj = {
                    type: 'device',
                    common: {
                        name: inverter.name,
                        desc: 'Inverter',
                        statusStates: {
                            onlineId: `${this.adapter.name}.${this.adapter.instance}.${inverter.serial}.available`,
                        },
                    },
                    native: {},
                };
                await this.adapter.extendObjectAsync(inverter.serial, deviceObj);
                this.createCache.add(inverter.serial);
            }

            // Power control
            await this.createPowerControls(inverter.serial);

            // States
            // @KI_HINWEIS: after an OpenDTU restart limit_relative is 0 until the limit was read from the
            // inverter (minutes with a weak radio link); MQTT publishes nothing in that time. The API has no
            // validity flag and "producing" is false at 0 W, so a reported 0 % is only accepted if this adapter
            // commanded 0 recently, if 0 was already the last value, or as the first value after the start.
            const fields = { ...inverter };
            if (fields.limit_relative === 0 && !this.isZeroLimitAccepted(inverter.serial)) {
                delete fields.limit_relative;
                delete fields.limit_absolute;
            } else if (typeof fields.limit_relative === 'number') {
                this.lastLimit.set(inverter.serial, fields.limit_relative);
            }

            for (const [stateName, val] of Object.entries(fields)) {
                switch (stateName) {
                    case 'AC':
                        await this.processACData(inverter.serial, val);
                        break;
                    case 'DC':
                        await this.processDCData(inverter.serial, val);
                        break;
                    case 'INV':
                        // remember DC power for the sum over all inverters
                        if (val && val['0'] && val['0']['Power DC'] && typeof val['0']['Power DC'].v === 'number') {
                            this.dcPower.set(inverter.serial, val['0']['Power DC'].v);
                        }
                        // remember the yields for the sums over all inverters
                        if (val && val['0']) {
                            this.rememberYield(inverter.serial, val['0'].YieldTotal, val['0'].YieldDay);
                        }
                        // Create and/or set values
                        for (const [invStateName, invVal] of Object.entries((val && val['0']) || {})) {
                            await this.setObjectAndState(inverter.serial, `inv_${invStateName.toLowerCase()}`, invVal);
                        }
                        break;
                    case 'radio_stats':
                        await this.ensureChannel(`${inverter.serial}.radio`, 'Radio statistics');
                        for (const [radioStateName, radioVal] of Object.entries(val || {})) {
                            await this.setObjectAndState(
                                inverter.serial,
                                `radio_${radioStateName.toLowerCase()}`,
                                radioVal,
                            );
                        }
                        break;
                    case 'events':
                        // -1: inverter does not provide an event log
                        if (typeof val === 'number' && val >= 0) {
                            await this.ensureChannel(`${inverter.serial}.events`, 'Event log');
                            await this.setObjectAndState(inverter.serial, 'events', val);
                            if (this.eventCounts.get(inverter.serial) !== val) {
                                this.eventCounts.set(inverter.serial, val);
                                if (this.onEventCount) {
                                    this.onEventCount(inverter.serial, val);
                                }
                            }
                        }
                        break;
                    default:
                        // Must states be set to zero?
                        if (stateName.toLowerCase() == 'reachable') {
                            // device info: on first sight (OpenDTU may still know it) and when coming back online
                            const wasReachable = this.reachable.get(inverter.serial);
                            this.reachable.set(inverter.serial, val === true);
                            if (val === true && wasReachable === false && this.onReachable) {
                                this.onReachable(inverter.serial);
                            }
                            if (val === true) {
                                this.inverterOffline.delete(inverter.serial);
                            } else if (this.adapter.config.useInvOfflineStatesToZero) {
                                await this.invOfflineStatesToZero(inverter.serial);
                            }
                        }
                        // Create and/or set values
                        await this.setObjectAndState(inverter.serial, stateName.toLowerCase(), val);
                }
            }
        }
    }

    async processDCData(serial, val) {
        // Create channel
        if (!this.createCache.has(`${serial}.dc`)) {
            const deviceObj = {
                type: 'channel',
                common: {
                    name: 'DC',
                },
                native: {},
            };

            await this.adapter.extendObjectAsync(`${serial}.dc`, deviceObj);
            this.createCache.add(`${serial}.dc`);
        }

        // DC Input x
        for (const [string, stringObj] of Object.entries(val)) {
            // Create channel
            const stringNumber = Number(string) + 1;
            if (!this.createCache.has(`${serial}.dc.input_${stringNumber}`)) {
                const deviceObj = {
                    type: 'channel',
                    common: {
                        name: `DC Input ${stringNumber}`,
                    },
                    native: {},
                };

                await this.adapter.extendObjectAsync(`${serial}.dc.input_${stringNumber}`, deviceObj);
                this.createCache.add(`${serial}.dc.input_${stringNumber}`);
            }

            // Create and/or set values
            for (const [channelStateName, channelVal] of Object.entries(stringObj)) {
                await this.setObjectAndState(serial, `dc_${channelStateName.toLowerCase()}`, channelVal, stringNumber);
            }
        }
    }

    async processACData(serial, val) {
        // Create channel
        if (!this.createCache.has(`${serial}.ac`)) {
            const deviceObj = {
                type: 'channel',
                common: {
                    name: 'AC',
                },
                native: {},
            };

            await this.adapter.extendObjectAsync(`${serial}.ac`, deviceObj);
            this.createCache.add(`${serial}.ac`);
        }

        const channelObj = {
            type: 'channel',
            native: {},
        };

        // AC Phase x
        for (const [phase, phaseObj] of Object.entries(val)) {
            // Create channel
            const phaseNumber = Number(phase) + 1;
            if (!this.createCache.has(`${serial}.ac.phase_${phaseNumber}`)) {
                channelObj.common = {
                    name: `Phase ${phaseNumber}`,
                };

                await this.adapter.extendObjectAsync(`${serial}.ac.phase_${phaseNumber}`, channelObj);
                this.createCache.add(`${serial}.ac.phase_${phaseNumber}`);
            }

            // Create and/or set values
            for (const [phaseStateName, phaseVal] of Object.entries(phaseObj)) {
                await this.setObjectAndState(serial, `ac_${phaseStateName.toLowerCase()}`, phaseVal, phaseNumber);
            }
        }
    }

    async createPowerControls(serial) {
        const forceStatesNameList = [
            'limit_persistent_relative',
            'limit_persistent_absolute',
            'limit_nonpersistent_relative',
            'limit_nonpersistent_absolute',
            'power_on',
            'power_off',
            'restart',
        ];
        // Create channel
        const powerControlChannelId = `${serial}.power_control`;
        if (!this.createCache.has(powerControlChannelId)) {
            const deviceObj = {
                type: 'channel',
                common: {
                    name: 'Power control',
                },
                native: {},
            };
            await this.adapter.extendObjectAsync(powerControlChannelId, deviceObj);
            this.createCache.add(powerControlChannelId);
        }

        // Create values
        for (const stateName of forceStatesNameList) {
            await this.setObjectAndState(serial, stateName.toLowerCase());
        }
    }

    async processTotalData(data) {
        // Create channel
        if (!this.createCache.has('total')) {
            const deviceObj = {
                type: 'channel',
                common: {
                    name: 'Total',
                    desc: 'Sum over all inverters',
                },
                native: {},
            };

            await this.adapter.extendObjectAsync('total', deviceObj);
            this.createCache.add('total');
        }

        // Create and/or set values
        for (const [stateName, val] of Object.entries(data)) {
            // total.yieldtotal and total.yieldday are computed below from the inverters
            if (['yieldtotal', 'yieldday'].includes(stateName.toLowerCase())) {
                continue;
            }
            await this.setObjectAndState('total', `total_${stateName.toLowerCase()}`, val);
        }
        await this.processTotalYields();
        // DC power of all inverters (OpenDTU sends no total for DC via websocket)
        if (this.dcPower.size) {
            let sum = 0;
            for (const v of this.dcPower.values()) {
                sum += v;
            }
            await this.setObjectAndState('total', 'total_power_dc', Math.round(sum * 10) / 10);
        }
    }

    /**
     * Remembers the yields of one inverter for the totals.
     *
     * @param serial serial number of the inverter
     * @param yieldTotal YieldTotal from the websocket (kWh)
     * @param yieldDay YieldDay from the websocket (Wh)
     */
    rememberYield(serial, yieldTotal, yieldDay) {
        const total = yieldTotal ? Number(yieldTotal.v) : NaN;
        // 0 = not read yet; a lower value than before is a transmission/restart artefact
        if (total > 0 && total >= (this.yieldTotals.get(serial) || 0)) {
            this.yieldTotals.set(serial, total);
        }
        const day = yieldDay ? Number(yieldDay.v) : NaN;
        if (!Number.isFinite(day) || day < 0) {
            return;
        }
        const today = new Date().toDateString();
        const last = this.yieldDays.get(serial);
        // a 0 on the same day means "not read yet" (OpenDTU restart), a 0 on a new day is the midnight reset
        if (day === 0 && last && last.day === today && last.v > 0) {
            return;
        }
        this.yieldDays.set(serial, { v: day, day: today });
    }

    /**
     * Writes total.yieldtotal and total.yieldday as the sum of the last valid values of every inverter.
     */
    async processTotalYields() {
        // @KI_HINWEIS: OpenDTU sums only the inverters it has data for. After midnight ("Zero YieldDay at
        // midnight") or an OpenDTU restart, inverters that have not answered yet count as 0, so the totals
        // drop by their share (seen: 4234 -> 2928 kWh) until all inverters answered. Counters such as
        // SourceAnalytix read that as a meter reset. The adapter therefore sums its own last valid values per
        // inverter (seeded from the existing states after an adapter start). Per inverter the yield total
        // never decreases; yields of the day only count for the local day they were received on.
        if (!this.yieldSeeded) {
            this.yieldSeeded = true;
            await this.seedYields();
        }
        if (this.yieldTotals.size) {
            let sum = 0;
            for (const v of this.yieldTotals.values()) {
                sum += v;
            }
            await this.setObjectAndState('total', 'total_yieldtotal', { v: sum, d: 3 });
        }
        if (this.yieldDays.size) {
            const today = new Date().toDateString();
            let sum = 0;
            for (const entry of this.yieldDays.values()) {
                if (entry.day === today) {
                    sum += entry.v;
                }
            }
            await this.setObjectAndState('total', 'total_yieldday', { v: sum, d: 0 });
        }
    }

    /**
     * Seeds the yields per inverter from the states of the previous run, so the first totals after an
     * adapter start are complete even if not all inverters answered yet.
     */
    async seedYields() {
        try {
            const prefix = `${this.adapter.namespace}.`;
            const today = new Date().toDateString();
            const objects = await this.adapter.getAdapterObjectsAsync();
            for (const id of Object.keys(objects)) {
                const match = id.startsWith(prefix)
                    ? /^(\d+)\.(yieldtotal|yieldday)$/.exec(id.slice(prefix.length))
                    : null;
                if (!match) {
                    continue;
                }
                const [, serial, kind] = match;
                if (kind === 'yieldtotal' ? this.yieldTotals.has(serial) : this.yieldDays.has(serial)) {
                    continue;
                }
                const state = await this.adapter.getStateAsync(id);
                if (!state || state.val === null || !Number.isFinite(Number(state.val))) {
                    continue;
                }
                if (kind === 'yieldtotal' && Number(state.val) > 0) {
                    this.yieldTotals.set(serial, Number(state.val));
                } else if (kind === 'yieldday' && new Date(state.ts).toDateString() === today) {
                    this.yieldDays.set(serial, { v: Number(state.val), day: today });
                }
            }
        } catch (err) {
            this.adapter.log.warn(`Could not read the last yields: ${err}`);
        }
    }

    async processDTUData(data) {
        // Create device
        if (!this.createCache.has('dtu')) {
            const deviceObj = {
                type: 'device',
                common: {
                    name: 'OpenDTU Device',
                    statusStates: {
                        onlineId: `${this.adapter.name}.${this.adapter.instance}.dtu.available`,
                    },
                },
                native: {},
            };

            await this.adapter.extendObjectAsync('dtu', deviceObj);
            this.createCache.add('dtu');
        }

        if (data.heap_free !== undefined) {
            await this.ensureChannel('dtu.heap', 'Memory');
        }
        // Create and/or set values
        for (const [stateName, val] of Object.entries(data)) {
            await this.setObjectAndState('dtu', `dtu_${stateName.toLowerCase()}`, val);
        }
    }

    /**
     * Called when this adapter sends a limit command - a following 0 % is then a real value.
     *
     * @param serial inverter serial
     * @param limit commanded limit (W or %)
     */
    noteLimitCommand(serial, limit) {
        if (Number(limit) === 0) {
            this.zeroLimitUntil.set(serial, Date.now() + 120000);
        }
    }

    /**
     * Checks whether a reported limit of 0 % is plausible (see processInverterData).
     *
     * @param serial inverter serial
     * @returns true if the 0 % should be written
     */
    isZeroLimitAccepted(serial) {
        if ((this.zeroLimitUntil.get(serial) || 0) > Date.now()) {
            return true;
        }
        const last = this.lastLimit.get(serial);
        return last === undefined || last === 0;
    }

    /**
     * Creates a channel object once per run.
     *
     * @param id channel ID
     * @param name channel name
     */
    async ensureChannel(id, name) {
        if (this.createCache.has(id)) {
            return;
        }
        await this.adapter.extendObjectAsync(id, { type: 'channel', common: { name }, native: {} });
        this.createCache.add(id);
    }

    /**
     * Writes the hints of OpenDTU (time sync, radio problem, default password) below dtu.hints.
     *
     * @param hints hints object of the websocket message
     */
    async processHints(hints) {
        // Websocket data may arrive before the first DTU status: create the device first
        await this.processDTUData({});
        await this.ensureChannel('dtu.hints', 'Hints');
        for (const [name, val] of Object.entries(hints || {})) {
            await this.setObjectAndState('dtu', `hints_${name.toLowerCase()}`, val === true);
        }
    }

    /**
     * Writes the result of /api/limit/status or /api/power/status.
     *
     * @param data response, one object per serial
     */
    async processCommandStatus(data) {
        for (const [serial, status] of Object.entries(data || {})) {
            if (!this.createCache.has(serial) || !status || typeof status !== 'object') {
                continue;
            }
            for (const key of ['limit_set_status', 'power_set_status', 'max_power']) {
                if (status[key] !== undefined) {
                    await this.setObjectAndState(serial, key, status[key]);
                }
            }
        }
    }

    /**
     * Writes the device info of an inverter (/api/devinfo/status).
     *
     * @param serial inverter serial
     * @param info response of OpenDTU
     */
    async processDevInfo(serial, info) {
        const map = {
            fw_bootloader_version: 'bootloaderversion',
            fw_build_version: 'fwbuildversion',
            fw_build_datetime: 'fwbuilddatetime',
            hw_part_number: 'hwpartnumber',
            hw_version: 'hwversion',
            hw_model_name: 'model',
        };
        for (const [field, stateName] of Object.entries(map)) {
            if (info[field] !== undefined && info[field] !== null) {
                await this.setObjectAndState(serial, stateName, info[field]);
            }
        }
    }

    /**
     * Writes the event log of an inverter.
     *
     * @param serial inverter serial
     * @param events entries of /api/eventlog/status
     */
    async processEventLog(serial, events) {
        const fmt = sec => {
            const s = Math.max(0, Number(sec) || 0);
            const pad = n => String(Math.trunc(n)).padStart(2, '0');
            return `${pad(s / 3600)}:${pad((s / 60) % 60)}:${pad(s % 60)}`;
        };
        const list = (Array.isArray(events) ? events : []).map(e => ({
            id: e.message_id,
            message: e.message,
            start: fmt(e.start_time),
            end: fmt(e.end_time),
        }));
        await this.ensureChannel(`${serial}.events`, 'Event log');
        await this.setObjectAndState(serial, 'events_json', JSON.stringify(list));
        const last = list[list.length - 1];
        await this.setObjectAndState(serial, 'events_last', last ? `${last.start} ${last.message}` : '');
        await this.setObjectAndState(serial, 'events_last_id', last ? Number(last.id) : 0);
    }

    async setObjectAndState(stateID, stateName, val, count) {
        const state = stateDefinition[stateName];
        if (!state) {
            return;
        }

        const fullStateID = `${stateID}.${state.id}`.replace('%count%', count);

        let options = undefined;

        if (this.adapter.config.protectNames) {
            options = {
                preserve: {
                    common: ['name'],
                },
            };
        }

        if (!this.createCache.has(fullStateID)) {
            await this.adapter.extendObjectAsync(
                fullStateID,
                {
                    type: 'state',
                    common: this.copyAndCleanStateObj(state),
                    native: {},
                },
                options,
            );

            // Subscribe to writable states
            if (state.write == true) {
                await this.adapter.subscribeStatesAsync(fullStateID);
            }

            this.createCache.add(fullStateID);
        }

        if (val !== undefined) {
            let value = val;

            if (state.getter) {
                value = state.getter(val);
            }

            // yieldtotal Protection against incorrect zeroing when the OpenDTU restarts if the inverter is not accessible.
            if (fullStateID.endsWith('yieldtotal')) {
                if (Number(value) <= 0) {
                    return;
                }
            }

            // Are the states allowed to be set or is the inverter offline?
            for (const serial of this.inverterOffline) {
                if (fullStateID.includes(serial)) {
                    if (statesToSetZero.includes(fullStateID.split('.').at(-1) || '')) {
                        return;
                    }
                }
            }

            await this.adapter.setStateChangedAsync(fullStateID, value, true);
        }
    }
    async invOfflineStatesToZero(serial) {
        if (this.inverterOffline.has(serial)) {
            return;
        }
        // Mark first, so concurrent messages do not trigger a second run
        this.inverterOffline.add(serial);

        // Get all StateIDs
        const allStateIDs = Object.keys(await this.adapter.getAdapterObjectsAsync());

        // Get all yieldday StateIDs to set zero
        const idsSetToZero = [];
        for (const id of allStateIDs.filter(x => x.includes(`.${serial}.`))) {
            if (statesToSetZero.includes(id.split('.').at(-1) || '')) {
                idsSetToZero.push(id);
            }
        }

        // Set IDs to Zero
        await Promise.all(idsSetToZero.map(id => this.adapter.setStateChangedAsync(id, 0, true)));
    }

    copyAndCleanStateObj(state) {
        const iobState = { ...state };
        const blacklistedKeys = ['id', 'setter', 'getter', 'setattr'];
        for (const blacklistedKey of blacklistedKeys) {
            delete iobState[blacklistedKey];
        }
        return iobState;
    }
}

module.exports = {
    DataController,
};
