'use strict';
const utils = require('@iobroker/adapter-core');
// @ts-ignore
const schedule = require('node-schedule');
// @ts-ignore
const stateDefinition = require('./lib/stateDefinition').stateDefinition;
const WebsocketController = require('./lib/websocketController').WebsocketController;

let websocketController;
const createCache = [];

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

        this.startWebsocket();

        schedule.scheduleJob('dayEndJob', '0 0 0 * * *', () => this.dayEndJob(this));
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

    async dayEndJob(adapter) {
        const listYieldDay = createCache.filter(x => x.states.map(y => y.prob).includes('yieldday'));
        for (const yild of listYieldDay) {
            adapter.setStateAsync(`${yild.id}.yieldday`, 0, true);
        }

        const listYieldTotal = createCache.filter(x => x.states.map(y => y.prob).includes('yieldtotal'));
        for (const yild of listYieldTotal) {
            const stateVal = (await adapter.getStateAsync(`${yild.id}.yieldtotal`)).val;
            adapter.setStateAsync(`${yild.id}.yieldtotal`, stateVal, true);
        }
    }

    setStateToZero(rootDeviceID) {
        const statesToSetZero = ['current', 'irradiation', 'power', 'voltage', 'frequency', 'powerdc', 'reactivepower', 'temperature'];
        const deviceList = createCache.filter(x => x.id.startsWith(rootDeviceID) && x.states.map(y => y.id).some(z => statesToSetZero.includes(z)));
        for (const device of deviceList) {
            const states = device.states.filter(x => statesToSetZero.includes(x.id));
            for (const state of states) {
                const fullStateID = `${device.id}.${state.id}`;
                console.log(fullStateID);
                this.setStateChangedAsync(fullStateID, 0, true);
            }
        }
    }

    // @ts-ignore
    async messageParse(message) {
        message = JSON.parse(message);

        // Create inverter rootfolder
        if (!message.inverters) {
            return;
        }
        for (const inv of message.inverters) {
            if (!createCache.includes(inv.serial)) {
                const deviceObj = {
                    type: 'device',
                    common: {
                        name: inv.name,
                        desc: 'Inverter',
                        statusStates: {
                            onlineId: `${this.name}.${this.instance}.${inv.serial}.available`
                        }
                    },
                    native: {}
                };
                // @ts-ignore
                await this.extendObjectAsync(inv.serial, deviceObj);
                createCache.push(inv.serial);
            }

            const forceStatesNameList = ['limit_persistent_relative', 'limit_persistent_absolute', 'limit_nonpersistent_relative', 'limit_nonpersistent_absolute', 'power_switch', 'restart'];

            for (const stateName of forceStatesNameList) {
                this.setObjectAndState(inv.serial, stateName.toLowerCase());
            }

            for (const [stateName, val] of Object.entries(inv)) {
                if (typeof (val) === 'object') {
                    continue;
                }
                this.setObjectAndState(inv.serial, stateName.toLowerCase(), val);
            }
        }

        // const fullStateID = `${device.id}.${state.id}`;

        // if (state.getter) {
        //     const val = state.getter(payload);
        //     await this.setStateChangedAsync(fullStateID, val, true);

        //     // if (state.id == 'available' && val == false) {
        //     //     const rootDeviceID = device.id.split('.')[0];
        //     //     this.setStateToZero(rootDeviceID);
        //     // }

        // } else {
        //     await this.setStateChangedAsync(fullStateID, payload, true);
        // }
    }

    async setObjectAndState(stateID, stateName, val) {

        const state = stateDefinition[stateName];
        if (!state) {
            return;
        }

        const fullStateID = `${stateID}.${state.id}`;

        if (!createCache.includes(fullStateID)) {
            await this.extendObjectAsync(fullStateID,
                {
                    type: 'state',
                    common: this.copyAndCleanStateObj(state),
                    native: {},
                });
            createCache.push(fullStateID);
        }

        if (val !== undefined) {
            if (state.getter) {
                await this.setStateChangedAsync(fullStateID, state.getter(val), true);
            }
            else {
                await this.setStateChangedAsync(fullStateID, val, true);
            }
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

    async onStateChange(id, state) {
        if (state && state.ack == false) {
            const serial = id.split('.')[2];
            const stateID = id.split('.')[4];

            const device = createCache.find(x => x.id == `${serial}.power_control`);

            if (!device) {
                return;
            }

            const deviceState = device.states.find(x => x.id == stateID);

            if (!deviceState) {
                return;
            }

            if (deviceState.setter) {
                // @ts-ignore
                mqttClient.publish(`${this.config.mqttTopic}/${serial}/cmd/${deviceState.prob}`, deviceState.setter(state.val));
            } else {
                // @ts-ignore
                mqttClient.publish(`${this.config.mqttTopic}/${serial}/cmd/${deviceState.prob}`, state.val);
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
        callback();
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