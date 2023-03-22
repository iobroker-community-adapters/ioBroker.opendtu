const WebSocket = require('ws');
let wsClient;
const wsHeartbeatIntervall = 10000;
const restartTimeout = 1000;
let ping;
let pingTimeout;
let autoRestartTimeout;

class WebsocketController {
    constructor(adapter) {
        this.adapter = adapter;
    }

    initWsClient() {
        try {
            const wsURL = `${this.adapter.config.webUIScheme == 'http' ? 'ws' : 'wss'}://${this.adapter.config.webUIServer}:${this.adapter.config.webUIPort}/livedata`;
            this.adapter.debug(`Websocket connect over URL: ${wsURL}`);

            wsClient = new WebSocket(wsURL);

            wsClient.on('open', () => {
                // Send ping to server
                this.sendPingToServer();
                // Start Heartbeat
                this.wsHeartbeat();
            });

            wsClient.on('pong', () => {
                this.wsHeartbeat();
            });

            wsClient.on('close', async () => {
                clearTimeout(pingTimeout);
                clearTimeout(ping);

                if (wsClient.readyState === WebSocket.CLOSED) {
                    this.autoRestart();
                }
            });

            wsClient.on('message', () => { });

            wsClient.on('error', (err) => {
                this.adapter.log.debug(`Websocket error: ${err}`);
            });

            return wsClient;
        } catch (err) {
            this.adapter.log.error(err);
        }
    }

    sendPingToServer() {
        //this.logDebug('Send ping to server');
        wsClient.ping();
        ping = setTimeout(() => {
            this.sendPingToServer();
        }, wsHeartbeatIntervall);
    }

    wsHeartbeat() {
        clearTimeout(pingTimeout);
        pingTimeout = setTimeout(() => {
            this.adapter.log.debug('Websocked connection timed out');
            wsClient.terminate();
        }, wsHeartbeatIntervall + 3000);
    }

    async autoRestart() {
        this.adapter.log.debug(`Start try again in ${restartTimeout / 1000} seconds...`);
        autoRestartTimeout = setTimeout(() => {
            this.adapter.startWebsocket();
        }, restartTimeout);
    }

    closeConnection() {
        if (wsClient && wsClient.readyState !== WebSocket.CLOSED) {
            wsClient.close();
        }
    }

    async allTimerClear() {
        clearTimeout(pingTimeout);
        clearTimeout(ping);
        clearTimeout(autoRestartTimeout);
    }
}

module.exports = {
    WebsocketController
};
