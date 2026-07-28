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
// NOTE: legacy history.json migration path is owned by rrd.js, which defines
// its own HISTORY_FILE constant — no longer duplicated/used here.
const SOCKETS_FILE = path.join(DATA_DIR, 'sockets.json');
const DAILY_FILE = path.join(DATA_DIR, 'daily.json');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const CERT_FILE = path.join(DATA_DIR, 'cert.pem');
const KEY_FILE = path.join(DATA_DIR, 'key.pem');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const NOTIF_FILE = path.join(DATA_DIR, 'notifications.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

import { log, logBuffer } from './lib/logger.js';
import { watchdogStart, watchdogShutdown } from './lib/watchdog.js';
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
const { loadSessions, saveSessions, hashPassword, verifyPassword, ensureAuth, ensureMetricsToken, loadAuthFile, createSession, getSessionCsrf, getSessionUser, isSessionValid, destroySession, parseCookies, loginAttempts, sessions, clearSessions } = auth;
const notif = createNotifications(DATA_DIR, loadConfig);
const { pushNotification, sendNotification, _sendExtNotification, _notifHistory, saveNotifHistory } = notif;
const app = createAppState(DATA_DIR, loadConfig, saveConfig, decryptSecret, pushNotification);
const {
  inverterData, pollInverter, connectToInverter, injectDemoData,
  loadDailyRecords, finalizeDay, costState, dailyRecords,
  tuyaDevices, controlDevice, fetchDeviceStatuses, syncDeviceNamesFromCloud,
  initTuya, loadDevicesFromDisk, scenes, loadScenes, saveScenes, checkScenes, loadSceneTimers, saveSceneTimers,
  sceneTraces, deviceName, resolveInverterIP, saveDevices, resetInverterConnection,
  isPollingInverter, getInverterConsecutiveFails, pushSceneTrace,
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
  loadScenes, saveScenes, checkScenes, loadSceneTimers, saveSceneTimers,
  deviceName, resolveInverterIP, saveDevices, resetInverterConnection,
  getInverterConsecutiveFails, pushSceneTrace,
  loadAuthFile, verifyPassword, hashPassword, createSession, getSessionUser,
  getSessionCsrf, isSessionValid, destroySession, parseCookies,
  loginAttempts, sessions, clearSessions,
  log, logBuffer,
  rrdPickLevel, rrdGetPower, rrdGetSocket,
  fs, path, exec, execFile, os, __dirname,
  CONFIG_FILE, AUTH_FILE, SCENES_FILE, DEVICES_FILE, SESSIONS_FILE, DATA_DIR, USERS_FILE,
  getLoginPage, getWebUI,
};
registerRoutes(ctx);

// ============================================================
// CRASH HANDLERS — log reason before process dies
// ============================================================
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.stack || err.message || err);
  try { watchdogShutdown('uncaughtException:' + (err.message || String(err))); } catch {}
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  console.error('UNHANDLED REJECTION:', msg);
  try { watchdogShutdown('unhandledRejection:' + msg); } catch {}
  process.exit(1);
});

// ============================================================
// MAIN — STARTUP
// ============================================================
async function main() {
  log.info('Energy Controller starting...');
  watchdogStart();

  await ensureAuth();
  await ensureMetricsToken();
  await loadSessions();

  // Ensure users.json exists with admin user
  if (!fs.existsSync(USERS_FILE)) {
    await fs.promises.writeFile(USERS_FILE, JSON.stringify({ admin: { role: 'admin', createdAt: Date.now() } }, null, 2), { mode: 0o600 });
    log.info('Users file created with admin user');
  }
  // Ensure admin prefs directory
  const adminPrefsDir = path.join(DATA_DIR, 'admin');
  if (!fs.existsSync(adminPrefsDir)) {
    await fs.promises.mkdir(adminPrefsDir, { recursive: true });
    await fs.promises.writeFile(path.join(adminPrefsDir, 'prefs.json'), JSON.stringify({ tileVis: {}, tileOrder: [], accent: 'purple', notifGroup: true }, null, 2), { mode: 0o600 });
    log.info('Admin prefs created');
  }

  await loadDailyRecords();
  await rrdInit();
  await loadScenes();
  loadSceneTimers();
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
    if (getInverterConsecutiveFails() >= 5) {
      if (isPollingInverter()) return;
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

  setInterval(() => {
    const now = Date.now();
    for (const token of Object.keys(sessions)) {
      if (sessions[token].exp < now) delete sessions[token];
    }
    saveSessions();
  }, 60 * 60 * 1000);

  log.info('Energy Controller started');
  const lastReady = notif._notifHistory.filter(n => n.title === 'System Ready').at(-1);
  if (!lastReady || Date.now() - lastReady.time > 30 * 60 * 1000) {
    pushNotification('System Ready', 'Energy Controller started successfully', 'info');
  }

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
    try { await rrdFlush(); } catch (err) { log.error("Flush on shutdown: " + err.message); }
    watchdogShutdown(signal);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(err => {
  log.error("Fatal: " + err.message);
  watchdogShutdown("fatal:" + err.message);
  process.exit(1);
});

