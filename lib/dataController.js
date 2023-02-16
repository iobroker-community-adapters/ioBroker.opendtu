class DataController {
    constructor(adapter, createCache, inverterOffline) {
        this.adapter = adapter;
        this.createCache = createCache;
        this.inverterOffline = inverterOffline;
    }

    async processInverterData(inverters) {
        for (const inverter of inverters) {
            if (!this.createCache.includes(inverter.serial)) {
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
                this.createCache.push(inverter.serial);
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
                            this.adapter.setObjectAndState(inverter.serial, `inv_${invStateName.toLowerCase()}`, invVal);
                        }
                        break;
                    default:
                        // Must states be set to zero?
                        if (stateName.toLowerCase() == 'reachable') {
                            if (val == true) {
                                this.inverterOffline = this.inverterOffline.filter(x => x !== inverter.serial);
                            }
                            else {
                                this.adapter.invOfflineStatesToZero(inverter.serial);
                            }
                        }
                        // Create and/or set values
                        this.adapter.setObjectAndState(inverter.serial, stateName.toLowerCase(), val);
                }
            }
        }
    }

    async processDCData(serial, val) {
        // Create channel
        if (!this.createCache.includes(`${serial}.dc`)) {
            const deviceObj = {
                type: 'channel',
                common: {
                    name: 'DC',
                },
                native: {}
            };
            // @ts-ignore
            await this.adapter.extendObjectAsync(`${serial}.dc`, deviceObj);
            this.createCache.push(`${serial}.dc`);
        }

        // DC Input x
        for (const [string, stringObj] of Object.entries(val)) {
            // Create channel
            const stringNumber = Number(string) + 1;
            if (!this.createCache.includes(`${serial}.dc.input_${stringNumber}`)) {
                const deviceObj = {
                    type: 'channel',
                    common: {
                        name: `DC Input ${stringNumber}`,
                    },
                    native: {}
                };
                // @ts-ignore
                await this.adapter.extendObjectAsync(`${serial}.dc.input_${stringNumber}`, deviceObj);
                this.createCache.push(`${serial}.dc.input_${stringNumber}`);
            }

            // Create and/or set values
            for (const [channelStateName, channelVal] of Object.entries(stringObj)) {
                this.adapter.setObjectAndState(serial, `dc_${channelStateName.toLowerCase()}`, channelVal, stringNumber);
            }
        }
    }

    async processACData(serial, val) {
        // Create channel
        if (!this.createCache.includes(`${serial}.ac`)) {
            const deviceObj = {
                type: 'channel',
                common: {
                    name: 'AC',
                },
                native: {}
            };
            // @ts-ignore
            await this.adapter.extendObjectAsync(`${serial}.ac`, deviceObj);
            this.createCache.push(`${serial}.ac`);
        }

        // AC Phase x
        for (const [phase, phaseObj] of Object.entries(val)) {
            // Create channel
            const phaseNumber = Number(phase) + 1;
            if (!this.createCache.includes(`${serial}.ac.phase_${phaseNumber}`)) {
                const deviceObj = {
                    type: 'channel',
                    common: {
                        name: `Phase ${phase + 1}`,
                    },
                    native: {}
                };
                // @ts-ignore
                await this.adapter.extendObjectAsync(`${serial}.ac.phase_${phaseNumber}`, deviceObj);
                this.createCache.push(`${serial}.ac.phase_${phaseNumber}`);
            }

            // Create and/or set values
            for (const [phaseStateName, phaseVal] of Object.entries(phaseObj)) {
                this.adapter.setObjectAndState(serial, `ac_${phaseStateName.toLowerCase()}`, phaseVal, phaseNumber);
            }
        }
    }

    async createPowerControls(serial) {
        const forceStatesNameList = ['limit_persistent_relative', 'limit_persistent_absolute', 'limit_nonpersistent_relative', 'limit_nonpersistent_absolute', 'power_on', 'power_off', 'restart'];
        // Create channel
        if (!this.createCache.includes(`${serial}.power_control`)) {
            const deviceObj = {
                type: 'channel',
                common: {
                    name: 'Power control',
                },
                native: {}
            };
            // @ts-ignore
            await this.adapter.extendObjectAsync(`${serial}.power_control`, deviceObj);
            this.createCache.push(`${serial}.power_control`);
        }

        // Create values
        for (const stateName of forceStatesNameList) {
            this.adapter.setObjectAndState(serial, stateName.toLowerCase());
        }
    }

    async processTotalData(data) {
        // Create channel
        if (!this.createCache.includes('total')) {
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
            this.createCache.push('total');
        }

        // Create and/or set values
        for (const [stateName, val] of Object.entries(data)) {
            this.adapter.setObjectAndState('total', `total_${stateName.toLowerCase()}`, val);
        }
    }

    async processDTUData(data) {
        // Create device
        if (!this.createCache.includes('dtu')) {
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
            this.createCache.push('dtu');
        }

        // Create and/or set values
        for (const [stateName, val] of Object.entries(data)) {
            this.adapter.setObjectAndState('dtu', `dtu_${stateName.toLowerCase()}`, val);
        }
    }
}

module.exports = {
    DataController
};