'use strict';
const utils = require('@iobroker/adapter-core');
const { default: axios } = require('axios');
// @ts-ignore
const schedule = require('node-schedule');
// @ts-ignore
const stateDefinition = require('./lib/stateDefinition').stateDefinition;
const WebsocketController = require('./lib/websocketController').WebsocketController;
const DataController = require('./lib/dataController').DataController;

let dtuApiURL;
let dtuNetworkApiURL;
let powerApiURL;
let axiosConf;
let websocketController;
let dataController;
const inverterOffline = [];
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
        if (this.config.webUIServer == '') {
            this.log.warn('Please configure the Websoket connection!');
            return;
        }

        dtuApiURL = `${this.config.webUIScheme}://${this.config.webUIServer}:${this.config.webUIPort}/api/system/status`;
        dtuNetworkApiURL = `${this.config.webUIScheme}://${this.config.webUIServer}:${this.config.webUIPort}/api/network/status`;
        powerApiURL = `${this.config.webUIScheme}://${this.config.webUIServer}:${this.config.webUIPort}/api/limit/config`;
        axiosConf = { auth: { username: this.config.userName, password: this.config.password } };

        dataController = new DataController(this, createCache, inverterOffline);

        this.startWebsocket();
        this.getDTUData();

        schedule.scheduleJob('dayEndJob', '0 0 0 * * *', () => this.dayEndJob());
        schedule.scheduleJob('rewriteYildTotal', '0 1 0 * * *', () => this.rewriteYildTotal());
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
        try {
            this.allAvailableToFalse();
        } catch (e) {
            this.log.error(e);
        }
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
            schedule.cancelJob('rewriteYildTotal');
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
        });

        wsClient.on('message', (message) => {
            this.messageParse(message);
        });

        wsClient.on('close', async () => {
            this.allAvailableToFalse();
        });
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
            dataController.processInverterData(message.inverters);
        }

        // Total
        if (message.total) {
            dataController.processTotalData(message.total);
        }

        // DTU
        if (message.dtu) {
            dataController.processDTUData(message.dtu);
        }
    }

    async getDTUData() {
        try {
            const res = await axios.all([axios.get(dtuNetworkApiURL), axios.get(dtuApiURL)]);

            const dtuData = res[0].data;
            dtuData.uptime = res[1].data.uptime;
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

    async dayEndJob() {
        // Get all StateIDs
        const allStateIDs = Object.keys(await this.getAdapterObjectsAsync());

        // Get all yieldday StateIDs to set zero
        const idsSetToZero = allStateIDs.filter(x => x.endsWith('yieldday'));
        for (const id of idsSetToZero) {
            this.setStateAsync(id, 0, true);
        }
    }

    async rewriteYildTotal() {
        // Get all StateIDs
        const allStateIDs = Object.keys(await this.getAdapterObjectsAsync());

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

    async allAvailableToFalse() {
        // Get all available StateIDs
        const allAvailableStates = Object.keys(await this.getAdapterObjectsAsync()).filter(x => x.endsWith('.available'));

        // Set all available StateIDs to false
        for (const id of allAvailableStates) {
            this.setStateChangedAsync(id, false, true);
        }
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
