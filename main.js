'use strict';
const utils = require('@iobroker/adapter-core');
const mqtt = require('mqtt');
const schedule = require('node-schedule');
const stateDefinition = require('./lib/stateDefinition').stateDefinition;

let mqttClient;
const deviceCache = [];

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

        // External MQTT-Server
        if (this.config.externalMqttServerIP == '') {
            this.log.warn('Please configure the External MQTT-Server connection!');
            return;
        }
        mqttClient = mqtt.connect(`mqtt://${this.config.externalMqttServerIP}:${this.config.externalMqttServerPort}`, { clientId: `ioBroker.opendtu${Math.random().toString(16).slice(2, 8)}`, clean: true, reconnectPeriod: 500 });

        // MQTT Client
        mqttClient.on('connect', () => {
            this.log.info(`Connect to OpenDTU over external mqtt connection.`);
            this.setState('info.connection', true, true);
        });

        mqttClient.subscribe(`${this.config.mqttTopic}/#`);

        mqttClient.on('message', (topic, payload) => {
            this.messageParse(topic, payload);
        });

        schedule.scheduleJob('dayEndJob', '0 0 0 * * *', () => this.dayEndJob(this));
    }

    async dayEndJob(adapter) {
        const listYieldDay = deviceCache.filter(x => x.states.map(y => y.prob).includes('yieldday'));
        for (const yild of listYieldDay) {
            adapter.setStateAsync(`${yild.id}.yieldday`, 0, true);
        }

        const listYieldTotal = deviceCache.filter(x => x.states.map(y => y.prob).includes('yieldtotal'));
        for (const yild of listYieldTotal) {
            const stateVal = (await adapter.getStateAsync(`${yild.id}.yieldtotal`)).val;
            adapter.setStateAsync(`${yild.id}.yieldtotal`, stateVal, true);
        }
    }

    setStateToZero(rootDeviceID) {
        const statesToSetZero = ['current', 'irradiation', 'power', 'voltage', 'frequency', 'powerdc', 'reactivepower', 'temperature'];
        const deviceList = deviceCache.filter(x => x.id.startsWith(rootDeviceID) && x.states.map(y => y.id).some(z => statesToSetZero.includes(z)));
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
    async messageParse(topic, payload) {
        const topicSplit = topic.split('/');
        let deviceID = topicSplit[1];
        const subChannel = topicSplit[2];
        let stateID;
        let stateType;

        switch (deviceID) {
            case 'dtu':
                stateType = 'dtu';
                stateID = topicSplit[2];
                break;
            default:
                // eslint-disable-next-line no-case-declarations
                const subChannel = topicSplit[2];
                switch (subChannel) {
                    case '0':
                        stateType = 'inverter';
                        deviceID = `${deviceID}`;
                        stateID = topicSplit[3];
                        break;
                    case '1':
                    case '2':
                    case '3':
                    case '4':
                        stateType = 'dc_channel';
                        deviceID = `${deviceID}.dc_channel_${subChannel}`;
                        stateID = topicSplit[3];
                        break;
                    case 'device':
                    case 'status':
                        stateID = topicSplit[3];
                        if (['limit_relative', 'limit_absolute'].includes(stateID)) {
                            stateType = 'inverter_limit';
                            deviceID = `${deviceID}.power_control`;
                        }
                        else {
                            stateType = 'info';
                            deviceID = `${deviceID}.info`;
                        }

                        break;
                    default:
                        // Weil der Name ein Objekt höher über mqtt kommt
                        stateType = 'info';
                        deviceID = `${deviceID}.info`;
                        stateID = topicSplit[2];
                        break;
                }
        }

        payload = payload.toString();

        // Muss das Device erstellt werden?
        if (!deviceCache.find(x => x.id == deviceID)) {

            const newDevice = {
                id: deviceID,
                states: stateDefinition.find(x => x.type == stateType)?.states
            };

            const deviceObj = {
                type: 'channel',
                common: {
                    name: stateDefinition.find(x => x.type == stateType)?.name.replace('%INPUTNUMBER%', subChannel),
                    desc: stateDefinition.find(x => x.type == stateType)?.desc.replace('%INPUTNUMBER%', subChannel),
                    statusStates: {}
                },
                native: {}
            };

            if (stateType == 'inverter') {
                deviceObj.common.statusStates.onlineId = `${this.name}.${this.instance}.${deviceID}.info.available`;
                deviceObj.type = 'device';
            }

            if (stateType == 'dtu') {
                deviceObj.common.statusStates.onlineId = `${this.name}.${this.instance}.${deviceID}.available`;
                deviceObj.type = 'device';
            }

            if (!newDevice.states) {
                return;
            }

            // @ts-ignore
            await this.extendObjectAsync(deviceID, deviceObj);

            for (const state of newDevice.states) {
                const iobState = {
                    type: 'state',
                    common: await this.copyAndCleanStateObj(state),
                    native: {},
                };

                // @ts-ignore
                await this.extendObjectAsync(`${newDevice.id}.${state.id}`, iobState);
                if (state.write == true) {
                    await this.subscribeStatesAsync(`${newDevice.id}.${state.id}`);
                }
            }

            if (!deviceCache.find(x => x.id == newDevice.id)) {
                deviceCache.push(newDevice);
            }
        }

        const device = deviceCache.find(x => x.id == deviceID);
        if (!device) {
            return;
        }

        const state = device.states.find(x => x.prob == stateID);
        if (!state) {
            return;
        }

        const fullStateID = `${device.id}.${state.id}`;

        if (state.getter) {
            const val = state.getter(payload);
            await this.setStateChangedAsync(fullStateID, val, true);

            // if (state.id == 'available' && val == false) {
            //     const rootDeviceID = device.id.split('.')[0];
            //     this.setStateToZero(rootDeviceID);
            // }

        } else {
            await this.setStateChangedAsync(fullStateID, payload, true);
        }
    }

    async copyAndCleanStateObj(state) {
        const iobState = { ...state };
        const blacklistedKeys = [
            'prop',
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

            const device = deviceCache.find(x => x.id == `${serial}.power_control`);

            if (!device) {
                return;
            }

            const deviceState = device.states.find(x => x.id == stateID);

            if (!deviceState) {
                return;
            }

            if (deviceState.setter) {
                mqttClient.publish(`${this.config.mqttTopic}/${serial}/cmd/${deviceState.prob}`, deviceState.setter(state.val));
            } else {
                mqttClient.publish(`${this.config.mqttTopic}/${serial}/cmd/${deviceState.prob}`, state.val);
            }

            this.setStateAsync(id, state, true);
        }
    }



    onUnload(callback) {
        try {
            mqttClient.end();
        } catch (error) {
            this.log.error(error);
        }

        try {
            schedule.cancelJob('dayEndJob');
        } catch (error) {
            this.log.error(error);
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