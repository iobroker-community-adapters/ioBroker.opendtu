'use strict';
const utils = require('@iobroker/adapter-core');
const mqtt = require('mqtt');
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
        // this.on('objectChange', this.onObjectChange.bind(this));
        // this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        this.setState('info.connection', false, true);

        // External MQTT-Server
        if (this.config.externalMqttServerIP == '') {
            this.log.warn('Please configure the External MQTT-Server connection!');
            return;
        }
        mqttClient = mqtt.connect(`mqtt://${this.config.externalMqttServerIP}:${this.config.externalMqttServerPort}`, { clientId: `ioBroker.zigbee2mqtt_${Math.random().toString(16).slice(2, 8)}`, clean: true, reconnectPeriod: 500 });

        // MQTT Client
        mqttClient.on('connect', () => {
            this.log.info(`Connect to OpenDTU over external mqtt connection.`);
            this.setState('info.connection', true, true);
        });

        mqttClient.subscribe(`${this.config.mqttTopic}/#`);

        mqttClient.on('message', (topic, payload) => {
            this.messageParse(topic, payload);
        });
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
                        stateType = 'info';
                        deviceID = `${deviceID}.info`;
                        stateID = topicSplit[3];
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
            }

            deviceCache.push(newDevice);
        }

        const device = deviceCache.find(x => x.id == deviceID);
        let state;
        try {

            if (device) {
                state = device.states.find(x => x.prob == stateID);
                const stateName = `${device.id}.${state.id}`;

                if (state.getter) {
                    this.setStateChangedAsync(stateName, state.getter(payload), true);
                } else {
                    this.setStateChangedAsync(stateName, payload, true);
                }
            }
        } catch {
            //console.log('bäääääm');
        }
    }


    async copyAndCleanStateObj(state) {
        const iobState = { ...state };
        const blacklistedKeys = [
            'prop'
        ];
        for (const blacklistedKey of blacklistedKeys) {
            delete iobState[blacklistedKey];
        }
        return iobState;
    }

    onUnload(callback) {
        try {

            callback();
        } catch (e) {
            callback();
        }
    }

    onStateChange(id, state) {
        if (state) {
            // The state was changed
            this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
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