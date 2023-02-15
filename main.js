'use strict';
const utils = require('@iobroker/adapter-core');
const { default: axios } = require('axios');
// @ts-ignore
const schedule = require('node-schedule');
// @ts-ignore
const stateDefinition = require('./lib/stateDefinition').stateDefinition;
const WebsocketController = require('./lib/websocketController').WebsocketController;

let dtuApiURL;
let powerApiURL;
let axiosConf;
let websocketController;
let inverterOffline = [];
const createCache = [];
const yieldGuardCache = {};
const statesToSetZero = ['current', 'irradiation', 'power', 'voltage', 'frequency', 'power_dc', 'reactivepower', 'temperature'];

class Opendtu extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'opendtu',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        this.setState('info.connection', false, true);

        if (this.config.webUIServer == '') {
            this.log.warn('Please configure the Websoket connection!');
            return;
        }

        dtuApiURL = `${this.config.webUIScheme}://${this.config.webUIServer}:${this.config.webUIPort}/api/system/status`;
        powerApiURL = `${this.config.webUIScheme}://${this.config.webUIServer}:${this.config.webUIPort}/api/limit/config`;
        axiosConf = { auth: { username: this.config.userName, password: this.config.password } };

        this.startWebsocket();
        this.getDTUData();
        schedule.scheduleJob('dayEndJob', '0 0 0 * * *', () => this.dayEndJob());
        schedule.scheduleJob('getDTUData', '*/10 * * * * *', () => this.getDTUData());
    }

    async onStateChange(id, state) {
        if (state && state.ack == false) {
            console.log(id);
            const serial = id.split('.')[2];
            const stateID = id.split('.')[4];

            switch (stateID) {
                case 'limit_persistent_relative':
                    this.setInverterLimit(serial, state.val, 257);
                    break;
                case 'limit_persistent_absolute':
                    this.setInverterLimit(serial, state.val, 256);
                    break;
                case 'limit_nonpersistent_relative':
                    this.setInverterLimit(serial, state.val, 1);
                    break;
                case 'limit_nonpersistent_absolute':
                    this.setInverterLimit(serial, state.val, 0);
                    break;
                case 'power_on':
                    this.setInverterPower(serial, state.val);
                    break;
                case 'power_off':
                    this.setInverterPower(serial, state.val);
                    break;
                case 'restart':
                    this.setInverterRestart(serial, state.val);
                    break;
                default:
                    return;
            }

            this.setStateAsync(id, state, true);
        }
    }

    async onUnload(callback) {
        // Websocket
        try {
            websocketController.closeConnection();
        } catch (e) {
            this.log.error(e);
        }
        // Clear all websocket timers
        try {
            await websocketController.allTimerClear();
        } catch (e) {
            this.log.error(e);
        }

        try {
            schedule.cancelJob('dayEndJob');
        } catch (e) {
            this.log.error(e);
        }

        try {
            schedule.cancelJob('getDTUData');
        } catch (e) {
            this.log.error(e);
        }
        callback();
    }


    startWebsocket() {
        websocketController = new WebsocketController(this);
        const wsClient = websocketController.initWsClient();

        wsClient.on('open', () => {
            this.log.info('Connect to OpenDTU over websocket connection.');
            this.setStateChanged('info.connection', true, true);
        });

        wsClient.on('message', (message) => {
            this.messageParse(message);

        });

        wsClient.on('close', async () => {
            this.setStateChanged('info.connection', false, true);
            //await statesController.setAllAvailableToFalse();
        });
    }

    async dayEndJob() {
        // Get all StateIDs
        const allStateIDs = Object.keys(await this.getAdapterObjectsAsync());

        // Get all yieldday StateIDs to set zero
        const idsSetToZero = allStateIDs.filter(x => x.endsWith('yieldday'));
        for (const id of idsSetToZero) {
            this.setStateAsync(id, 0, true);
        }

        // Get all yieldtotal StateIDs to reset for eg. sourceanalytix
        const idsSetToReset = allStateIDs.filter(x => x.endsWith('yieldtotal'));
        for (const id of idsSetToReset) {
            const currentState = await this.getStateAsync(id);
            if (currentState) {
                this.setStateAsync(id, currentState.val, true);
            }
        }
    }

    async invOfflineStatesToZero(serial) {

        if (inverterOffline.includes(serial)) {
            return;
        }

        // Get all StateIDs
        const allStateIDs = Object.keys(await this.getAdapterObjectsAsync());

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
            this.setStateChangedAsync(id, 0, true);
        }

        inverterOffline.push(serial);
    }

    // @ts-ignore
    async messageParse(message) {
        try {
            message = JSON.parse(message);
        }
        catch (err) {
            // no action..
        }

        // Create inverter rootfolder
        if (message.inverters) {
            this.processInverterData(message.inverters);
        }

        // Total
        if (message.total) {
            this.processTotalData(message.total);
        }

        // DTU
        if (message.dtu) {
            this.processDTUData(message.dtu);
        }
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
                            onlineId: `${this.name}.${this.instance}.${inverter.serial}.available`
                        }
                    },
                    native: {}
                };
                // @ts-ignore
                await this.extendObjectAsync(inverter.serial, deviceObj);
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
                                inverterOffline = inverterOffline.filter(x => x !== inverter.serial);
                            }
                            else {
                                this.invOfflineStatesToZero(inverter.serial);
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
            await this.extendObjectAsync(`${serial}.dc`, deviceObj);
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
                await this.extendObjectAsync(`${serial}.dc.input_${stringNumber}`, deviceObj);
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
            await this.extendObjectAsync(`${serial}.ac`, deviceObj);
            createCache.push(`${serial}.ac`);
        }

        // AC Phase x
        for (const [phase, phaseObj] of Object.entries(val)) {
            // Create channel
            const phaseNumber = Number(phase) + 1;
            if (!createCache.includes(`${serial}.ac.phase_${phaseNumber}`)) {
                const deviceObj = {
                    type: 'channel',
                    common: {
                        name: `Phase ${phase + 1}`,
                    },
                    native: {}
                };
                // @ts-ignore
                await this.extendObjectAsync(`${serial}.ac.phase_${phaseNumber}`, deviceObj);
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
        if (!createCache.includes(`${serial}.power_control`)) {
            const deviceObj = {
                type: 'channel',
                common: {
                    name: 'Power control',
                },
                native: {}
            };
            // @ts-ignore
            await this.extendObjectAsync(`${serial}.power_control`, deviceObj);
            createCache.push(`${serial}.power_control`);
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
            await this.extendObjectAsync('total', deviceObj);
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
                        onlineId: `${this.name}.${this.instance}.dtu.available`
                    }
                },
                native: {}
            };
            // @ts-ignore
            await this.extendObjectAsync('dtu', deviceObj);
            createCache.push('dtu');
        }

        // Create and/or set values
        for (const [stateName, val] of Object.entries(data)) {
            this.setObjectAndState('dtu', `dtu_${stateName.toLowerCase()}`, val);
        }
    }

    async getDTUData() {
        try {
            const dtuData = (await axios.get(dtuApiURL)).data;
            dtuData.reachable = true;
            this.messageParse({ dtu: dtuData });

        } catch (err) {
            this.messageParse({ dtu: { reachable: false } });
        }
    }

    async setInverterLimit(serial, limit_value, limit_type) {
        try {
            const payload = `data=${JSON.stringify({ serial, limit_type, limit_value })}`;
            await axios.post(powerApiURL, payload, axiosConf);
        } catch (err) {
            this.log.warn(err);
        }
    }

    async setInverterPower(serial, power) {
        try {
            const payload = `data=${JSON.stringify({ serial, power })}`;
            await axios.post(powerApiURL, payload, axiosConf);
        } catch (err) {
            this.log.warn(err);
        }
    }

    async setInverterRestart(serial, restart) {
        try {
            const payload = `data=${JSON.stringify({ serial, restart })}`;
            await axios.post(powerApiURL, payload, axiosConf);
        } catch (err) {
            this.log.warn(err);
        }
    }

    async setObjectAndState(stateID, stateName, val, count) {

        const state = stateDefinition[stateName];
        if (!state) {
            return;
        }

        const fullStateID = `${stateID}.${state.id}`.replace('%count%', count);

        if (!createCache.includes(fullStateID)) {
            await this.extendObjectAsync(fullStateID,
                {
                    type: 'state',
                    common: this.copyAndCleanStateObj(state),
                    native: {},
                });

            // Subscribe to writable states
            if (state.write == true) {
                await this.subscribeStatesAsync(fullStateID);
            }

            createCache.push(fullStateID);
        }

        if (val !== undefined) {
            let value = val;

            if (state.getter) {
                value = state.getter(val);
            }

            if (fullStateID.includes('yield')) {
                if (await this.yieldGuard(fullStateID, value) == false) {
                    return;
                }
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

            await this.setStateChangedAsync(fullStateID, value, true);
        }
    }

    async yieldGuard(id, val) {
        if (yieldGuardCache[id] == undefined) {
            yieldGuardCache[id] = (await this.getStateAsync(id))?.val;
        }

        if (val > yieldGuardCache[id]) {
            yieldGuardCache[id] = val;
            return true;
        }

        return false;
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

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Opendtu(options);
} else {
    // otherwise start the instance directly
    new Opendtu();
}
