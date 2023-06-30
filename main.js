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
let limitApiURL;
let powerApiURL;
let websocketController;
let dataController;
const inverterOffline = [];
const createCache = [];
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

        // Check if webUIServer is configured, log warning message and return if not
        if (!this.config.webUIServer) {
            this.log.warn('Please configure the Websoket connection!');
            return;
        }

        // Construct the base URL for API calls using configuration variables
        const baseURL = `${this.config.webUIScheme}://${this.config.webUIServer}:${this.config.webUIPort}/api`;

        // Construct URLs for various API endpoints using the base URL
        dtuApiURL = `${baseURL}/system/status`;
        dtuNetworkApiURL = `${baseURL}/network/status`;
        limitApiURL = `${baseURL}/limit/config`;
        powerApiURL = `${baseURL}/power/config`;

        // Set default authentication credentials for Axios requests
        axios.defaults.auth = { username: this.config.userName, password: this.config.password };

        // Instantiate a new DataController object with necessary arguments
        dataController = new DataController(this, createCache, inverterOffline);

        // Start the websocket connection and initiate data retrieval from DTU
        this.startWebsocket();
        this.getDTUData();

        // Schedule jobs to run at specified intervals using Cron-style syntax
        schedule.scheduleJob('dayEndJob', '50 59 23 * * *', () => this.dayEndJob());
        schedule.scheduleJob('rewriteYildTotal', '0 1 0 * * *', () => this.rewriteYildTotal());
        schedule.scheduleJob('getDTUData', '*/10 * * * * *', () => this.getDTUData());
    }

    // This function gets called whenever there's a state change in the system.
    async onStateChange(id, state) {
        // Check that the new state is not an acknowledgement of a previous command.
        if (state && state.ack == false) {
            // Split the ID into parts to get the serial number and state identifier.
            const idParts = id.split('.');
            const serial = idParts[2];
            const stateID = idParts[4];

            // Use a switch statement to handle different types of state changes.
            switch (stateID) {
                case 'limit_persistent_relative':
                    // Set the inverter limit based on the new value and a fixed parameter.
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
                    // Switch the inverter power status based on the new value.
                    if (state.val == true) {
                        this.setInverterPower(serial, true);
                    }
                    break;
                case 'power_off':
                    // Switch the inverter power status based on the new value.
                    if (state.val == true) {
                        this.setInverterPower(serial, false);
                    }
                    break;
                case 'restart':
                    // Restart the inverter based on the new value.
                    if (state.val == true) {
                        this.setInverterRestart(serial, true);
                    }
                    break;
                default:
                    // If the state change isn't recognized, do nothing.
                    return;
            }

            // Update the state with the new values and acknowledge the change.
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
            if (websocketController) {
                websocketController.closeConnection();
            }
        } catch (e) {
            this.log.error(e);
        }
        // Clear all websocket timers
        try {
            if (websocketController) {
                await websocketController.allTimerClear();
            }
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
            this.processMessage(message);
        });

        wsClient.on('close', async () => {
            this.allAvailableToFalse();
        });
    }

    // @ts-ignore
    async processMessage(message, isObject) {
        try {
            if (!isObject) {
                message = JSON.parse(message);
            }
        }
        catch (err) {
            this.log.error(err);
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

            this.processMessage({ dtu: dtuData }, true);
        } catch (err) {
            this.log.debug(`getDTUData axios error: ${err}`);
            this.processMessage({ dtu: { reachable: false } }, true);
        }
    }

    async setInverterLimit(serial, limit_value, limit_type) {
        try {
            const payload = `data=${JSON.stringify({ serial, limit_type, limit_value })}`;
            await axios.post(limitApiURL, payload);
        } catch (err) {
            this.log.warn(`setInverterLimit axios error: ${err}`);
        }
    }

    async setInverterPower(serial, power) {
        try {
            const payload = `data=${JSON.stringify({ serial, power })}`;
            await axios.post(powerApiURL, payload);
        } catch (err) {
            this.log.warn(`setInverterPower axios error: ${err}`);
        }
    }

    async setInverterRestart(serial, restart) {
        try {
            const payload = `data=${JSON.stringify({ serial, restart })}`;
            await axios.post(powerApiURL, payload);
        } catch (err) {
            this.log.warn(`setInverterRestart axios error: ${err}`);
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
                if (Number(value) <= 0) {
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
