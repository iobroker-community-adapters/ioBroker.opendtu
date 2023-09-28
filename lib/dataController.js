const stateDefinition = require('./stateDefinition').stateDefinition;
const inverterOffline = [];
const createCache = [];
const statesToSetZero = ['current', 'irradiation', 'power', 'voltage', 'frequency', 'power_dc', 'reactivepower', 'temperature'];

class DataController {
    constructor(adapter) {
        this.adapter = adapter;
    }

    async processInverterData(inverters) {
        for (const inverter of inverters) {
            if (!createCache.includes(inverter.serial)) {
                const deviceObj = {
                    type: 'device',
                    common: {
                        name: inverter.name,
                        desc: 'Inverter',
                        statusStates: {
                            onlineId: `${this.adapter.name}.${this.adapter.instance}.${inverter.serial}.available`
                        }
                    },
                    native: {}
                };
                // @ts-ignore
                await this.adapter.extendObjectAsync(inverter.serial, deviceObj);
                createCache.push(inverter.serial);
            }

            // Power control
            await this.createPowerControls(inverter.serial);

            // States
            for (const [stateName, val] of Object.entries(inverter)) {
                switch (stateName) {
                    case 'AC':
                        await this.processACData(inverter.serial, val);
                        break;
                    case 'DC':
                        await this.processDCData(inverter.serial, val);
                        break;
                    case 'INV':
                        // Create and/or set values
                        for (const [invStateName, invVal] of Object.entries(val['0'])) {
                            this.setObjectAndState(inverter.serial, `inv_${invStateName.toLowerCase()}`, invVal);
                        }
                        break;
                    default:
                        // Must states be set to zero?
                        if (stateName.toLowerCase() == 'reachable') {
                            if (val == true) {
                                const serialIdx = inverterOffline.indexOf(inverter.serial);
                                inverterOffline.splice(serialIdx, 1);
                            }
                            else {
                                if (this.adapter.config.useInvOfflineStatesToZero == true) {
                                    this.invOfflineStatesToZero(inverter.serial);
                                }
                            }
                        }
                        // Create and/or set values
                        this.setObjectAndState(inverter.serial, stateName.toLowerCase(), val);
                }
            }
        }
    }

    async processDCData(serial, val) {
        // Create channel
        if (!createCache.includes(`${serial}.dc`)) {
            const deviceObj = {
                type: 'channel',
                common: {
                    name: 'DC',
                },
                native: {}
            };
            // @ts-ignore
            await this.adapter.extendObjectAsync(`${serial}.dc`, deviceObj);
            createCache.push(`${serial}.dc`);
        }

        // DC Input x
        for (const [string, stringObj] of Object.entries(val)) {
            // Create channel
            const stringNumber = Number(string) + 1;
            if (!createCache.includes(`${serial}.dc.input_${stringNumber}`)) {
                const deviceObj = {
                    type: 'channel',
                    common: {
                        name: `DC Input ${stringNumber}`,
                    },
                    native: {}
                };
                // @ts-ignore
                await this.adapter.extendObjectAsync(`${serial}.dc.input_${stringNumber}`, deviceObj);
                createCache.push(`${serial}.dc.input_${stringNumber}`);
            }

            // Create and/or set values
            for (const [channelStateName, channelVal] of Object.entries(stringObj)) {
                this.setObjectAndState(serial, `dc_${channelStateName.toLowerCase()}`, channelVal, stringNumber);
            }
        }
    }

    async processACData(serial, val) {
        // Create channel
        if (!createCache.includes(`${serial}.ac`)) {
            const deviceObj = {
                type: 'channel',
                common: {
                    name: 'AC',
                },
                native: {}
            };
            // @ts-ignore
            await this.adapter.extendObjectAsync(`${serial}.ac`, deviceObj);
            createCache.push(`${serial}.ac`);
        }

        const channelObj = {
            type: 'channel',
            native: {}
        };

        // AC Phase x
        for (const [phase, phaseObj] of Object.entries(val)) {
            // Create channel
            const phaseNumber = Number(phase) + 1;
            if (!createCache.includes(`${serial}.ac.phase_${phaseNumber}`)) {
                channelObj.common = {
                    name: `Phase ${phaseNumber}`,
                };
                // @ts-ignore
                await this.adapter.extendObjectAsync(`${serial}.ac.phase_${phaseNumber}`, channelObj);
                createCache.push(`${serial}.ac.phase_${phaseNumber}`);
            }

            // Create and/or set values
            for (const [phaseStateName, phaseVal] of Object.entries(phaseObj)) {
                this.setObjectAndState(serial, `ac_${phaseStateName.toLowerCase()}`, phaseVal, phaseNumber);
            }
        }
    }

    async createPowerControls(serial) {
        const forceStatesNameList = ['limit_persistent_relative', 'limit_persistent_absolute', 'limit_nonpersistent_relative', 'limit_nonpersistent_absolute', 'power_on', 'power_off', 'restart'];
        // Create channel
        const powerControlChannelId = `${serial}.power_control`;
        if (!createCache.includes(powerControlChannelId)) {
            const deviceObj = {
                type: 'channel',
                common: {
                    name: 'Power control',
                },
                native: {}
            };
            await this.adapter.extendObjectAsync(powerControlChannelId, deviceObj);
            createCache.push(powerControlChannelId);
        }

        // Create values
        for (const stateName of forceStatesNameList) {
            this.setObjectAndState(serial, stateName.toLowerCase());
        }
    }

    async processTotalData(data) {
        // Create channel
        if (!createCache.includes('total')) {
            const deviceObj = {
                type: 'channel',
                common: {
                    name: 'Total',
                    desc: 'Sum over all inverters',
                },
                native: {}
            };
            // @ts-ignore
            await this.adapter.extendObjectAsync('total', deviceObj);
            createCache.push('total');
        }

        // Create and/or set values
        for (const [stateName, val] of Object.entries(data)) {
            this.setObjectAndState('total', `total_${stateName.toLowerCase()}`, val);
        }
    }

    async processDTUData(data) {
        // Create device
        if (!createCache.includes('dtu')) {
            const deviceObj = {
                type: 'device',
                common: {
                    name: 'OpenDTU Device',
                    statusStates: {
                        onlineId: `${this.adapter.name}.${this.adapter.instance}.dtu.available`
                    }
                },
                native: {}
            };
            // @ts-ignore
            await this.adapter.extendObjectAsync('dtu', deviceObj);
            createCache.push('dtu');
        }

        // Create and/or set values
        for (const [stateName, val] of Object.entries(data)) {
            this.setObjectAndState('dtu', `dtu_${stateName.toLowerCase()}`, val);
        }
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
                    common: ['name']
                }
            };
        }

        if (!createCache.includes(fullStateID)) {
            await this.adapter.extendObjectAsync(fullStateID,
                {
                    type: 'state',
                    common: this.copyAndCleanStateObj(state),
                    native: {},
                }, options);

            // Subscribe to writable states
            if (state.write == true) {
                await this.adapter.subscribeStatesAsync(fullStateID);
            }

            createCache.push(fullStateID);
        }

        if (val !== undefined) {
            let value = val;

            if (state.getter) {
                value = state.getter(val);
            }

            // Are the states allowed to be set or is the inverter offline?
            for (const serial of inverterOffline) {
                if (fullStateID.includes(serial)) {
                    // @ts-ignore
                    if (statesToSetZero.includes(fullStateID.split('.').at(-1))) {
                        return;
                    }
                }
            }

            await this.adapter.setStateChangedAsync(fullStateID, value, true);
        }
    }
    async invOfflineStatesToZero(serial) {

        if (inverterOffline.includes(serial)) {
            return;
        }

        // Get all StateIDs
        const allStateIDs = Object.keys(await this.adapter.getAdapterObjectsAsync());

        // Get all yieldday StateIDs to set zero
        const idsSetToZero = [];
        for (const id of allStateIDs.filter(x => x.includes(serial))) {
            // @ts-ignore
            if (statesToSetZero.includes(id.split('.').at(-1))) {
                idsSetToZero.push(id);
            }
        }

        // Set IDs to Zero
        for (const id of idsSetToZero) {
            this.adapter.setStateChangedAsync(id, 0, true);
        }

        inverterOffline.push(serial);
    }

    copyAndCleanStateObj(state) {
        const iobState = { ...state };
        const blacklistedKeys = [
            'id',
            'setter',
            'getter',
            'setattr'
        ];
        for (const blacklistedKey of blacklistedKeys) {
            delete iobState[blacklistedKey];
        }
        return iobState;
    }
}

module.exports = {
    DataController
};