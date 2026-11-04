'use strict';
const utils = require('@iobroker/adapter-core');
const { default: axios } = require('axios');
const schedule = require('node-schedule');
const { WebsocketController } = require('./lib/websocketController');
const { DataController } = require('./lib/dataController');

const AUTH_USERNAME = 'admin';
const DTU_POLL_INTERVAL = 60000;
// OpenDTU keeps at most 15 events per inverter (ALARM_LOG_ENTRY_COUNT); when full the count no longer changes
const EVENT_LOG_MAX = 15;
const EVENT_LOG_FULL_INTERVAL = 300000;
const HTTP_TIMEOUT = 10000;
const COMMAND_POLL_INTERVAL = 2000;
const COMMAND_POLL_COUNT = 45;

/** limit_type values of the OpenDTU API per writable state */
const LIMIT_TYPES = {
    limit_nonpersistent_absolute: 0,
    limit_nonpersistent_relative: 1,
    limit_persistent_absolute: 256,
    limit_persistent_relative: 257,
};

class Opendtu extends utils.Adapter {
    /**
     * @param [options] adapter options
     */
    constructor(options) {
        super({
            ...options,
            name: 'opendtu',
        });
        this.api = null;
        this.websocketController = null;
        this.dataController = null;
        this.yieldTotalJob = null;
        this.dtuPollTimer = null;
        this.eventLogTimer = null;
        this.messageQueue = Promise.resolve();
        this.commandPolls = new Set();
        this.devInfoDone = new Set();
        this.devInfoBusy = new Set();
        this.commandStatusRead = false;
        this.locale = 'en';
        this.unloading = false;

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await this.setState('info.connection', false, true);

        // Accept input like "http://192.168.1.10/" in the address field
        const server = String(this.config.webUIServer || '')
            .trim()
            .replace(/^[a-z]+:\/\//i, '')
            .replace(/\/.*$/, '');
        if (!server) {
            this.log.warn('Please enter the address of your OpenDTU in the adapter settings.');
            return;
        }
        this.config.webUIServer = server;
        this.config.webUIScheme = this.config.webUIScheme === 'https' ? 'https' : 'http';
        this.config.webUIPort = Number(this.config.webUIPort) || (this.config.webUIScheme === 'https' ? 443 : 80);

        // @KI_HINWEIS: own axios instance instead of axios.defaults - in compact mode axios is shared with other adapters
        this.api = axios.create({
            baseURL: `${this.config.webUIScheme}://${server}:${this.config.webUIPort}/api`,
            timeout: HTTP_TIMEOUT,
            auth: this.config.password ? { username: AUTH_USERNAME, password: this.config.password } : undefined,
            // Prevents OpenDTU from asking for browser authentication
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });

        this.locale = await this.getEventLogLocale();
        this.dataController = new DataController(this, {
            onEventCount: serial => this.readEventLog(serial),
            onReachable: serial => this.readDevInfo(serial),
        });
        this.websocketController = new WebsocketController(this, {
            onMessage: data => this.queueMessage(data),
            onConnectionChange: connected => this.onConnectionChange(connected),
        });
        this.websocketController.connect();

        await this.getDTUData();
        this.dtuPollTimer = this.setInterval(() => this.getDTUData(), DTU_POLL_INTERVAL);
        this.eventLogTimer = this.setInterval(() => this.refreshFullEventLogs(), EVENT_LOG_FULL_INTERVAL);
        this.yieldTotalJob = schedule.scheduleJob('0 1 0 * * *', () => this.rewriteYieldTotal());
    }

    /**
     * @param id state ID
     * @param state new state
     */
    async onStateChange(id, state) {
        if (!state || state.ack || !this.api) {
            return;
        }
        const idParts = id.split('.');
        const serial = idParts[2];
        const stateID = idParts[4];

        let ok = false;
        if (stateID in LIMIT_TYPES) {
            ok = await this.setInverterLimit(serial, state.val, LIMIT_TYPES[stateID]);
        } else if (stateID === 'power_on' || stateID === 'power_off' || stateID === 'restart') {
            if (!state.val) {
                return;
            }
            const payload =
                stateID === 'restart' ? { serial, restart: true } : { serial, power: stateID === 'power_on' };
            ok = await this.postCommand('/power/config', payload);
        } else {
            return;
        }

        // Confirm the command only if OpenDTU accepted it
        if (ok) {
            await this.setState(id, state.val, true);
            void this.pollCommandStatus(stateID in LIMIT_TYPES ? 'limit' : 'power');
        }
    }

    async onConnectionChange(connected) {
        if (this.unloading) {
            return;
        }
        await this.setState('info.connection', connected, true);
        if (!connected) {
            await this.allAvailableToFalse();
        }
    }

    /**
     * @param callback callback
     */
    async onUnload(callback) {
        this.unloading = true;
        try {
            if (this.websocketController) {
                this.websocketController.stop();
            }
            this.clearInterval(this.dtuPollTimer);
            this.clearInterval(this.eventLogTimer);
            if (this.yieldTotalJob) {
                this.yieldTotalJob.cancel();
            }
            await this.setState('info.connection', false, true);
            await this.allAvailableToFalse();
        } catch (e) {
            this.log.error(`Error during unload: ${e}`);
        } finally {
            callback();
        }
    }

    /**
     * Processes websocket messages one after another, so objects are not created twice.
     *
     * @param data raw message or already parsed data
     */
    queueMessage(data) {
        this.queueTask(() => this.processMessage(data));
    }

    /**
     * Runs a task after all previous tasks (messages, event log) are done.
     *
     * @param task async function
     */
    queueTask(task) {
        this.messageQueue = this.messageQueue
            .then(task)
            .catch(err => this.log.error(`Error while processing data from OpenDTU: ${err}`));
    }

    /**
     * @param message message from OpenDTU
     */
    async processMessage(message) {
        if (this.unloading || !this.dataController) {
            return;
        }
        if (typeof message === 'string') {
            try {
                message = JSON.parse(message);
            } catch (err) {
                this.log.warn(`Invalid data from OpenDTU: ${err}`);
                this.log.debug(message);
                return;
            }
        }
        if (!message || typeof message !== 'object') {
            return;
        }

        if (Array.isArray(message.inverters)) {
            await this.dataController.processInverterData(message.inverters);
        }
        if (message.total) {
            await this.dataController.processTotalData(message.total);
        }
        if (message.dtu) {
            await this.dataController.processDTUData(message.dtu);
        }
        if (message.hints) {
            await this.dataController.processHints(message.hints);
        }
        // Read the command status once, as soon as the inverters are known
        if (!this.commandStatusRead && Array.isArray(message.inverters) && message.inverters.length) {
            this.commandStatusRead = true;
            void this.readCommandStatus('limit');
            void this.readCommandStatus('power');
        }
    }

    async getDTUData() {
        if (!this.api) {
            return;
        }
        let dtu;
        try {
            const [network, system] = await Promise.all([
                this.api.get('/network/status'),
                this.api.get('/system/status'),
            ]);
            const sys = system.data || {};
            dtu = {
                ...network.data,
                uptime: sys.uptime,
                cputemp: sys.cputemp,
                firmware: sys.git_hash,
                heap_free: sys.heap_total - sys.heap_used,
                heap_min_free: sys.heap_min_free,
                heap_max_block: sys.heap_max_block,
                reachable: true,
            };
        } catch (err) {
            this.log.debug(`Cannot read DTU status: ${err}`);
            dtu = { reachable: false };
        }
        this.queueMessage({ dtu });
    }

    /**
     * Sends a command to the OpenDTU API.
     *
     * @param path API path
     * @param payload data to send
     * @returns true if OpenDTU accepted the command
     */
    async postCommand(path, payload) {
        if (!this.api) {
            return false;
        }
        try {
            const res = await this.api.post(path, `data=${JSON.stringify(payload)}`);
            if (res.data && res.data.type && res.data.type !== 'success') {
                this.log.warn(`OpenDTU rejected the command: ${res.data.message || res.data.type}`);
                return false;
            }
            return true;
        } catch (err) {
            if (err.response && err.response.status === 401) {
                this.log.error(
                    'OpenDTU rejected the password. Commands need the password of the OpenDTU web interface.',
                );
            } else {
                this.log.warn(`Cannot send command to OpenDTU: ${err.message}`);
            }
            return false;
        }
    }

    /**
     * @param serial inverter serial
     * @param value limit value
     * @param limitType OpenDTU limit_type
     * @returns true on success
     */
    async setInverterLimit(serial, value, limitType) {
        const limit = Number(value);
        if (value === null || value === '' || !Number.isFinite(limit) || limit < 0) {
            this.log.warn(`Invalid limit "${value}" for inverter ${serial} - please use a number >= 0.`);
            return false;
        }
        if ((limitType === 1 || limitType === 257) && limit > 100) {
            this.log.warn(`Invalid limit ${limit} % for inverter ${serial} - please use 0 ... 100.`);
            return false;
        }
        if (this.dataController) {
            this.dataController.noteLimitCommand(serial, limit);
        }
        return this.postCommand('/limit/config', { serial, limit_type: limitType, limit_value: limit });
    }

    /**
     * Reads /api/limit/status or /api/power/status.
     *
     * @param kind 'limit' or 'power'
     * @returns true while a command is not finished yet (Pending, or Failure which OpenDTU resends by itself)
     */
    async readCommandStatus(kind) {
        if (!this.api || !this.dataController || this.unloading) {
            return false;
        }
        try {
            const res = await this.api.get(`/${kind}/status`);
            await this.dataController.processCommandStatus(res.data);
            const field = `${kind}_set_status`;
            // @KI_HINWEIS: OpenDTU resends a failed limit/power command in its next poll cycle (Hoymiles.cpp),
            // so 'Failure' is only an intermediate state - keep following it until 'Ok'.
            return Object.values(res.data || {}).some(x => x && (x[field] === 'Pending' || x[field] === 'Failure'));
        } catch (err) {
            this.log.debug(`Cannot read ${kind} status: ${err}`);
            return false;
        }
    }

    /**
     * After a command: follow its status until OpenDTU reports Ok (max. 90 s).
     *
     * @param kind 'limit' or 'power'
     */
    async pollCommandStatus(kind) {
        if (this.commandPolls.has(kind)) {
            return; // already running
        }
        this.commandPolls.add(kind);
        try {
            for (let i = 0; i < COMMAND_POLL_COUNT && !this.unloading; i++) {
                await this.delay(COMMAND_POLL_INTERVAL);
                if (!(await this.readCommandStatus(kind))) {
                    break;
                }
            }
        } finally {
            this.commandPolls.delete(kind);
        }
    }

    /**
     * Reads the event log of an inverter. Called only when the number of entries changed.
     *
     * @param serial inverter serial
     */
    async readEventLog(serial) {
        if (!this.api || !this.dataController || this.unloading) {
            return;
        }
        try {
            const res = await this.api.get('/eventlog/status', { params: { inv: serial, locale: this.locale } });
            this.queueTask(
                () => this.dataController && this.dataController.processEventLog(serial, res.data && res.data.events),
            );
        } catch (err) {
            this.log.debug(`Cannot read event log of ${serial}: ${err}`);
        }
    }

    /**
     * Reads the device info (firmware, hardware) of an inverter once per run.
     * OpenDTU knows it only after the inverter answered once, so it is requested when the inverter is reachable.
     *
     * @param serial inverter serial
     */
    async readDevInfo(serial) {
        if (
            !this.api ||
            !this.dataController ||
            this.unloading ||
            this.devInfoDone.has(serial) ||
            this.devInfoBusy.has(serial)
        ) {
            return;
        }
        this.devInfoBusy.add(serial);
        try {
            const res = await this.api.get('/devinfo/status', { params: { inv: serial } });
            const info = res.data || {};
            if (info.valid_data) {
                this.devInfoDone.add(serial);
                this.queueTask(() => this.dataController && this.dataController.processDevInfo(serial, info));
            }
        } catch (err) {
            this.log.debug(`Cannot read device info of ${serial}: ${err}`);
        } finally {
            this.devInfoBusy.delete(serial);
        }
    }

    /**
     * Re-reads the event log of reachable inverters whose log is full (15 entries).
     * A full log no longer changes its count, so new events would be missed otherwise.
     */
    refreshFullEventLogs() {
        if (!this.dataController || this.unloading) {
            return;
        }
        for (const [serial, count] of this.dataController.eventCounts) {
            if (count >= EVENT_LOG_MAX && this.dataController.reachable.get(serial) === true) {
                void this.readEventLog(serial);
            }
        }
    }

    /**
     * OpenDTU knows the event texts in English, German and French.
     *
     * @returns locale for the event log
     */
    async getEventLogLocale() {
        try {
            const sysConfig = await this.getForeignObjectAsync('system.config');
            const lang = sysConfig && sysConfig.common && sysConfig.common.language;
            return lang === 'de' || lang === 'fr' ? lang : 'en';
        } catch {
            return 'en';
        }
    }

    /**
     * Rewrites yield total once per day (helps e.g. sourceanalytix to detect the new day).
     */
    async rewriteYieldTotal() {
        const ids = Object.keys(await this.getAdapterObjectsAsync()).filter(x => x.endsWith('yieldtotal'));
        for (const id of ids) {
            const currentState = await this.getStateAsync(id);
            if (currentState && currentState.val !== null) {
                await this.setState(id, currentState.val, true);
            }
        }
    }

    async allAvailableToFalse() {
        const ids = Object.keys(await this.getAdapterObjectsAsync()).filter(x => x.endsWith('.available'));
        await Promise.all(ids.map(id => this.setStateChangedAsync(id, false, true)));
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param [options] adapter options
     */
    module.exports = options => new Opendtu(options);
} else {
    // otherwise start the instance directly
    new Opendtu();
}
