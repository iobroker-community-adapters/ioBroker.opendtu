'use strict';

const WebSocket = require('ws');

const AUTH_USERNAME = 'admin'; // OpenDTU uses a fixed user name
const WS_PATH = '/livedata';
const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_GRACE = 3000;
const HANDSHAKE_TIMEOUT = 10000;
const RECONNECT_MIN = 2000;
const RECONNECT_MAX = 60000;

/**
 * Handles the live data websocket of OpenDTU incl. heartbeat and reconnect.
 * All state is kept per instance so that several adapter instances can run in compact mode.
 */
class WebsocketController {
    /**
     * @param adapter adapter instance
     * @param handlers callbacks: onMessage(data) for every message, onConnectionChange(connected) on open/close
     */
    constructor(adapter, handlers) {
        this.adapter = adapter;
        this.handlers = handlers;
        this.ws = null;
        this.stopped = false;
        this.connected = false;
        this.authErrorLogged = false;
        this.failCount = 0;
        this.pingTimer = null;
        this.pongTimer = null;
        this.reconnectTimer = null;
    }

    /**
     * Opens the websocket connection.
     */
    connect() {
        if (this.stopped) {
            return;
        }
        const cfg = this.adapter.config;
        const scheme = cfg.webUIScheme === 'https' ? 'wss' : 'ws';
        const url = `${scheme}://${cfg.webUIServer}:${cfg.webUIPort}${WS_PATH}`;
        // @KI_HINWEIS: Basic auth is sent with the handshake. OpenDTU answers a 401 with a Digest challenge,
        // but its auth middleware also accepts Basic credentials (password stored in plain text, no hash).
        // Header instead of user:password@ in the URL, so the password never appears in URLs or logs.
        const headers = cfg.password
            ? { Authorization: `Basic ${Buffer.from(`${AUTH_USERNAME}:${cfg.password}`).toString('base64')}` }
            : {};

        let ws;
        try {
            ws = new WebSocket(url, { headers, handshakeTimeout: HANDSHAKE_TIMEOUT });
        } catch (err) {
            this.adapter.log.error(`Cannot open websocket to ${url}: ${err.message}`);
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;

        ws.on('open', () => {
            this.connected = true;
            this.authErrorLogged = false;
            if (this.failCount > 0) {
                this.adapter.log.info('Connection to OpenDTU restored.');
            } else {
                this.adapter.log.info('Connected to OpenDTU.');
            }
            this.failCount = 0;
            this.handlers.onConnectionChange(true);
            this.startHeartbeat();
        });

        ws.on('pong', () => this.resetPongTimer());

        ws.on('message', data => this.handlers.onMessage(data.toString()));

        ws.on('unexpected-response', (_req, res) => {
            res.resume();
            if (res.statusCode === 401) {
                this.logAuthError(
                    cfg.password
                        ? 'OpenDTU rejected the password. Please check the password in the adapter settings.'
                        : 'OpenDTU requires a password. Please enter the password of the OpenDTU web interface in the adapter settings.',
                );
            } else {
                this.logFailure(`Unexpected response from OpenDTU: HTTP ${res.statusCode}`);
            }
            ws.terminate();
        });

        ws.on('error', err => {
            // Errors are followed by 'close', reconnect is handled there
            this.logFailure(`Cannot connect to OpenDTU (${cfg.webUIServer}:${cfg.webUIPort}): ${err.message}`);
        });

        ws.on('close', () => {
            this.stopHeartbeat();
            if (this.ws !== ws) {
                return;
            }
            this.ws = null;
            if (this.connected) {
                this.connected = false;
                this.adapter.log.info('Connection to OpenDTU closed.');
                this.handlers.onConnectionChange(false);
            }
            this.scheduleReconnect();
        });
    }

    /**
     * Logs an authentication problem once (as error) and afterwards only on debug level.
     *
     * @param msg message
     */
    logAuthError(msg) {
        if (this.authErrorLogged) {
            this.adapter.log.debug(msg);
        } else {
            this.adapter.log.error(msg);
            this.authErrorLogged = true;
        }
    }

    /**
     * Logs a connection problem: the first failure as warning, repetitions on debug level.
     *
     * @param msg message
     */
    logFailure(msg) {
        if (this.stopped) {
            return;
        }
        if (this.failCount === 0 && !this.authErrorLogged) {
            this.adapter.log.warn(`${msg} - retrying in the background.`);
        } else {
            this.adapter.log.debug(msg);
        }
    }

    /**
     * Schedules the next connect attempt with exponential backoff (2 s ... 60 s).
     * The backoff also limits DNS lookups while OpenDTU is offline (see issue #192).
     */
    scheduleReconnect() {
        if (this.stopped) {
            return;
        }
        this.adapter.clearTimeout(this.reconnectTimer);
        const delay = Math.min(RECONNECT_MIN * 2 ** this.failCount, RECONNECT_MAX);
        this.failCount++;
        this.adapter.log.debug(`Reconnecting to OpenDTU in ${delay / 1000} s`);
        this.reconnectTimer = this.adapter.setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    /**
     * Starts the ping/pong heartbeat to detect dead connections.
     */
    startHeartbeat() {
        this.stopHeartbeat();
        this.resetPongTimer();
        this.pingTimer = this.adapter.setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.ping();
            }
        }, HEARTBEAT_INTERVAL);
    }

    /**
     * Restarts the timer that terminates the connection if no pong arrives.
     */
    resetPongTimer() {
        this.adapter.clearTimeout(this.pongTimer);
        this.pongTimer = this.adapter.setTimeout(() => {
            this.adapter.log.debug('Websocket heartbeat timed out');
            if (this.ws) {
                this.ws.terminate();
            }
        }, HEARTBEAT_INTERVAL + HEARTBEAT_GRACE);
    }

    /**
     * Stops all heartbeat timers.
     */
    stopHeartbeat() {
        this.adapter.clearInterval(this.pingTimer);
        this.adapter.clearTimeout(this.pongTimer);
        this.pingTimer = null;
        this.pongTimer = null;
    }

    /**
     * Stops the controller for good (adapter unload): no further reconnects.
     */
    stop() {
        this.stopped = true;
        this.adapter.clearTimeout(this.reconnectTimer);
        this.stopHeartbeat();
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.on('error', () => {});
            this.ws.terminate();
            this.ws = null;
        }
        this.connected = false;
    }
}

module.exports = {
    WebsocketController,
};
