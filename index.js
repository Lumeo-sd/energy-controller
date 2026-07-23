#!/usr/bin/env node
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { exec, execFile } from 'node:child_process';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const SCENES_FILE = path.join(DATA_DIR, 'scenes.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const SOCKETS_FILE = path.join(DATA_DIR, 'sockets.json');
const DAILY_FILE = path.join(DATA_DIR, 'daily.json');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const CERT_FILE = path.join(DATA_DIR, 'cert.pem');
const KEY_FILE = path.join(DATA_DIR, 'key.pem');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const NOTIF_FILE = path.join(DATA_DIR, 'notifications.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

import { log, logBuffer } from './lib/logger.js';
import { crc16, getCrc, addCrc, verifyCrc } from './lib/crc16.js';
import { SolarmanV5 } from './lib/solarman.js';
import { tuyaSign, tuyaRequest } from './lib/tuya-sign.js';
import { createRrd } from './lib/rrd.js';
import { createConfig } from './lib/config.js';
import { createAuth } from './lib/auth.js';
import { createNotifications } from './lib/notifications.js';
import { createAppState } from './lib/app-state.js';
import { parseBody, sendJson, sendHtml, sendText, setCookie, clearCookie, route, matchRoute } from './lib/router.js';
import { rateLimit, getClientIp } from './lib/rate-limit.js';
import { getCryptoHelpers } from './lib/crypto.js';
import { registerRoutes } from './lib/routes.js';
import { createServerState } from './lib/server.js';

const { MASTER_KEY, encryptSecret, decryptSecret } = getCryptoHelpers(DATA_DIR);
const { loadConfig, saveConfig, netbirdExec } = createConfig(DATA_DIR, { MASTER_KEY, encryptSecret, decryptSecret });
const rrd = createRrd(DATA_DIR);
const { RRD_POWER, RRD_SOCKET, RRD_PENDING, RRD_SOCKET_PENDING, RRD_FLUSH_MS, rrdInit, rrdFlush, rrdGetPower, rrdGetSocket, rrdPickLevel } = rrd;
const auth = createAuth(DATA_DIR, { loadConfig, saveConfig });
const { loadSessions, hashPassword, verifyPassword, ensureAuth, ensureMetricsToken, loadAuthFile, createSession, getSessionCsrf, isSessionValid, destroySession, parseCookies, loginAttempts, sessions, clearSessions } = auth;
const notif = createNotifications(DATA_DIR, loadConfig);
const { pushNotification, sendNotification, _sendExtNotification, _notifHistory, saveNotifHistory } = notif;
const app = createAppState(DATA_DIR, loadConfig, saveConfig, decryptSecret, pushNotification);
const {
  inverterData, pollInverter, connectToInverter, injectDemoData,
  loadDailyRecords, finalizeDay, costState, dailyRecords,
  tuyaDevices, controlDevice, fetchDeviceStatuses, syncDeviceNamesFromCloud,
  initTuya, loadDevicesFromDisk, scenes, loadScenes, saveScenes, checkScenes,
  sceneTraces, deviceName, resolveInverterIP, saveDevices, resetInverterConnection,
  _pollingInverter, _inverterConsecutiveFails, pushSceneTrace,
} = app;

const serverState = createServerState({
  log, path, fs, exec, __dirname,
  CERT_FILE, KEY_FILE,
  parseCookies, isSessionValid, getSessionCsrf, sendJson,
  matchRoute, parseBody, rateLimit, getClientIp,
});
const { getLoginPage, getWebUI, createRequestHandler, ensureCertificates } = serverState;

const WEB_PORT_DEFAULT = 8583;

// ============================================================
// REGISTER ROUTES
// ============================================================
const ctx = {
  route, sendJson, sendHtml, sendText, setCookie, clearCookie,
  loadConfig, saveConfig, netbirdExec,
  encryptSecret,
  pushNotification, sendNotification, _notifHistory, saveNotifHistory,
  inverterData, costState, dailyRecords, tuyaDevices, scenes, sceneTraces,
  controlDevice, fetchDeviceStatuses, syncDeviceNamesFromCloud, initTuya,
  loadScenes, saveScenes, checkScenes,
  deviceName, resolveInverterIP, saveDevices, resetInverterConnection,
  _inverterConsecutiveFails, pushSceneTrace,
  loadAuthFile, verifyPassword, hashPassword, createSession,
  getSessionCsrf, isSessionValid, destroySession, parseCookies,
  loginAttempts, sessions, clearSessions,
  log, logBuffer,
  rrdPickLevel, rrdGetPower, rrdGetSocket,
  fs, path, exec, execFile, os, __dirname,
  CONFIG_FILE, AUTH_FILE, SCENES_FILE, DEVICES_FILE, SESSIONS_FILE, DATA_DIR,
  getLoginPage, getWebUI,
};
registerRoutes(ctx);

// ============================================================
// MAIN — STARTUP
// ============================================================
async function main() {
  log.info('Energy Controller starting...');

  await ensureAuth();
  await ensureMetricsToken();
  await loadSessions();
  await loadDailyRecords();
  await rrdInit();
  await loadScenes();
  const cfg = await loadConfig();
  const port = cfg.webPort || WEB_PORT_DEFAULT;

  const tls = await ensureCertificates();

  const requestHandler = createRequestHandler();
  const server = http.createServer(requestHandler);

  let httpServer, httpsServer;

  httpServer = http.createServer((req, res) => {
    if (tls) {
      const host = (req.headers.host || 'localhost').replace(/:\d+$/, '');
      const url = `https://${host}:${port + 1}${req.url}`;
      res.writeHead(302, { Location: url });
      res.end();
      return;
    }
    server.emit('request', req, res);
  });
  httpServer.listen(port, '0.0.0.0', () => {
    log.info('HTTP server listening on port ' + port + (tls ? ' (redirecting to HTTPS)' : ''));
  });

  if (tls) {
    httpsServer = https.createServer({ cert: tls.cert, key: tls.key }, (req, res) => {
      server.emit('request', req, res);
    });
    httpsServer.listen(port + 1, '0.0.0.0', () => {
      log.info('HTTPS server listening on port ' + (port + 1));
    });
  } else {
    log.warn('TLS certificates not available — running HTTP only (not secure!)');
  }

  await connectToInverter();
  if (!inverterData.lastUpdate) injectDemoData();
  pollInverter();
  setInterval(() => {
    if (_inverterConsecutiveFails >= 5) {
      if (_pollingInverter) return;
      log.info('Inverter: too many failures, reconnecting...');
      pushNotification('Reconnecting', 'Too many inverter failures — reconnecting...', 'warn');
      connectToInverter().then(() => pollInverter());
    } else {
      pollInverter();
    }
  }, 10000);
  setInterval(() => {
    const now = Date.now();
    const socketSum = tuyaDevices.reduce((a, d) => a + (d.power || 0), 0);
    RRD_PENDING.push({
      ts: now,
      grid: inverterData.gridPower,
      soc: inverterData.batterySOC,
      load: inverterData.loadPower,
      bat: inverterData.batteryPower,
      pv: inverterData.pvPower,
      otherLoad: Math.max(0, Math.round((inverterData.loadPower - socketSum) * 10) / 10),
    });
  }, 60000);

  setInterval(rrdFlush, RRD_FLUSH_MS);

  await initTuya();
  const devs = {};
  for (const dev of tuyaDevices) {
    if (dev.power !== undefined && dev.power !== null) devs[dev.id] = dev.power;
  }
  if (Object.keys(devs).length > 0) RRD_SOCKET_PENDING.push({ ts: Date.now(), devices: devs });

  setInterval(async () => {
    await fetchDeviceStatuses();
    const devs2 = {};
    for (const dev of tuyaDevices) {
      if (dev.power !== undefined && dev.power !== null) devs2[dev.id] = dev.power;
    }
    if (Object.keys(devs2).length > 0) RRD_SOCKET_PENDING.push({ ts: Date.now(), devices: devs2 });
  }, 60000);

  setInterval(checkScenes, 10000);

  let _notifiedLowSoc = false;
  let _gridWasOn=null; let _gridOffSince=null; let _gridOffSoc=null; let _gridOffLoadAccum=0; let _gridOffLastTs=0;
  setInterval(async () => {
    try {
      const cfg = await loadConfig();
      const n = cfg.notifications || {};
      const soc = inverterData.batterySOC;

      if (soc > 0 && soc <= (n.lowSocAlert || 20) && !_notifiedLowSoc && (n.ntfyTopic || n.telegramToken)) {
        _notifiedLowSoc = true;
        sendNotification('Low Battery', 'SOC: ' + soc + '% \u2014 below ' + (n.lowSocAlert || 20) + '% threshold', true);
      } else if (soc > (n.lowSocAlert || 20) + 5) {
        _notifiedLowSoc = false;
      }

      if (_inverterConsecutiveFails >= 5 && n.connTimeout && (n.ntfyTopic || n.telegramToken)) {
        sendNotification('Inverter Offline', _inverterConsecutiveFails + ' consecutive poll failures. Check connection.', true);
      }

      if (n.gridOutageReport !== false) {
        const now = Date.now();
        const gridOn = inverterData.gridPower;
        if (gridOn === false) {
          if (_gridOffSince === null) {
            _gridOffSince = new Date();
            _gridOffSoc = inverterData.batterySOC;
            _gridOffLoadAccum = 0;
            _gridOffLastTs = now;
            log.info('Grid outage started at ' + _gridOffSince.toLocaleTimeString() + ' (SOC: ' + _gridOffSoc + '%)');
            pushNotification('Grid Outage', 'Grid went down at ' + _gridOffSince.toLocaleTimeString() + ' (SOC: ' + _gridOffSoc + '%)', 'error');
          } else {
            const elapsedH = (now - _gridOffLastTs) / 3600000;
            if (elapsedH > 0) _gridOffLoadAccum += (inverterData.loadPower || 0) * elapsedH / 1000;
            _gridOffLastTs = now;
          }
        } else if (_gridOffSince !== null) {
          const offMs = now - _gridOffSince.getTime();
          const offMin = Math.round(offMs / 60000);
          const hours = Math.floor(offMin / 60);
          const mins = offMin % 60;
          const socNow = inverterData.batterySOC;
          const socUsed = Math.max(0, Math.round((_gridOffSoc - socNow) * 10) / 10);
          const loadUsed = Math.round(_gridOffLoadAccum * 100) / 100;

          const report = [
            'Grid went down: ' + _gridOffSince.toLocaleTimeString(),
            'Restored: ' + new Date().toLocaleTimeString(),
            'Duration: ' + hours + 'h ' + mins + 'm',
            'Battery: ' + _gridOffSoc + '% \u2192 ' + socNow + '%' + (socUsed > 0 ? ' (used ' + socUsed + '%)' : ''),
            'Load energy: ~' + loadUsed + ' kWh',
          ].join('\n');

          sendNotification('Grid Restored', report, false);
          log.info('Grid outage ended: ' + hours + 'h' + mins + 'm, SOC ' + _gridOffSoc + '%\u2192' + socNow + '%');

          _gridOffSince = null;
          _gridOffSoc = null;
          _gridOffLoadAccum = 0;
        }
      }
    } catch {}
  }, 120000);

  setInterval(() => {
    const now = Date.now();
    for (const token of Object.keys(sessions)) {
      if (sessions[token].exp < now) delete sessions[token];
    }
    saveSessions();
  }, 60 * 60 * 1000);

  log.info('Energy Controller started');
  pushNotification('System Ready', 'Energy Controller started successfully', 'info');

  const shutdown = async (signal) => {
    log.info(signal + ' received, shutting down...');
    if (httpServer) httpServer.close();
    if (httpsServer) httpsServer.close();
    server.close();
    try {
      const now = Date.now();
      const active = {};
      for (const [token, s] of Object.entries(sessions)) {
        if (s.exp && s.exp > now) active[token] = s;
      }
      await fs.promises.writeFile(SESSIONS_FILE, JSON.stringify(active, null, 2), { mode: 0o600 });
    } catch {}
    try { await rrdFlush(); } catch (err) { log.error('Flush on shutdown: ' + err.message); }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(err => {
  log.error('Fatal: ' + err.message);
  process.exit(1);
});

