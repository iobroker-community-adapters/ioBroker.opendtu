'use strict';

const crypto = require('node:crypto');
const WebSocket = require('ws');

const AUTH_USERNAME = 'admin'; // OpenDTU uses a fixed user name
const WS_PATH = '/livedata';
const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_GRACE = 3000;
const HANDSHAKE_TIMEOUT = 10000;
const RECONNECT_MIN = 2000;
const RECONNECT_MAX = 60000;

/**
 * Parses a WWW-Authenticate header into scheme and parameters.
 *
 * @param header value of the WWW-Authenticate header
 * @returns parsed challenge
 */
function parseAuthChallenge(header) {
    const str = String(header || '').trim();
    const spaceIdx = str.indexOf(' ');
    const scheme = (spaceIdx > 0 ? str.slice(0, spaceIdx) : str).toLowerCase();
    const params = {};
    const re = /(\w+)=(?:"([^"]*)"|([^\s,]*))/g;
    let m;
    while ((m = re.exec(str.slice(spaceIdx + 1))) !== null) {
        params[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
    }
    return { scheme, params };
}

/**
 * Builds the Authorization header for an HTTP Digest challenge (RFC 7616, MD5).
 *
 * @param challenge parameters of the Digest challenge
 * @param username user name
 * @param password password
 * @param method HTTP method of the request
 * @param uri request URI
 * @returns value for the Authorization header
 */
function buildDigestHeader(challenge, username, password, method, uri) {
    const md5 = s => crypto.createHash('md5').update(s).digest('hex');
    const realm = challenge.realm || '';
    const nonce = challenge.nonce || '';
    const qop = (challenge.qop || '')
        .split(',')
        .map(q => q.trim())
        .includes('auth')
        ? 'auth'
        : '';
    const nc = '00000001';
    const cnonce = crypto.randomBytes(8).toString('hex');
    const ha1 = md5(`${username}:${realm}:${password}`);
    const ha2 = md5(`${method}:${uri}`);
    const response = qop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);

    const parts = [
        `username="${username}"`,
        `realm="${realm}"`,
        `nonce="${nonce}"`,
        `uri="${uri}"`,
        'algorithm=MD5',
        `response="${response}"`,
    ];
    if (challenge.opaque) {
        parts.push(`opaque="${challenge.opaque}"`);
    }
    if (qop) {
        parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
    }
    return `Digest ${parts.join(', ')}`;
}

/**
 * Handles the live data websocket of OpenDTU incl. authentication, heartbeat and reconnect.
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
        this.authHeader = undefined;
        this.authRetried = false;
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
        const headers = this.authHeader ? { Authorization: this.authHeader } : {};

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
            this.authRetried = false;
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

        // @KI_HINWEIS: OpenDTU >= v26.4 protects /livedata with HTTP Digest auth when "read-only access" is disabled.
        // The ws library only sends Basic auth from the URL, so we answer the 401 challenge ourselves and reconnect.
        ws.on('unexpected-response', (_req, res) => {
            res.resume();
            if (res.statusCode === 401) {
                this.handleAuthChallenge(res.headers['www-authenticate']);
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
     * Prepares the Authorization header for the next connect attempt.
     *
     * @param header WWW-Authenticate header of the 401 response
     */
    handleAuthChallenge(header) {
        const password = this.adapter.config.password;
        if (!password) {
            this.logAuthError(
                'OpenDTU requires a password. Please enter the password of the OpenDTU web interface in the adapter settings.',
            );
            return;
        }
        if (this.authRetried) {
            this.authHeader = undefined;
            this.logAuthError('OpenDTU rejected the password. Please check the password in the adapter settings.');
            return;
        }
        const { scheme, params } = parseAuthChallenge(header);
        if (scheme === 'digest') {
            this.authHeader = buildDigestHeader(params, AUTH_USERNAME, password, 'GET', WS_PATH);
        } else {
            this.authHeader = `Basic ${Buffer.from(`${AUTH_USERNAME}:${password}`).toString('base64')}`;
        }
        this.authRetried = true;
        this.failCount = -1; // reconnect immediately with credentials
        this.adapter.log.debug(`Authenticating websocket with ${scheme === 'digest' ? 'Digest' : 'Basic'} auth`);
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
        this.authRetried = false;
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
        let delay;
        if (this.failCount < 0) {
            delay = 0;
            this.failCount = 0;
        } else {
            delay = Math.min(RECONNECT_MIN * 2 ** this.failCount, RECONNECT_MAX);
            this.failCount++;
        }
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
    parseAuthChallenge,
    buildDigestHeader,
};
