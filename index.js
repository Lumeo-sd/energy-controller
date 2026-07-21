#!/usr/bin/env node
// ============================================================
// Energy Controller — Standalone Web App
// Zero npm dependencies. Runs on Node.js 22+
// ============================================================

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

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ============================================================
// LOGGER
// ============================================================
const LOG_BUFFER_MAX = 200;
const logBuffer = [];

const log = {
  info: (...a) => {
    const msg = `[${new Date().toISOString()}] INFO: ${a.join(' ')}`;
    console.log(msg);
    logBuffer.push(msg);
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  },
  warn: (...a) => {
    const msg = `[${new Date().toISOString()}] WARN: ${a.join(' ')}`;
    console.log(msg);
    logBuffer.push(msg);
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  },
  error: (...a) => {
    const msg = `[${new Date().toISOString()}] ERROR: ${a.join(' ')}`;
    console.error(msg);
    logBuffer.push(msg);
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  },
  debug: (...a) => {},
};

// ============================================================
// ENCRYPTION HELPERS (for Tuya password at rest)
// ============================================================
function getMasterKey() {
  try {
    if (fs.existsSync(SECRET_FILE)) {
      return fs.readFileSync(SECRET_FILE, 'utf8').trim();
    }
    const key = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, key, { mode: 0o600 });
    log.info('Generated master encryption key');
    return key;
  } catch (err) {
    log.error('Failed to load/generate master key: ' + err.message);
    return crypto.randomBytes(32).toString('hex'); // fallback in memory
  }
}

const MASTER_KEY = getMasterKey();

function encryptSecret(plaintext) {
  if (!plaintext) return '';
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(MASTER_KEY, 'hex'), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return iv.toString('hex') + ':' + ciphertext.toString('hex') + ':' + authTag.toString('hex');
  } catch (err) {
    log.error('Encryption failed: ' + err.message);
    return plaintext; // fallback to plaintext
  }
}

function decryptSecret(ciphertext) {
  if (!ciphertext || !ciphertext.includes(':')) return ciphertext; // already plaintext
  try {
    const [ivHex, ctHex, tagHex] = ciphertext.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const ct = Buffer.from(ctHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(MASTER_KEY, 'hex'), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (err) {
    log.error('Decryption failed: ' + err.message);
    return ciphertext; // fallback
  }
}

// ============================================================
// CRC-16/MODBUS
// ============================================================
const CRC_TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let j = 0; j < 8; j++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  CRC_TABLE[i] = crc;
}

function crc16(data) {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff];
  return crc;
}

function getCrc(data) {
  const c = crc16(data);
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(c, 0);
  return buf;
}

function addCrc(data) {
  return Buffer.concat([data, getCrc(data)]);
}

function verifyCrc(frame) {
  if (frame.length < 4) return false;
  const payload = frame.subarray(0, frame.length - 2);
  const expected = frame.subarray(frame.length - 2);
  const computed = getCrc(payload);
  return computed[0] === expected[0] && computed[1] === expected[1];
}

// ============================================================
// SOLARMAN V5 PROTOCOL
// ============================================================
const V5_START = 0xa5;
const V5_END = 0x15;

class SolarmanV5 {
  constructor(address, serial, options = {}) {
    this.address = address;
    this.serial = serial;
    this.port = options.port || 8899;
    this.mbSlaveId = options.mbSlaveId || 1;
    this.socketTimeout = (options.socketTimeout || 8) * 1000;
    this.autoReconnect = options.autoReconnect ?? false;
    this.socket = null;
    this.connected = false;
    this.sequenceNumber = null;
    this.lastFrame = Buffer.alloc(0);
    this.dataResolve = null;
    this.dataReject = null;
    this.dataWanted = false;
    this.v5Serial = Buffer.alloc(4);
    this.v5Serial.writeUInt32LE(this.serial, 0);
  }

  getNextSequenceNumber() {
    if (this.sequenceNumber === null) {
      this.sequenceNumber = Math.floor(Math.random() * 254) + 1;
    } else {
      this.sequenceNumber = (this.sequenceNumber + 1) & 0xff;
    }
    return this.sequenceNumber;
  }

  static calculateChecksum(data) {
    let checksum = 0;
    for (let i = 0; i < data.length; i++) checksum = (checksum + (data[i] & 0xff)) & 0xff;
    return checksum;
  }

  v5Header(length, control, seq) {
    const header = Buffer.alloc(11);
    header[0] = V5_START;
    header.writeUInt16LE(length, 1);
    header[3] = 0x10;
    header[4] = control;
    seq.copy(header, 5, 0, 2);
    this.v5Serial.copy(header, 7);
    return header;
  }

  v5Trailer(data) {
    const trailer = Buffer.alloc(2);
    trailer[0] = SolarmanV5.calculateChecksum(data.subarray(1));
    trailer[1] = V5_END;
    return trailer;
  }

  v5FrameEncoder(modbusFrame) {
    const length = 15 + modbusFrame.length;
    const seqNum = this.getNextSequenceNumber();
    const seq = Buffer.alloc(2);
    seq.writeUInt16LE(seqNum, 0);
    const header = this.v5Header(length, 0x45, seq);
    const payload = Buffer.concat([
      Buffer.from([0x02]),       // frame type
      Buffer.from([0x00, 0x00]), // sensor type
      Buffer.from([0x00, 0x00, 0x00, 0x00]), // delivery time
      Buffer.from([0x00, 0x00, 0x00, 0x00]), // power on time
      Buffer.from([0x00, 0x00, 0x00, 0x00]), // offset time
      modbusFrame,
    ]);
    const frame = Buffer.concat([header, payload]);
    return Buffer.concat([frame, this.v5Trailer(frame)]);
  }

  v5FrameDecoder(v5Frame) {
    if (v5Frame[0] !== V5_START || v5Frame[v5Frame.length - 1] !== V5_END) {
      throw new Error('V5 frame: invalid start/end');
    }
    const expectedChecksum = SolarmanV5.calculateChecksum(v5Frame.subarray(1, v5Frame.length - 2));
    if (v5Frame[v5Frame.length - 2] !== expectedChecksum) {
      throw new Error('V5 frame: invalid checksum');
    }
    if (v5Frame[5] !== this.sequenceNumber) {
      throw new Error('V5 frame: sequence number mismatch');
    }
    return v5Frame.subarray(25, v5Frame.length - 2);
  }

  v5TimeResponseFrame(frame) {
    const responseCode = frame[4] - 0x30;
    const seq = frame.subarray(5, 7);
    const header = this.v5Header(10, responseCode, seq);
    const payload = Buffer.alloc(10);
    payload.writeUInt16LE(0x0100, 0);
    payload.writeUInt32LE(Math.floor(Date.now() / 1000), 2);
    payload.writeUInt32LE(0, 6);
    const responseFrame = Buffer.concat([header, payload]);
    responseFrame[5] = (responseFrame[5] + 1) & 0xff;
    return Buffer.concat([responseFrame, this.v5Trailer(responseFrame)]);
  }

  receivedFrameIsValid(frame) {
    return frame[0] === V5_START && frame[5] === this.sequenceNumber;
  }

  handleProtocolFrame(frame) {
    const knownProtocolCodes = new Set([0x41, 0x42, 0x43, 0x47, 0x48]);
    if (frame[4] !== 0x45 && knownProtocolCodes.has(frame[4])) {
      const responseFrame = this.v5TimeResponseFrame(frame);
      if (this.socket && !this.socket.destroyed) this.socket.write(responseFrame);
      return false;
    }
    return true;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      socket.setTimeout(this.socketTimeout);
      const onError = (err) => { cleanup(); reject(err); };
      const onConnect = () => {
        cleanup();
        this.socket = socket;
        this.connected = true;
        this._setupListeners();
        resolve();
      };
      const cleanup = () => {
        socket.removeListener('error', onError);
        socket.removeListener('connect', onConnect);
      };
      socket.once('error', onError);
      socket.once('connect', onConnect);
      socket.connect(this.port, this.address);
    });
  }

  _setupListeners() {
    if (!this.socket) return;
    this.socket.on('data', (data) => {
      if (!this.receivedFrameIsValid(data)) return;
      if (!this.handleProtocolFrame(data)) return;
      if (this.dataWanted && this.dataResolve) {
        this.dataWanted = false;
        this.dataResolve(data);
        this.dataResolve = null;
        this.dataReject = null;
      }
    });
    this.socket.on('close', () => {
      this.connected = false;
      if (this.dataWanted && this.dataReject) {
        if (this.autoReconnect) {
          this.reconnect().then(() => {
            if (this.socket && this.lastFrame.length > 0) this.socket.write(this.lastFrame);
          }).catch((err) => {
            if (this.dataReject) { this.dataReject(err); this.dataResolve = null; this.dataReject = null; }
          });
        } else {
          this.dataReject(new Error('Connection closed'));
          this.dataResolve = null;
          this.dataReject = null;
        }
      }
    });
    this.socket.on('error', (err) => {
      if (this.dataWanted && this.dataReject) {
        this.dataReject(err);
        this.dataResolve = null;
        this.dataReject = null;
        this.dataWanted = false;
      }
    });
    this.socket.on('timeout', () => { this.socket?.destroy(); });
  }

  async reconnect() {
    try {
      if (this.socket) { this.socket.removeAllListeners(); this.socket.destroy(); this.socket = null; }
    } catch {}
    await this.connect();
  }

  async disconnect() {
    this.dataWanted = false;
    return new Promise((resolve) => {
      if (!this.socket) { resolve(); return; }
      this.socket.removeAllListeners();
      const onClose = () => { this.socket = null; this.connected = false; resolve(); };
      this.socket.once('close', onClose);
      try {
        this.socket.end();
        setTimeout(() => { if (this.socket) { this.socket.destroy(); this.socket = null; this.connected = false; } resolve(); }, 500);
      } catch { this.socket = null; this.connected = false; resolve(); }
    });
  }

  async sendReceiveFrame(frame) {
    if (!this.socket || this.socket.destroyed) throw new Error('Not connected');
    this.lastFrame = frame;
    this.dataWanted = true;
    return new Promise((resolve, reject) => {
      this.dataResolve = resolve;
      this.dataReject = reject;
      const timeout = setTimeout(() => {
        this.dataWanted = false;
        this.dataResolve = null;
        this.dataReject = null;
        reject(new Error('Timeout waiting for response'));
      }, this.socketTimeout);
      const origResolve = this.dataResolve;
      const origReject = this.dataReject;
      this.dataResolve = (data) => { clearTimeout(timeout); origResolve(data); };
      this.dataReject = (err) => { clearTimeout(timeout); origReject(err); };
      this.socket.write(frame);
    });
  }

  async readHoldingRegisters(registerAddr, quantity) {
    const mbRequest = Buffer.alloc(6);
    mbRequest[0] = this.mbSlaveId;
    mbRequest[1] = 0x03;
    mbRequest.writeUInt16BE(registerAddr, 2);
    mbRequest.writeUInt16BE(quantity, 4);
    const fullMbRequest = addCrc(mbRequest);

    const v5Request = this.v5FrameEncoder(fullMbRequest);
    const v5Response = await this.sendReceiveFrame(v5Request);
    const mbResponse = this.v5FrameDecoder(v5Response);

    // Handle double CRC
    let finalResponse = mbResponse;
    if (mbResponse.length >= 4) {
      const lastTwo = mbResponse.subarray(mbResponse.length - 2);
      if (lastTwo[0] === 0x00 && lastTwo[1] === 0x00) {
        const stripped = mbResponse.subarray(0, mbResponse.length - 2);
        const strippedPayload = stripped.subarray(0, stripped.length - 2);
        const computedCrc = getCrc(strippedPayload);
        const strippedCrc = stripped.subarray(stripped.length - 2);
        if (computedCrc[0] === strippedCrc[0] && computedCrc[1] === strippedCrc[1]) {
          finalResponse = stripped;
        }
      }
    }

    // Parse response
    if (finalResponse[1] === 0x03 + 0x80) {
      throw new Error('Modbus exception: ' + finalResponse[2]);
    }
    if (!verifyCrc(finalResponse)) {
      throw new Error('Modbus CRC verification failed');
    }
    const byteCount = finalResponse[2];
    const values = [];
    for (let i = 0; i < byteCount / 2; i++) {
      values.push(finalResponse.readUInt16BE(3 + i * 2));
    }
    return values;
  }
}

// ============================================================
// TUYA CLOUD API
// ============================================================
function tuyaSign(method, path, bodyStr, token, accessId, accessKey) {
  const t = Date.now().toString();
  const nonce = 'req_' + t;
  const contentSHA256 = crypto.createHash('sha256').update(bodyStr || '').digest('hex');
  const headers = 'client_id:' + accessId + '\n';
  const stringToSign = [method, contentSHA256, headers, path].join('\n');
  const signString = [accessId, token || '', t, nonce, stringToSign].join('');
  const sign = crypto.createHmac('sha256', accessKey).update(signString).digest('hex').toUpperCase();
  return { sign, t, nonce, contentSHA256 };
}

function tuyaRequest(method, urlPath, body, token, cfg) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const { sign, t, nonce } = tuyaSign(method, urlPath, bodyStr, token, cfg.accessId, cfg.accessKey);
    const headers = {
      'client_id': cfg.accessId,
      'sign': sign,
      'sign_method': 'HMAC-SHA256',
      't': t,
      'nonce': nonce,
      'Signature-Headers': 'client_id',
    };
    if (token) headers['access_token'] = token;
    if (bodyStr) headers['Content-Type'] = 'application/json';

    const tuyaApiBase = (cfg.tuya && cfg.tuya.apiBase) || 'https://openapi.tuyaeu.com';
    const url = new URL(tuyaApiBase + urlPath);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: method,
      headers: headers,
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON from Tuya: ' + data.substring(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Tuya request timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ============================================================
// INVERTER DATA
// ============================================================
let inverter = null;
let _pollingInverter = false;
let _inverterConsecutiveFails = 0;
let inverterData = {
  gridPower: false,
  gridRaw: 0,
  gridVoltage: 0,
  batterySOC: 0,
  pvPower: 0,
  pvPower2: 0,
  loadPower: 0,
  batteryPower: 0,
  batteryTemp: 0,
  envTemp: 0,
  dayPV: 0,
  dayGridImport: 0,
  dayGridExport: 0,
  dayBatCharge: 0,
  dayBatDischarge: 0,
  dayLoadEnergy: 0,
  lastUpdate: null,
  debug: {},
};

async function connectToInverter() {
  const cfg = await loadConfig();
  const inv = cfg.inverter || {};
  try {
    if (inverter && inverter.connected) return true;
    if (inverter) try { await inverter.disconnect(); } catch {}
    inverter = new SolarmanV5(
      inv.ip,
      inv.serial,
      { port: inv.port || 8899, autoReconnect: true }
    );
    await inverter.connect();
    log.info('Connected to inverter at ' + inv.ip);
    return true;
  } catch (err) {
    log.error('Failed to connect to inverter: ' + err.message);
    return false;
  }
}

let costState = { dateKey: '', dayKwh: 0, nightKwh: 0, lastImport: 0 };
let dailyRecords = [];
let demoGridImport = 2.0;

async function loadDailyRecords() {
  try { dailyRecords = JSON.parse(await fs.promises.readFile(DAILY_FILE, 'utf8')); } catch { dailyRecords = []; }
}

async function saveDailyRecords() {
  try {
    if (dailyRecords.length > 365) dailyRecords = dailyRecords.slice(-365);
    await fs.promises.writeFile(DAILY_FILE, JSON.stringify(dailyRecords, null, 2), { mode: 0o600 });
  } catch {}
}

function finalizeDay() {
  if (costState.dayKwh === 0 && costState.nightKwh === 0) return;
  dailyRecords.push({
    date: costState.dateKey,
    dayKwh: Math.round(costState.dayKwh * 100) / 100,
    nightKwh: Math.round(costState.nightKwh * 100) / 100
  });
  saveDailyRecords();
  costState.dayKwh = 0;
  costState.nightKwh = 0;
}

function minutesOfDay(str, fallback) {
  if (!str) return fallback;
  const parts = str.split(':');
  const h = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return fallback;
  return h * 60 + m;
}

function isDayTariff(tariff) {
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const dayStart = minutesOfDay(tariff.dayStart, 7 * 60);
  const nightStart = minutesOfDay(tariff.nightStart, 23 * 60);
  if (dayStart < nightStart) return cur >= dayStart && cur < nightStart;
  return cur >= dayStart || cur < nightStart;
}

async function updateCostTracking() {
  try {
    const cfg = await loadConfig();
    const tariff = cfg.tariff || {};
    const todayKey = new Date().toISOString().slice(0, 10);
    const imported = inverterData.dayGridImport || 0;
    const now = Date.now();
    if (costState.dateKey !== todayKey) {
      finalizeDay();
      costState = { dateKey: todayKey, dayKwh: 0, nightKwh: 0, lastImport: imported, lastTs: now };
      return;
    }
    if (tariff.type === 'flat') {
      costState.dayKwh = imported;
      costState.nightKwh = 0;
    } else {
      if (imported > 0 && imported < costState.lastImport) {
        costState.dayKwh = 0;
        costState.nightKwh = 0;
      }
      const delta = imported - costState.lastImport;
      if (delta > 0) {
        if (isDayTariff(tariff)) costState.dayKwh += delta;
        else costState.nightKwh += delta;
      }
      costState.lastImport = imported;
    }
  } catch (err) {
    log.error('Cost tracking update failed: ' + err.message);
  }
}

function injectDemoData() {
  const t = new Date();
  const hr = t.getHours();
  const pv = Math.max(0, Math.round(Math.sin(hr / 24 * Math.PI) * 2200 + (Math.random() - 0.5) * 300));
  const load = Math.round(400 + Math.sin(hr / 24 * Math.PI * 2) * 200 + (Math.random() - 0.5) * 100);
  const soc = 45 + Math.round(Math.sin(t.getTime() / 300000) * 30);
  const bp = pv > load + 200 ? -(pv - load - 200) : (load > pv + 100 ? Math.min(load - pv, 500) : 0);
  inverterData.gridPower = pv + Math.max(0, bp) < load - 100;
  inverterData.gridVoltage = inverterData.gridPower ? 230 : 0;
  inverterData.batterySOC = Math.max(0, Math.min(100, soc));
  inverterData.pvPower = pv;
  inverterData.pvPower2 = Math.round(pv * 0.1);
  inverterData.loadPower = load;
  inverterData.batteryPower = bp;
  inverterData.batteryTemp = 22 + Math.random() * 3;
  inverterData.envTemp = 18 + Math.random() * 5;
  inverterData.dayPV = pv > 0 ? 2.4 + Math.random() * 1.2 : 0;
  demoGridImport += 0.05 + Math.random() * 0.1;
  inverterData.dayGridImport = Math.round(demoGridImport * 10) / 10;
  inverterData.dayGridExport = !inverterData.gridPower && pv > load ? 0.2 + Math.random() * 0.3 : 0;
  inverterData.dayBatCharge = bp < 0 ? 0.8 + Math.random() * 0.4 : 0;
  inverterData.dayBatDischarge = bp > 0 ? 0.6 + Math.random() * 0.3 : 0;
  inverterData.dayLoadEnergy = 3.5 + Math.random() * 1.0;
  inverterData.lastUpdate = new Date();
  log.info('Demo mode: injecting simulated inverter data (pv=' + pv + 'W load=' + load + 'W soc=' + soc + '%)');
}

async function pollInverter() {
  if (_pollingInverter) return;
  _pollingInverter = true;
  try {
    if (!inverter || !inverter.connected) {
      const connected = await connectToInverter();
      if (!connected) {
        _inverterConsecutiveFails++;
        if (!inverterData.lastUpdate) injectDemoData();
        if (!inverterData.lastUpdate) return;
      }
    }

    const d1 = await inverter.readHoldingRegisters(0x0030, 65);
    const d2 = await inverter.readHoldingRegisters(0x0096, 100);
    const r = (off) => off < 0x0096 ? d1[off - 0x0030] : d2[off - 0x0096];

    function u16(v) { return (v && v > 0 && v < 65535) ? v : 0; }
    function i16(v) { if (!v || v >= 65535) return 0; return v > 32767 ? v - 65536 : v; }
    function u32(lo, hi) { return ((u16(hi) << 16) | u16(lo)); }
    function f16(v, m) { v = u16(v); return v ? Math.round(v * m * 10) / 10 : 0; }
    function temp16(v, m) { v = u16(v); return v ? Math.round((v * (m || 0.1) - 100) * 10) / 10 : 0; }

    const gridStatus = r(0x00C2);
    inverterData.gridPower = gridStatus === 1;
    inverterData.gridVoltage = f16(r(0x0096), 0.1);
    inverterData.gridRaw = r(0x0040);
    inverterData.batterySOC = r(0x00B8) || r(0x00A4) || 0;
    inverterData.pvPower = u16(r(0x00BA));
    inverterData.pvPower2 = u16(r(0x00BB));
    inverterData.loadPower = u16(r(0x00B2));
    inverterData.batteryPower = i16(r(0x00BE));
    inverterData.batteryTemp = temp16(r(0x00B6));
    inverterData.envTemp = temp16(r(0x005F));
    inverterData.dayPV = f16(r(0x006C), 0.1);
    inverterData.dayGridImport = f16(r(0x004C), 0.1);
    inverterData.dayGridExport = f16(r(0x004D), 0.1);
    inverterData.dayBatCharge = f16(r(0x0046), 0.1);
    inverterData.dayBatDischarge = f16(r(0x0047), 0.1);
    inverterData.dayLoadEnergy = f16(r(0x0054), 0.1);
    inverterData.lastUpdate = new Date();
    updateCostTracking();

    const dk = {};
    dk.overallState = u16(r(0x003B));
    dk.dayActiveEnergy = f16(r(0x003C), 0.1);
    dk.monthPV = f16(r(0x0041), 0.1);
    dk.monthLoad = f16(r(0x0042), 0.1);
    dk.monthGrid = f16(r(0x0043), 0.1);
    dk.dayBatCharge = f16(r(0x0046), 0.1);
    dk.dayBatDischarge = f16(r(0x0047), 0.1);
    dk.totalBatCharge = Math.round(u32(r(0x0048), r(0x0049)) * 0.1 * 10) / 10;
    dk.totalBatDischarge = Math.round(u32(r(0x004A), r(0x004B)) * 0.1 * 10) / 10;
    dk.dayGridImport = f16(r(0x004C), 0.1);
    dk.dayGridExport = f16(r(0x004D), 0.1);
    dk.gridFreq = f16(r(0x004F), 0.01);
    dk.totalGridExport = Math.round(u32(r(0x0051), r(0x0052)) * 0.1 * 10) / 10;
    dk.dayLoadEnergy = f16(r(0x0054), 0.1);
    dk.totalLoadEnergy = Math.round(u32(r(0x0055), r(0x0056)) * 0.1 * 10) / 10;
    dk.dcTransfTemp = temp16(r(0x005A));
    dk.radiatorTemp = temp16(r(0x005B));
    dk.envTemp = temp16(r(0x005F));
    dk.totalPV = Math.round(u32(r(0x0060), r(0x0061)) * 0.1 * 10) / 10;
    dk.yearGridExport = Math.round(u32(r(0x0062), r(0x0063)) * 0.1 * 10) / 10;
    dk.fault1 = u16(r(0x0067));
    dk.fault2 = u16(r(0x0068));
    dk.fault3 = u16(r(0x0069));
    dk.fault4 = u16(r(0x006A));
    dk.dayPV = f16(r(0x006C), 0.1);
    dk.pv1Voltage = f16(r(0x006D), 0.1);
    dk.pv1Current = f16(r(0x006E), 0.1);
    dk.pv2Voltage = f16(r(0x006F), 0.1);
    dk.gridVoltage = f16(r(0x0096), 0.1);
    dk.inverterVoltage = f16(r(0x009A), 0.1);
    dk.gridCurrent1 = i16(r(0x00A0));
    dk.gridCurrent2 = i16(r(0x00A1));
    dk.inverterCurrent = f16(r(0x00A4), 0.01);
    dk.auxPower = i16(r(0x00A6));
    dk.gridL1Power = i16(r(0x00A7));
    dk.gridPower = i16(r(0x00A9));
    dk.gridCTPower = i16(r(0x00AC));
    dk.inverterPower = i16(r(0x00AF));
    dk.loadPower = u16(r(0x00B2));
    dk.offGridMode = u16(r(0x00B3));
    dk.batteryTemp = temp16(r(0x00B6));
    dk.batteryVoltage = f16(r(0x00B7), 0.01);
    dk.batterySOC = u16(r(0x00B8));
    dk.pv1Power = u16(r(0x00BA));
    dk.pv2Power = u16(r(0x00BB));
    dk.batteryPower = i16(r(0x00BE));
    dk.batteryCurrent = f16(r(0x00BF), 0.01);
    dk.loadFreq = f16(r(0x00C0), 0.01);
    dk.inverterFreq = f16(r(0x00C1), 0.01);
    dk.gridConnected = u16(r(0x00C2));
    dk.controlMode = u16(r(0x00C8));
    dk.batteryEqVoltage = f16(r(0x00C9), 0.01);
    dk.batteryAbsVoltage = f16(r(0x00CA), 0.01);
    dk.batteryFloatVoltage = f16(r(0x00CB), 0.01);
    dk.upsDelayTime = u16(r(0x00D1));
    dk.batMaxChargeCurrent = u16(r(0x00D2));
    dk.batMaxDischargeCurrent = u16(r(0x00D3));
    dk.batShutdownSOC = u16(r(0x00D9));
    dk.batRestartSOC = u16(r(0x00DA));
    dk.batLowSOC = u16(r(0x00DB));
    dk.batShutdownVoltage = f16(r(0x00DC), 0.01);
    dk.batRestartVoltage = f16(r(0x00DD), 0.01);
    dk.batLowVoltage = f16(r(0x00DE), 0.01);
    dk.remoteConfig = u16(r(0x00E4));
    dk.batteryManuf = u16(r(0x00E5));
    dk.gridChargeEnabled = u16(r(0x00E6));
    dk.gridChargeCurrent = u16(r(0x00E8));
    dk.gridChargeStartVoltage = f16(r(0x00DE), 0.01);
    dk.trackGridPhase = u16(r(0x00EB));
    dk.priorityLoad = u16(r(0x00F3));
    dk.loadLimit = u16(r(0x00F4));
    dk.maxSellPower = u16(r(0x00F5));
    dk.solarExport = u16(r(0x00F7));
    dk.useTimer = u16(r(0x00F8));
    dk.totalGridImport = Math.round(u32(r(0x004E), r(0x0050)) * 0.1 * 10) / 10;

    inverterData.debug = dk;
    inverterData.totalGridImport = dk.totalGridImport;
    inverterData.totalLoadEnergy = dk.totalLoadEnergy;
    _inverterConsecutiveFails = 0;

    log.info('grid=' + inverterData.gridPower + ' soc=' + inverterData.batterySOC +
      '% pv=' + inverterData.pvPower + 'W load=' + inverterData.loadPower + 'W bat=' + inverterData.batteryPower + 'W');
  } catch (err) {
    _inverterConsecutiveFails++;
    log.error('Inverter poll failed: ' + err.message);
  } finally {
    _pollingInverter = false;
  }
}

// ============================================================
// RRD-STYLE HISTORY STORAGE (ring buffers, pre-aggregated)
// ============================================================
const RRD_POWER = { '1m': [], '15m': [], '1h': [] };
const RRD_SOCKET = { '1m': [], '15m': [], '1h': [] };
const RRD_PENDING = [];
const RRD_SOCKET_PENDING = [];
const RRD_SIZE = { '1m': 1440, '15m': 672, '1h': 8760 };
const RRD_INTERVAL = { '1m': 60000, '15m': 900000, '1h': 3600000 };
let lastRrdFlush = 0;
const RRD_FLUSH_MS = 300000; // flush to SD every 5 min

async function rrdInit() {
  let migrated = false;
  for (const level of ['1m', '15m', '1h']) {
    try { RRD_POWER[level] = JSON.parse(await fs.promises.readFile(DATA_DIR + '/history_' + level + '.json', 'utf8')); } catch { RRD_POWER[level] = []; }
    try { RRD_SOCKET[level] = JSON.parse(await fs.promises.readFile(DATA_DIR + '/sockets_' + level + '.json', 'utf8')); } catch { RRD_SOCKET[level] = []; }
  }
  // One-time migration from old single-file format
  if (RRD_POWER['1m'].length === 0 && RRD_POWER['15m'].length === 0) {
    try {
      const old = JSON.parse(await fs.promises.readFile(HISTORY_FILE, 'utf8'));
      if (old && old.points && old.points.length) {
        log.info('Migrating history.json → RRD format (' + old.points.length + ' points)');
        RRD_POWER['1m'] = old.points;
        if (RRD_POWER['1m'].length > RRD_SIZE['1m']) RRD_POWER['1m'].splice(0, RRD_POWER['1m'].length - RRD_SIZE['1m']);
        rrdMergeM15();
        rrdMergeM1h();
        log.info('Migration complete: 1m=' + RRD_POWER['1m'].length + ' 15m=' + RRD_POWER['15m'].length + ' 1h=' + RRD_POWER['1h'].length);
        migrated = true;
      }
    } catch {}
    try {
      const oldS = JSON.parse(await fs.promises.readFile(SOCKETS_FILE, 'utf8'));
      if (oldS && oldS.points && oldS.points.length) {
        log.info('Migrating sockets.json → RRD format (' + oldS.points.length + ' points)');
        RRD_SOCKET['1m'] = oldS.points;
        if (RRD_SOCKET['1m'].length > RRD_SIZE['1m']) RRD_SOCKET['1m'].splice(0, RRD_SOCKET['1m'].length - RRD_SIZE['1m']);
        migrated = true;
      }
    } catch {}
  }
  // Write migrated data immediately
  if (migrated) {
    for (const level of ['1m', '15m', '1h']) {
      await fs.promises.writeFile(DATA_DIR + '/history_' + level + '.json', JSON.stringify(RRD_POWER[level]), { mode: 0o600 });
      await fs.promises.writeFile(DATA_DIR + '/sockets_' + level + '.json', JSON.stringify(RRD_SOCKET[level]), { mode: 0o600 });
    }
  }
  // One-time socket aggregation if 15m/1h are empty but 1m has data
  if (RRD_SOCKET['1m'].length > 0 && RRD_SOCKET['15m'].length === 0) {
    rrdSocketMergeM15();
    rrdSocketMergeM1h();
    for (const level of ['15m', '1h']) {
      await fs.promises.writeFile(DATA_DIR + '/sockets_' + level + '.json', JSON.stringify(RRD_SOCKET[level]), { mode: 0o600 });
    }
  }
}

function rrdAvg(arr) {
  if (!arr.length) return 0;
  let sum = 0;
  for (const v of arr) sum += v;
  return Math.round(sum / arr.length * 10) / 10;
}

function rrdPush(buf, entry, maxSize) {
  if (buf.length < maxSize) {
    buf.push(entry);
  } else {
    const oldestTs = buf[0].ts;
    const newestTs = buf[buf.length - 1].ts;
    const interval = newestTs - oldestTs < 2 * maxSize * 60000 ? 1 : 0; // heuristic
    const slot = interval > 0 ? Math.floor((entry.ts - oldestTs) / 60000) : -1;
    if (slot >= 0 && slot < maxSize && entry.ts - buf[slot].ts < 120000) {
      buf[slot] = entry; // replace same slot
    } else {
      buf.push(entry);
      buf.splice(0, Math.max(1, buf.length - maxSize));
    }
  }
}

function rrdMerge1m(rawPoints) {
  if (!rawPoints.length) return [];
  const buckets = new Map();
  for (const p of rawPoints) {
    const key = Math.floor(p.ts / 60000) * 60000;
    if (!buckets.has(key)) buckets.set(key, { ts: key, grid: [], soc: [], load: [], bat: [], pv: [], otherLoad: [] });
    const b = buckets.get(key);
    b.grid.push(p.grid ? 1 : 0);
    b.soc.push(p.soc);
    b.load.push(p.load);
    b.bat.push(p.bat);
    b.pv.push(p.pv);
    b.otherLoad.push(p.otherLoad || 0);
  }
  return [...buckets.values()].map(b => ({
    ts: b.ts,
    grid: b.grid.reduce((a, v) => a + v, 0) / b.grid.length >= 0.5,
    soc: rrdAvg(b.soc),
    load: rrdAvg(b.load),
    bat: rrdAvg(b.bat),
    pv: rrdAvg(b.pv),
    otherLoad: rrdAvg(b.otherLoad),
  }));
}

function rrdMergeM15() {
  const m1 = RRD_POWER['1m'];
  const m15 = RRD_POWER['15m'];
  const newestM15 = m15.length ? m15[m15.length - 1].ts : 0;
  const buckets = new Map();
  for (const p of m1) {
    if (p.ts <= newestM15) continue;
    const key = Math.floor(p.ts / 900000) * 900000;
    if (!buckets.has(key)) buckets.set(key, { ts: key, grid: 0, soc: [], load: [], bat: [], pv: [], otherLoad: [], count: 0 });
    const b = buckets.get(key);
    b.grid += p.grid ? 1 : 0;
    b.soc.push(p.soc);
    b.load.push(p.load);
    b.bat.push(p.bat);
    b.pv.push(p.pv);
    b.otherLoad.push(p.otherLoad || 0);
    b.count++;
  }
  for (const b of buckets.values()) {
    rrdPush(m15, {
      ts: b.ts,
      grid: b.grid / b.count >= 0.5,
      soc: rrdAvg(b.soc),
      load: rrdAvg(b.load),
      bat: rrdAvg(b.bat),
      pv: rrdAvg(b.pv),
      otherLoad: rrdAvg(b.otherLoad),
    }, RRD_SIZE['15m']);
  }
}

function rrdMergeM1h() {
  const m15 = RRD_POWER['15m'];
  const m1h = RRD_POWER['1h'];
  const newestM1h = m1h.length ? m1h[m1h.length - 1].ts : 0;
  const buckets = new Map();
  for (const p of m15) {
    if (p.ts <= newestM1h) continue;
    const key = Math.floor(p.ts / 3600000) * 3600000;
    if (!buckets.has(key)) buckets.set(key, { ts: key, grid: 0, soc: [], load: [], bat: [], pv: [], otherLoad: [], count: 0 });
    const b = buckets.get(key);
    b.grid += p.grid ? 1 : 0;
    b.soc.push(p.soc);
    b.load.push(p.load);
    b.bat.push(p.bat);
    b.pv.push(p.pv);
    b.otherLoad.push(p.otherLoad || 0);
    b.count++;
  }
  for (const b of buckets.values()) {
    rrdPush(m1h, {
      ts: b.ts,
      grid: b.grid / b.count >= 0.5,
      soc: rrdAvg(b.soc),
      load: rrdAvg(b.load),
      bat: rrdAvg(b.bat),
      pv: rrdAvg(b.pv),
      otherLoad: rrdAvg(b.otherLoad),
    }, RRD_SIZE['1h']);
  }
}

function rrdSocketMergeM15() {
  const m1 = RRD_SOCKET['1m'];
  const m15 = RRD_SOCKET['15m'];
  const newestM15 = m15.length ? m15[m15.length - 1].ts : 0;
  const buckets = new Map();
  for (const p of m1) {
    if (p.ts <= newestM15) continue;
    const key = Math.floor(p.ts / 900000) * 900000;
    if (!buckets.has(key)) buckets.set(key, { ts: key, devices: {}, count: 0 });
    const b = buckets.get(key);
    for (const [id, val] of Object.entries(p.devices || {})) {
      if (!b.devices[id]) b.devices[id] = [];
      b.devices[id].push(val);
    }
    b.count++;
  }
  for (const b of buckets.values()) {
    const entry = { ts: b.ts, devices: {} };
    for (const [id, arr] of Object.entries(b.devices)) {
      entry.devices[id] = rrdAvg(arr);
    }
    rrdPush(m15, entry, RRD_SIZE['15m']);
  }
}

function rrdSocketMergeM1h() {
  const m15 = RRD_SOCKET['15m'];
  const m1h = RRD_SOCKET['1h'];
  const newestM1h = m1h.length ? m1h[m1h.length - 1].ts : 0;
  const buckets = new Map();
  for (const p of m15) {
    if (p.ts <= newestM1h) continue;
    const key = Math.floor(p.ts / 3600000) * 3600000;
    if (!buckets.has(key)) buckets.set(key, { ts: key, devices: {}, count: 0 });
    const b = buckets.get(key);
    for (const [id, val] of Object.entries(p.devices || {})) {
      if (!b.devices[id]) b.devices[id] = [];
      b.devices[id].push(val);
    }
    b.count++;
  }
  for (const b of buckets.values()) {
    const entry = { ts: b.ts, devices: {} };
    for (const [id, arr] of Object.entries(b.devices)) {
      entry.devices[id] = rrdAvg(arr);
    }
    rrdPush(m1h, entry, RRD_SIZE['1h']);
  }
}

async function rrdFlush() {
  const now = Date.now();
  if (now - lastRrdFlush < RRD_FLUSH_MS) return;
  lastRrdFlush = now;
  try {
    // 1. Merge pending power points into 1m buffer
    const m1Merged = rrdMerge1m(RRD_PENDING);
    for (const p of m1Merged) rrdPush(RRD_POWER['1m'], p, RRD_SIZE['1m']);
    RRD_PENDING.length = 0;

    // 2. Merge pending socket points
    const sockBuckets = new Map();
    for (const p of RRD_SOCKET_PENDING) {
      const key = Math.floor(p.ts / 60000) * 60000;
      if (!sockBuckets.has(key)) sockBuckets.set(key, { ts: key, devices: {} });
      const b = sockBuckets.get(key);
      for (const [id, val] of Object.entries(p.devices || {})) {
        if (!b.devices[id]) b.devices[id] = [];
        b.devices[id].push(val);
      }
    }
    for (const b of sockBuckets.values()) {
      const entry = { ts: b.ts, devices: {} };
      for (const [id, arr] of Object.entries(b.devices)) {
        entry.devices[id] = rrdAvg(arr);
      }
      rrdPush(RRD_SOCKET['1m'], entry, RRD_SIZE['1m']);
    }
    RRD_SOCKET_PENDING.length = 0;

    // 3. Aggregate 1m → 15m
    rrdMergeM15();

    // 4. Aggregate 15m → 1h
    rrdMergeM1h();

    // 5. Aggregate socket 1m → 15m
    rrdSocketMergeM15();

    // 6. Aggregate socket 15m → 1h
    rrdSocketMergeM1h();

    // 7. Write all 6 files to disk
    for (const level of ['1m', '15m', '1h']) {
      await fs.promises.writeFile(DATA_DIR + '/history_' + level + '.json', JSON.stringify(RRD_POWER[level]), { mode: 0o600 });
      await fs.promises.writeFile(DATA_DIR + '/sockets_' + level + '.json', JSON.stringify(RRD_SOCKET[level]), { mode: 0o600 });
    }
  } catch (err) {
    log.error('RRD flush failed: ' + err.message);
  }
}

function rrdGetPower(level, cutoffMs) {
  const buf = RRD_POWER[level];
  const cutoff = Date.now() - cutoffMs;
  return buf.filter(p => p.ts > cutoff);
}

function rrdGetSocket(level, cutoffMs) {
  const buf = RRD_SOCKET[level];
  const cutoff = Date.now() - cutoffMs;
  return buf.filter(p => p.ts > cutoff);
}

function rrdPickLevel(period) {
  if (period === 'week') return '15m';
  if (period === 'month' || period === 'year') return '1h';
  return '1m'; // day, 1h, 3h, 6h, 12h
}

// ============================================================
// TUYA DEVICE MANAGEMENT
// ============================================================
let tuyaDevices = [];
let tuyaToken = null;
let tuyaTokenExpire = 0;
let tuyaUid = null;

function saveDevices() {
  try {
    const clean = tuyaDevices.map(d => ({ id: d.id, name: d.name, ip: d.ip || '', online: d.online || false, switch: d.switch, power: d.power || 0, voltage: d.voltage || 0, current: d.current || 0 }));
    fs.writeFileSync(DEVICES_FILE, JSON.stringify(clean, null, 2), { mode: 0o600 });
  } catch (err) { log.error('Failed to save devices: ' + err.message); }
}

function loadDevicesFromDisk() {
  try {
    if (fs.existsSync(DEVICES_FILE)) {
      const data = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
      if (Array.isArray(data) && data.length) {
        tuyaDevices = data;
        log.info('Loaded ' + data.length + ' devices from disk');
        return true;
      }
    }
  } catch (err) { log.error('Failed to load devices from disk: ' + err.message); }
  return false;
}

async function getTuyaToken() {
  const cfg = await loadConfig();
  const tc = cfg.tuya || {};
  const decryptedPassword = decryptSecret(tc.password || '');
  const endpoints = [
    { path: '/v1.0/iot-03/users/login', body: { username: tc.username, password: crypto.createHash('sha256').update(decryptedPassword || '').digest('hex') } },
    { path: '/v1.0/iot-01/associated-users/actions/authorized-login', body: { country_code: tc.countryCode || 48, username: tc.username, password: crypto.createHash('md5').update(decryptedPassword || '').digest('hex'), schema: tc.appSchema || 'tuyaSmart' } },
  ];
  for (const ep of endpoints) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt));
        const result = await tuyaRequest('POST', ep.path, ep.body, null, tc);
        if (result.success) {
          tuyaToken = result.result.access_token;
          tuyaTokenExpire = Date.now() + (result.result.expire_time - 60) * 1000;
          tuyaUid = result.result.uid;
          log.info('Tuya token obtained via ' + ep.path);
          return;
        }
        if (result.code !== 501) {
          log.error('getTuyaToken failed: ' + result.msg + ' (code: ' + result.code + ')');
          break;
        }
        log.warn('Tuya 501 on ' + ep.path + ', retry ' + (attempt + 1));
      } catch (err) {
        log.error('getTuyaToken error: ' + err.message);
        break;
      }
    }
  }
}

async function getTuyaTokenForControl() {
  if (tuyaToken && Date.now() < tuyaTokenExpire) return tuyaToken;
  await getTuyaToken();
  return tuyaToken;
}

async function syncDeviceNamesFromCloud() {
  const cfg = await loadConfig();
  const tc = cfg.tuya || {};
  try {
    if (!tuyaToken || !tuyaUid) await getTuyaToken();
    if (!tuyaUid) return;

    const result = await tuyaRequest('GET', '/v1.0/users/' + tuyaUid + '/devices', null, tuyaToken, tc);
    if (result.success && Array.isArray(result.result)) {
      const cloudDevices = result.result;
      for (const localDev of tuyaDevices) {
        const cloudDev = cloudDevices.find(d => d.id === localDev.id);
        if (cloudDev) {
          if (localDev.name.startsWith('Local-') || !localDev.name) {
            localDev.name = cloudDev.name || localDev.name;
          }
          localDev.online = cloudDev.online || false;
          if (cloudDev.ip) localDev.ip = cloudDev.ip;
        }
      }
      // Add new devices from cloud
      let addedCount = 0;
      for (const cloudDev of cloudDevices) {
        if (!tuyaDevices.some(d => d.id === cloudDev.id)) {
          tuyaDevices.push({
            id: cloudDev.id,
            name: cloudDev.name || ('Device ' + cloudDev.id.slice(-6)),
            ip: cloudDev.ip || '',
            online: cloudDev.online || false,
            switch: null,
          });
          addedCount++;
        }
      }
      if (addedCount > 0) log.info('Added ' + addedCount + ' new device(s) from Tuya cloud');
      log.info('Synced ' + cloudDevices.length + ' device names from cloud');
      saveDevices();
    }
  } catch (err) {
    log.error('Failed to sync device names: ' + err.message);
  }
}

async function fetchDeviceStatuses() {
  const cfg = await loadConfig();
  const tc = cfg.tuya || {};
  try {
    if (!tuyaToken || !tuyaUid) await getTuyaToken();
    if (!tuyaUid || !tuyaDevices.length) return;

    for (const dev of tuyaDevices) {
      try {
        const result = await tuyaRequest('GET', '/v1.0/devices/' + dev.id + '/status', null, tuyaToken, tc);
        if (result.success && Array.isArray(result.result)) {
          const switchStatus = result.result.find(s => s.code === 'switch_1');
          if (switchStatus) dev.switch = switchStatus.value;
          const powerDP = result.result.find(s => s.code === 'cur_power');
          if (powerDP) dev.power = typeof powerDP.value === 'number' ? Math.round(powerDP.value / 10 * 10) / 10 : (parseFloat(powerDP.value) / 10 || 0);
          const voltDP = result.result.find(s => s.code === 'cur_voltage');
          if (voltDP) dev.voltage = typeof voltDP.value === 'number' ? Math.round(voltDP.value / 10 * 10) / 10 : (parseFloat(voltDP.value) / 10 || 0);
          const curDP = result.result.find(s => s.code === 'cur_current');
          if (curDP) dev.current = typeof curDP.value === 'number' ? curDP.value : (parseFloat(curDP.value) || 0);
        }
      } catch (err) {
        log.error('Failed to fetch status for ' + dev.id + ': ' + err.message);
      }
    }
    log.info('Device statuses fetched');
    saveDevices();
  } catch (err) {
    log.error('fetchDeviceStatuses error: ' + err.message);
  }
}

async function controlDevice(deviceId, value) {
  const device = tuyaDevices.find(d => d.id === deviceId);
  if (!device) throw new Error('Device not found: ' + deviceId);
  const token = await getTuyaTokenForControl();
  if (!token) throw new Error('Failed to get Tuya token');
  const cfg = await loadConfig();
  const tc = cfg.tuya || {};

  const body = { commands: [{ code: 'switch_1', value: value }] };
  const result = await tuyaRequest('POST', '/v1.0/devices/' + deviceId + '/commands', body, token, tc);
  if (result.success) {
    device.switch = value;
    saveDevices();
    log.info(device.name + ' set to ' + (value ? 'ON' : 'OFF'));
  } else {
    throw new Error(result.msg || 'Tuya control failed');
  }
}

async function initTuya() {
  const hadCloud = tuyaDevices.length > 0;
  await syncDeviceNamesFromCloud();
  if (!hadCloud && !tuyaDevices.length) {
    loadDevicesFromDisk();
  }
  await fetchDeviceStatuses();
}

// ============================================================
// CONFIG SYSTEM
// ============================================================
async function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(await fs.promises.readFile(CONFIG_FILE, 'utf8'));
      // Decrypt Tuya password if encrypted
      if (cfg.tuya && cfg.tuya.password && cfg.tuya.password.includes(':')) {
        cfg.tuya.password = decryptSecret(cfg.tuya.password);
      }
      return cfg;
    }
  } catch (err) {
    log.error('Failed to load config: ' + err.message);
  }
  return {
    inverter: { ip: '', serial: '', port: 8899 },
    tuya: { accessId: '', accessKey: '', countryCode: 48, username: '', password: '', appSchema: 'tuyaSmart' },
    webPort: 8583,
    notifications: { notifEnabled: true, ntfyEnabled: true, ntfyNotifEnabled: true, ntfyTopic: '', telegramEnabled: true, telegramNotifEnabled: true, telegramToken: '', telegramChatId: '', lowSocAlert: 20, connTimeout: 10, gridOutageReport: true },
    metricsToken: '',
    tariff: { currency: 'UAH', type: 'daynight', flatRate: 0, dayRate: 0, nightRate: 0, dayStart: '07:00', nightStart: '23:00' },
  };
}

async function saveConfig(cfg) {
  try {
    const toSave = JSON.parse(JSON.stringify(cfg));
    // Encrypt Tuya password before saving
    if (toSave.tuya && toSave.tuya.password && !toSave.tuya.password.includes(':')) {
      toSave.tuya.password = encryptSecret(toSave.tuya.password);
    }
    await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(toSave, null, 2), { mode: 0o600 });
  } catch (err) {
    log.error('Failed to save config: ' + err.message);
  }
}

// ============================================================
// RATE LIMITING (token bucket per IP)
// ============================================================
const rateLimitBuckets = new Map();
const RATE_LIMIT_CAPACITY = 100;    // max tokens
const RATE_LIMIT_REFILL = 10;       // tokens per second

function rateLimit(ip) {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(ip) || { tokens: RATE_LIMIT_CAPACITY, lastRefill: now };
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(RATE_LIMIT_CAPACITY, bucket.tokens + elapsed * RATE_LIMIT_REFILL);
  bucket.lastRefill = now;
  if (bucket.tokens < 1) {
    rateLimitBuckets.set(ip, bucket);
    return false;
  }
  bucket.tokens -= 1;
  rateLimitBuckets.set(ip, bucket);
  return true;
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

// ============================================================
// AUTH SYSTEM
// ============================================================
const loginAttempts = {};
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW = 60 * 1000;
let sessions = {};
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

async function loadSessions() {
  try {
    const raw = await fs.promises.readFile(SESSIONS_FILE, 'utf8');
    const saved = JSON.parse(raw);
    const now = Date.now();
    for (const [token, s] of Object.entries(saved)) {
      if (s.exp && s.exp > now && s.csrf) sessions[token] = s;
    }
    log.info('Sessions loaded: ' + Object.keys(sessions).length + ' active');
  } catch {}
}

let _saveSessionsTimer = null;
function saveSessions() {
  if (_saveSessionsTimer) return;
  _saveSessionsTimer = setTimeout(async () => {
    _saveSessionsTimer = null;
    try {
      const now = Date.now();
      const active = {};
      for (const [token, s] of Object.entries(sessions)) {
        if (s.exp && s.exp > now) active[token] = s;
      }
      await fs.promises.writeFile(SESSIONS_FILE, JSON.stringify(active, null, 2), { mode: 0o600 });
    } catch {}
  }, 5000);
}

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  try {
    const testHash = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(testHash, 'hex'));
} catch { return false; }
}

async function ensureAuth() {
  try {
    if (!fs.existsSync(AUTH_FILE)) {
      const password = crypto.randomBytes(9).toString('base64url');
      const { salt, hash } = hashPassword(password);
      await fs.promises.writeFile(AUTH_FILE, JSON.stringify({ username: 'admin', salt, hash, mustChangePassword: true }, null, 2), { mode: 0o600 });
      log.info('Auth file created');
      console.log('');
      console.log('╔══════════════════════════════════════════════╗');
      console.log('║  🔐 Initial admin password: ' + password.padEnd(32) + '║');
      console.log('║  Please change it after first login.         ║');
      console.log('╚══════════════════════════════════════════════╝');
      console.log('');
    }
  } catch (err) {
    log.error('Failed to initialize auth: ' + err.message);
  }
}

async function ensureMetricsToken() {
  try {
    const cfg = await loadConfig();
    if (!cfg.metricsToken) {
      cfg.metricsToken = crypto.randomBytes(16).toString('base64url');
      await saveConfig(cfg);
      log.info('Metrics token generated (see Settings > Integrations, or GET /api/plugin-config)');
    }
  } catch (err) {
    log.error('Failed to initialize metrics token: ' + err.message);
  }
}

async function loadAuthFile() {
  try {
    return JSON.parse(await fs.promises.readFile(AUTH_FILE, 'utf8'));
  } catch {
    return { username: 'admin', salt: '', hash: '' };
  }
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(16).toString('hex');
  sessions[token] = { exp: Date.now() + SESSION_TTL, csrf };
  saveSessions();
  return { token, csrf };
}

function getSessionCsrf(token) {
  const s = sessions[token];
  return s ? s.csrf : null;
}

function isSessionValid(token) {
  const s = sessions[token];
  if (!s) return false;
  if (Date.now() > s.exp) { delete sessions[token]; return false; }
  s.exp = Date.now() + SESSION_TTL;
  return true;
}

function destroySession(token) { delete sessions[token]; saveSessions(); }

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return cookies;
}

// ============================================================
// SCENES / AUTOMATIONS
// ============================================================
let scenes = [];
let sceneTimers = {};
let _checkingScenes = false;
const sceneTraces = [];
const SCENE_TRACES_MAX = 200;

function pushSceneTrace(sceneName, action, detail) {
  sceneTraces.push({ ts: Date.now(), scene: sceneName, action, detail, condSnapshot: { grid: inverterData.gridPower, soc: inverterData.batterySOC } });
  if (sceneTraces.length > SCENE_TRACES_MAX) sceneTraces.splice(0, sceneTraces.length - SCENE_TRACES_MAX);
}

async function loadScenes() {
  try {
    if (fs.existsSync(SCENES_FILE)) {
      scenes = JSON.parse(await fs.promises.readFile(SCENES_FILE, 'utf8'));
    }
  } catch (err) {
    log.error('Failed to load scenes: ' + err.message);
  }
}

async function saveScenes() {
  try {
    await fs.promises.writeFile(SCENES_FILE, JSON.stringify(scenes, null, 2));
  } catch (err) {
    log.error('Failed to save scenes: ' + err.message);
  }
}

async function checkScenes() {
  if (_checkingScenes) return;
  if (!tuyaDevices.length) return;
  if (!inverterData.lastUpdate || Date.now() - inverterData.lastUpdate.getTime() > 30000) return;
  _checkingScenes = true;
  try {
    const now = Date.now();
    for (const scene of scenes) {
      if (scene.enabled === false) continue;
      const logic = scene.if && scene.if.logic === 'OR' ? 'OR' : 'AND';
      let condResults = [];
      for (const cond of (scene.if && scene.if.conditions) || []) {
        let met = false;
        if (cond.type === 'grid') {
          met = inverterData.gridPower === cond.value;
        } else if (cond.type === 'battery') {
          const op = cond.operator || '=';
          if (op === '<') met = inverterData.batterySOC < cond.value;
          else if (op === '>') met = inverterData.batterySOC > cond.value;
          else met = inverterData.batterySOC === cond.value;
        } else if (cond.type === 'time') {
          const t = new Date();
          const cur = t.getHours() * 60 + t.getMinutes();
          const after = cond.after ? cond.after.split(':').reduce((h,m)=>h*60+ +m,0) : -1;
          const before = cond.before ? cond.before.split(':').reduce((h,m)=>h*60+ +m,1440) : 1440;
          met = cur >= after && cur <= before;
        } else if (cond.type === 'weekday') {
          const days = cond.days || [];
          met = days.includes(new Date().getDay());
        } else if (cond.type === 'device_online') {
          const dev = tuyaDevices.find(d => d.id === cond.value);
          met = dev ? dev.online === cond.expectedStatus : false;
        }
        condResults.push(met);
      }
      const conditionsMet = logic === 'AND' ? condResults.every(Boolean) : condResults.some(Boolean);

      for (const action of scene.then.actions) {
        if (action.type === 'notify') {
          const key = scene.name + ':notify:' + (action.title || 'notify');
          let nstate = sceneTimers[key];
          if (!nstate) { nstate = { active: false, appliedAt: 0, revertedAt: 0 }; sceneTimers[key] = nstate; }
          if (conditionsMet && !nstate.active) {
            try {
              await sendNotification(action.title || scene.name, action.message || ('Automation "' + scene.name + '" triggered'));
              pushSceneTrace(scene.name, 'notify', action.title || action.message || 'sent');
            } catch (err) { pushSceneTrace(scene.name, 'notify:error', err.message); }
            nstate.active = true; nstate.appliedAt = now;
          } else if (!conditionsMet && nstate.active) {
            nstate.active = false; nstate.revertedAt = now;
          }
          continue;
        }
        const key = scene.name + ':' + action.device;
        let state = sceneTimers[key];
        if (!state) {
          state = { active: false, appliedAt: 0, revertedAt: 0 };
          sceneTimers[key] = state;
        }
        const hasDuration = action.duration > 0;
        const hasInterval = action.interval > 0;

        if (conditionsMet) {
          if (state.active) {
            if (hasDuration && now - state.appliedAt >= action.duration * 60000) {
              try {
                await controlDevice(action.device, !action.value);
                log.info('Scene "' + scene.name + '" reverted ' + action.device + ' after ' + action.duration + 'min');
                pushSceneTrace(scene.name, 'revert (timeout)', action.device + '=' + (!action.value ? 'ON' : 'OFF'));
              } catch (err) { log.error('Scene revert failed: ' + err.message); pushSceneTrace(scene.name, 'revert:error', err.message); }
              state.active = false;
              state.revertedAt = now;
            }
          } else {
            const elapsedSinceRevert = now - state.revertedAt;
            const intervalMs = hasInterval ? action.interval * 60000 : 0;
            if (elapsedSinceRevert >= intervalMs) {
              try {
                await controlDevice(action.device, action.value);
                log.info('Scene "' + scene.name + '" applied ' + action.device + ' = ' + (action.value ? 'ON' : 'OFF'));
                pushSceneTrace(scene.name, 'apply', action.device + '=' + (action.value ? 'ON' : 'OFF'));
              } catch (err) { log.error('Scene action failed: ' + err.message); pushSceneTrace(scene.name, 'apply:error', err.message); }
              state.active = true;
              state.appliedAt = now;
            }
          }
        } else {
          if (state.active) {
              try {
                await controlDevice(action.device, !action.value);
                log.info('Scene "' + scene.name + '" reverted (conditions changed)');
                pushSceneTrace(scene.name, 'revert (conditions)', action.device + '=' + (!action.value ? 'ON' : 'OFF'));
              } catch (err) { log.error('Scene revert failed: ' + err.message); pushSceneTrace(scene.name, 'revert:error', err.message); }
            state.active = false;
            state.revertedAt = now;
          }
        }
      }
    }
  } catch (err) {
    log.error('checkScenes error: ' + (err.message || err));
  } finally {
    _checkingScenes = false;
  }
}

// ============================================================
// HTTP SERVER — SIMPLE ROUTER
// ============================================================
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    const MAX = 1024 * 1024;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX) {
        req.destroy();
        return reject(new Error('Request body too large'));
      }
      body += chunk;
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const str = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(str),
    'Cache-Control': 'no-store',
  });
  res.end(str);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
  res.end(html);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function setCookie(res, name, value, maxAge, req) {
  const existing = res.getHeader('Set-Cookie') || [];
  const cookies = Array.isArray(existing) ? existing : [existing];
  const secure = req && (req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https');
  cookies.push(`${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
  res.setHeader('Set-Cookie', cookies);
}

function clearCookie(res, name, req) {
  setCookie(res, name, '', 0, req);
}

// Route table
const routes = [];

function route(method, path, handler) {
  routes.push({ method, path, handler });
}

function matchRoute(method, urlPath) {
  for (const r of routes) {
    if (r.method !== method) continue;
    // Simple pattern matching with :param support
    const routeParts = r.path.split('/');
    const urlParts = urlPath.split('/');
    if (routeParts.length !== urlParts.length) continue;
    const params = {};
    let match = true;
    for (let i = 0; i < routeParts.length; i++) {
      if (routeParts[i].startsWith(':')) {
        params[routeParts[i].slice(1)] = decodeURIComponent(urlParts[i]);
      } else if (routeParts[i] !== urlParts[i]) {
        match = false;
        break;
      }
    }
    if (match) return { handler: r.handler, params };
  }
  return null;
}

// ============================================================
// API ROUTES
// ============================================================
const WEB_PORT_DEFAULT = 8583;

// Health check endpoint (no auth required)
route('GET', '/healthz', (req, res) => {
  const uptime = process.uptime();
  const mem = process.memoryUsage();
  const inverterOk = inverterData && inverterData.lastUpdate && (Date.now() - inverterData.lastUpdate) < 60000;
  const status = inverterOk ? 'ok' : 'degraded';
  sendJson(res, 200, {
    status,
    uptime: Math.round(uptime),
    memRss: mem.rss,
    memHeap: mem.heapUsed,
    inverterOnline: inverterOk,
    sessionCount: Object.keys(sessions).length,
  });
});

// Login page
route('GET', '/login', (req, res) => {
  sendHtml(res, 200, getLoginPage());
});

// Login POST
route('POST', '/login', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    if (!loginAttempts[ip]) loginAttempts[ip] = [];
    loginAttempts[ip] = loginAttempts[ip].filter(t => now - t < LOGIN_WINDOW);
    if (loginAttempts[ip].length >= MAX_LOGIN_ATTEMPTS) {
      return sendJson(res, 429, { success: false, message: 'Too many attempts. Please wait a minute.' });
    }
    const { username, password } = req.body || {};
    const auth = await loadAuthFile();
    const userOk = username === auth.username;
    const passOk = userOk && verifyPassword(password || '', auth.salt, auth.hash);
    if (passOk) {
      delete loginAttempts[ip];
      const { token, csrf } = createSession();
      setCookie(res, 'ecm_session', token, SESSION_TTL / 1000, req);
      return sendJson(res, 200, { success: true, csrfToken: csrf, mustChangePassword: !!auth.mustChangePassword });
    }
    loginAttempts[ip].push(now);
    return sendJson(res, 401, { success: false, message: 'Invalid login or password' });
  } catch (err) {
    return sendJson(res, 500, { success: false, message: err.message });
  }
});

// Logout
route('POST', '/api/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.ecm_session) destroySession(cookies.ecm_session);
  clearCookie(res, 'ecm_session', req);
  sendJson(res, 200, { success: true });
});

// Change password
route('POST', '/api/change-password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const auth = await loadAuthFile();
    const curOk = verifyPassword(currentPassword || '', auth.salt, auth.hash);
    if (!curOk) return sendJson(res, 401, { success: false, message: 'Current password is incorrect' });
    if (!newPassword || newPassword.length < 6) return sendJson(res, 400, { success: false, message: 'Password must contain at least 6 characters' });
    const { salt, hash } = hashPassword(newPassword);
    auth.salt = salt;
    auth.hash = hash;
    auth.mustChangePassword = false;
    await fs.promises.writeFile(AUTH_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 });
    sessions = {};
    log.info('Password changed, all sessions invalidated');
    sendJson(res, 200, { success: true, mustChangePassword: false });
  } catch (err) {
    sendJson(res, 500, { success: false, message: err.message });
  }
});

// Inverter data
route('GET', '/api/status', async (req, res) => {
  const cookies = parseCookies(req);
  const csrfToken = getSessionCsrf(cookies.ecm_session);
  const cfg = await loadConfig();
  sendJson(res, 200, { csrfToken,
    costToday: { day: Math.round(costState.dayKwh * 100) / 100, night: Math.round(costState.nightKwh * 100) / 100 },
    tariff: cfg.tariff || { currency: 'UAH', type: 'daynight', flatRate: 0, dayRate: 0, nightRate: 0 },
    dailyRecords: dailyRecords.slice(-30),
    gridPower: inverterData.gridPower,
    gridRaw: inverterData.gridRaw,
    gridVoltage: inverterData.gridVoltage,
    batterySOC: inverterData.batterySOC,
    pvPower: inverterData.pvPower,
    pvPower2: inverterData.pvPower2,
    loadPower: inverterData.loadPower,
    batteryPower: inverterData.batteryPower,
    batteryTemp: inverterData.batteryTemp,
    envTemp: inverterData.envTemp,
    dayPV: inverterData.dayPV,
    dayGridImport: inverterData.dayGridImport,
    totalGridImport: inverterData.totalGridImport || 0,
    totalLoadEnergy: inverterData.totalLoadEnergy || 0,
    dayGridExport: inverterData.dayGridExport,
    dayBatCharge: inverterData.dayBatCharge,
    dayBatDischarge: inverterData.dayBatDischarge,
    dayLoadEnergy: inverterData.dayLoadEnergy,
    debug: inverterData.debug || {},
    tuyaDevices: tuyaDevices.map(d => ({ id: d.id, name: d.name, switch: d.switch, power: d.power || 0, voltage: d.voltage || 0, current: d.current || 0 })),
    scenes: scenes,
  });
});

route('GET', '/api/metrics', async (req, res) => {
  const cfg = await loadConfig();
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  if (!cfg.metricsToken || token !== cfg.metricsToken) {
    return sendText(res, 401, '# unauthorized: missing or invalid ?token=\n');
  }
  const lines = [];
  const gauge = (name, help, value) => {
    lines.push('# HELP ' + name + ' ' + help);
    lines.push('# TYPE ' + name + ' gauge');
    lines.push(name + ' ' + (Number.isFinite(value) ? value : 0));
  };
  gauge('energy_controller_grid_up', 'Grid connection status (1=up, 0=down)', inverterData.gridPower ? 1 : 0);
  gauge('energy_controller_grid_voltage_volts', 'Grid voltage', inverterData.gridVoltage);
  gauge('energy_controller_battery_soc_percent', 'Battery state of charge', inverterData.batterySOC);
  gauge('energy_controller_battery_power_watts', 'Battery power (positive=discharging)', inverterData.batteryPower);
  gauge('energy_controller_battery_temp_celsius', 'Battery temperature', inverterData.batteryTemp);
  gauge('energy_controller_pv_power_watts', 'Total PV power (both strings)', (inverterData.pvPower || 0) + (inverterData.pvPower2 || 0));
  gauge('energy_controller_load_power_watts', 'House load power', inverterData.loadPower);
  gauge('energy_controller_day_pv_kwh', 'PV energy generated today', inverterData.dayPV);
  gauge('energy_controller_day_grid_import_kwh', 'Grid energy imported today', inverterData.dayGridImport);
  gauge('energy_controller_day_grid_export_kwh', 'Grid energy exported today', inverterData.dayGridExport);
  gauge('energy_controller_day_load_kwh', 'Load energy consumed today', inverterData.dayLoadEnergy);
  for (const dev of tuyaDevices) {
    const label = '{device="' + String(dev.name || dev.id).replace(/"/g, "'") + '"}';
    lines.push('energy_controller_socket_power_watts' + label + ' ' + (dev.power || 0));
    lines.push('energy_controller_socket_on' + label + ' ' + (dev.switch ? 1 : 0));
  }
  sendText(res, 200, lines.join('\n') + '\n');
});

// Tuya devices list
route('GET', '/api/tuya-devices', (req, res) => {
  sendJson(res, 200, tuyaDevices.map(d => ({
    id: d.id, name: d.name, online: d.online, ip: d.ip || '', switch: d.switch, power: d.power || 0, voltage: d.voltage || 0, current: d.current || 0,
  })));
});

// Tuya control
route('POST', '/api/tuya-control', async (req, res) => {
  const { deviceId, value } = req.body || {};
  try {
    await controlDevice(deviceId, value);
    sendJson(res, 200, { success: true, message: 'Device controlled' });
  } catch (err) {
    log.error('Control failed: ' + err.message);
    sendJson(res, 200, { success: false, message: err.message });
  }
});

// Sync Tuya devices
route('POST', '/api/sync-tuya', async (req, res) => {
  try {
    await initTuya();
    saveDevices();
    sendJson(res, 200, { success: true, count: tuyaDevices.length });
  } catch (err) {
    sendJson(res, 200, { success: false, message: err.message });
  }
});

// Plugin config GET
route('GET', '/api/plugin-config', async (req, res) => {
  try {
    const cfg = await loadConfig();
    const safe = JSON.parse(JSON.stringify(cfg));
    if (safe.tuya && safe.tuya.password) safe.tuya.password = '••••••••';
    if (safe.tuya && safe.tuya.accessKey) safe.tuya.accessKey = '••••••••';
    if (safe.notifications && safe.notifications.telegramToken) safe.notifications.telegramToken = '••••••••';
    sendJson(res, 200, { success: true, config: safe });
  } catch (err) {
    sendJson(res, 500, { success: false, message: err.message });
  }
});

// Plugin config POST
route('POST', '/api/plugin-config', async (req, res) => {
  try {
    const { config: newCfg } = req.body || {};
    if (!newCfg) return sendJson(res, 400, { success: false, message: 'No config provided' });
    const old = await loadConfig();
    const merged = JSON.parse(JSON.stringify(old));
    if (newCfg.inverter) merged.inverter = newCfg.inverter;
    if (newCfg.tuya) {
      merged.tuya = merged.tuya || {};
      for (const k of Object.keys(newCfg.tuya)) {
        if (newCfg.tuya[k] === '••••••••' || newCfg.tuya[k] === '') continue;
        if (k === 'password') {
          merged.tuya[k] = encryptSecret(newCfg.tuya[k]);
        } else {
          merged.tuya[k] = newCfg.tuya[k];
        }
      }
    }
    if (newCfg.webPort !== undefined) merged.webPort = parseInt(newCfg.webPort) || 8583;
    if (newCfg.notifications) {
      merged.notifications = merged.notifications || {};
      for (const k of ['ntfyTopic', 'telegramToken', 'telegramChatId']) {
        if (newCfg.notifications[k] === '••••••••' || newCfg.notifications[k] === '') continue;
        if (newCfg.notifications[k] !== undefined) merged.notifications[k] = newCfg.notifications[k];
      }
      if (newCfg.notifications.ntfyEnabled !== undefined) merged.notifications.ntfyEnabled = !!newCfg.notifications.ntfyEnabled;
      if (newCfg.notifications.telegramEnabled !== undefined) merged.notifications.telegramEnabled = !!newCfg.notifications.telegramEnabled;
      if (newCfg.notifications.criticalEnabled !== undefined) merged.notifications.criticalEnabled = !!newCfg.notifications.criticalEnabled;
      if (newCfg.notifications.lowSocAlert !== undefined) merged.notifications.lowSocAlert = parseInt(newCfg.notifications.lowSocAlert) || 20;
      if (newCfg.notifications.connTimeout !== undefined) merged.notifications.connTimeout = parseInt(newCfg.notifications.connTimeout) || 10;
      if (newCfg.notifications.gridOutageReport !== undefined) merged.notifications.gridOutageReport = newCfg.notifications.gridOutageReport;
    }
    if (newCfg.tariff) {
      merged.tariff = merged.tariff || {};
      if (newCfg.tariff.currency !== undefined) merged.tariff.currency = String(newCfg.tariff.currency || 'UAH').slice(0, 8);
      if (newCfg.tariff.type !== undefined) merged.tariff.type = (newCfg.tariff.type === 'flat') ? 'flat' : 'daynight';
      if (newCfg.tariff.flatRate !== undefined) merged.tariff.flatRate = parseFloat(newCfg.tariff.flatRate) || 0;
      if (newCfg.tariff.dayRate !== undefined) merged.tariff.dayRate = parseFloat(newCfg.tariff.dayRate) || 0;
      if (newCfg.tariff.nightRate !== undefined) merged.tariff.nightRate = parseFloat(newCfg.tariff.nightRate) || 0;
      if (newCfg.tariff.dayStart !== undefined) merged.tariff.dayStart = newCfg.tariff.dayStart || '07:00';
      if (newCfg.tariff.nightStart !== undefined) merged.tariff.nightStart = newCfg.tariff.nightStart || '23:00';
    }
    await saveConfig(merged);
    sendJson(res, 200, { success: true, message: 'Config saved. Restart to apply.' });
  } catch (err) {
    sendJson(res, 500, { success: false, message: err.message });
  }
});

// Notifications — send via ntfy.sh and/or Telegram
async function sendNotification(title, message, critical) {
  try {
    const cfg = await loadConfig();
    const n = cfg.notifications || {};
    if (n.criticalEnabled === false && critical) return [];
    if (n.notifEnabled === false) return [];
    const results = [];
    if (n.ntfyTopic && n.ntfyEnabled !== false && n.ntfyNotifEnabled !== false) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const body = JSON.stringify({ topic: n.ntfyTopic, title, message, priority: 4 });
          await new Promise((resolve, reject) => {
            const req2 = https.request({ hostname: 'ntfy.sh', port: 443, path: '/', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 25000 }, res2 => { res2.on('data', () => {}); res2.on('end', resolve); });
            req2.on('error', e => reject(new Error('ntfy: ' + (e.code || e.message || typeof e))));
            req2.on('timeout', () => { req2.destroy(); reject(new Error('ntfy timeout')); });
            req2.write(body);
            req2.end();
          });
          results.push('ntfy: OK');
          break;
        } catch (e) {
          if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue; }
          results.push('ntfy: ' + e.message);
        }
      }
    }
    if (n.telegramToken && n.telegramChatId && n.telegramEnabled !== false && n.telegramNotifEnabled !== false) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const body = JSON.stringify({ chat_id: n.telegramChatId, text: '*' + title + '*\n' + message, parse_mode: 'Markdown' });
          await new Promise((resolve, reject) => {
            const url = new URL('https://api.telegram.org/bot' + n.telegramToken + '/sendMessage');
            const req2 = https.request({ hostname: url.hostname, port: 443, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 25000 }, res2 => { res2.on('data', () => {}); res2.on('end', resolve); });
            req2.on('error', e => reject(new Error('tg: ' + (e.code || e.message || typeof e))));
            req2.on('timeout', () => { req2.destroy(); reject(new Error('telegram timeout')); });
            req2.write(body);
            req2.end();
          });
          results.push('telegram: OK');
          break;
        } catch (e) {
          if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue; }
          results.push('telegram: ' + e.message);
        }
      }
    }
    if (results.length) log.info('Notification (' + title + '): ' + results.join(', '));
    return results;
  } catch (e) { return ['error: ' + e.message]; }
}

route('POST', '/api/test-notification', async (req, res) => {
  const results = await sendNotification('Test', 'Energy Controller notification test at ' + new Date().toLocaleString());
  sendJson(res, 200, { success: true, results });
});

// Scenes
route('GET', '/api/scenes', (req, res) => {
  sendJson(res, 200, scenes);
});

route('POST', '/api/scenes', async (req, res) => {
  const scene = req.body || {};
  scene.enabled = true;
  scenes.push(scene);
  await saveScenes();
  sendJson(res, 200, { success: true });
});

route('DELETE', '/api/scenes/:name', async (req, res) => {
  scenes = scenes.filter(s => s.name !== req.params.name);
  await saveScenes();
  sendJson(res, 200, { success: true });
});

route('PATCH', '/api/scenes/:name', async (req, res) => {
  const scene = scenes.find(s => s.name === req.params.name);
  if (!scene) return sendJson(res, 404, { success: false, message: 'Scene not found' });
  scene.enabled = (req.body || {}).enabled === true;
  await saveScenes();
  sendJson(res, 200, { success: true, enabled: scene.enabled });
});

route('GET', '/api/scene-traces', (req, res) => {
  const last = parseInt(req.url.split('last=')[1]) || 5;
  const map = {};
  for (const t of sceneTraces) {
    if (!map[t.scene]) map[t.scene] = [];
    map[t.scene].push(t);
  }
  sendJson(res, 200, { success: true, traces: map });
});

route('POST', '/api/scenes/:name/run', async (req, res) => {
  const scene = scenes.find(s => s.name === req.params.name);
  if (!scene) return sendJson(res, 404, { success: false, message: 'Scene not found' });
  const results = [];
  for (const action of (scene.then && scene.then.actions) || []) {
    try {
      if (action.type === 'notify') {
        await sendNotification(action.title || scene.name, action.message || ('Manually triggered: ' + scene.name));
        pushSceneTrace(scene.name, 'notify (manual)', action.title || action.message || 'sent');
        results.push({ ok: true, action: 'notify' });
      } else {
        await controlDevice(action.device, action.value);
        pushSceneTrace(scene.name, 'apply (manual)', action.device + '=' + (action.value ? 'ON' : 'OFF'));
        results.push({ ok: true, action: action.device });
      }
    } catch (err) {
      pushSceneTrace(scene.name, 'apply:error (manual)', err.message);
      results.push({ ok: false, action: action.device || 'notify', error: err.message });
    }
  }
  sendJson(res, 200, { success: true, results });
});

// Device ping (safe from command injection)
route('GET', '/api/device-ping/:ip', (req, res) => {
  const ip = req.params.ip;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return sendJson(res, 400, { success: false, message: 'Invalid IP address' });
  }
  execFile('ping', ['-c', '1', '-W', '1', ip], (error) => {
    sendJson(res, 200, { success: true, ip, online: error === null });
  });
});

// Logs (in-memory buffer, fallback to journalctl)
route('GET', '/api/logs', (req, res) => {
  if (logBuffer.length > 0) {
    sendJson(res, 200, { success: true, logs: logBuffer.join('\n') });
    return;
  }
  try {
    exec('journalctl -u energy-controller --no-pager -n 100 --output=cat 2>/dev/null || echo ""', (err, stdout) => {
      const logs = (stdout || '').trim();
      sendJson(res, 200, { success: true, logs });
    });
  } catch (err) {
    sendJson(res, 200, { success: true, logs: '' });
  }
});

// History data (RRD — data already pre-aggregated by level)
route('GET', '/api/history', (req, res) => {
  try {
    const period = (req.url.split('period=')[1] || 'day').split('&')[0];
    const level = rrdPickLevel(period);
    const today = new Date();
    const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    let cutoffMs;
    switch (period) {
      case '1h': cutoffMs = 60 * 60 * 1000; break;
      case '3h': cutoffMs = 3 * 60 * 60 * 1000; break;
      case '6h': cutoffMs = 6 * 60 * 60 * 1000; break;
      case '12h': cutoffMs = 12 * 60 * 60 * 1000; break;
      case 'week': { const day = today.getDay(); const diff = (day === 0 ? 6 : day - 1); cutoffMs = Date.now() - (midnight - diff * 24 * 60 * 60 * 1000); break; }
      case 'month': cutoffMs = Date.now() - new Date(today.getFullYear(), today.getMonth(), 1).getTime(); break;
      case 'year': cutoffMs = Date.now() - new Date(today.getFullYear(), 0, 1).getTime(); break;
      default: cutoffMs = Date.now() - midnight;
    }
    const points = rrdGetPower(level, cutoffMs);
    sendJson(res, 200, { success: true, period, points });
  } catch (err) {
    sendJson(res, 500, { success: false, message: err.message });
  }
});

// Socket history data (RRD)
route('GET', '/api/socket-history', (req, res) => {
  try {
    const period = (req.url.split('period=')[1] || 'day').split('&')[0];
    const level = rrdPickLevel(period);
    const today = new Date();
    const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    let cutoffMs;
    switch (period) {
      case '1h': cutoffMs = 60 * 60 * 1000; break;
      case '3h': cutoffMs = 3 * 60 * 60 * 1000; break;
      case '6h': cutoffMs = 6 * 60 * 60 * 1000; break;
      case '12h': cutoffMs = 12 * 60 * 60 * 1000; break;
      case 'week': { const day = today.getDay(); const diff = (day === 0 ? 6 : day - 1); cutoffMs = Date.now() - (midnight - diff * 24 * 60 * 60 * 1000); break; }
      case 'month': cutoffMs = Date.now() - new Date(today.getFullYear(), today.getMonth(), 1).getTime(); break;
      case 'year': cutoffMs = Date.now() - new Date(today.getFullYear(), 0, 1).getTime(); break;
      default: cutoffMs = Date.now() - midnight;
    }
    const points = rrdGetSocket(level, cutoffMs);
    const deviceNames = {};
    for (const dev of tuyaDevices) {
      deviceNames[dev.id] = dev.name;
    }
    sendJson(res, 200, { success: true, period, points, deviceNames });
  } catch (err) {
    sendJson(res, 500, { success: false, message: err.message });
  }
});

// Restart service
route('POST', '/api/restart', (req, res) => {
  sendJson(res, 200, { success: true, message: 'Restarting...' });
  setTimeout(() => {
    exec('sudo systemctl restart energy-controller', () => {});
  }, 500);
});

// System info
route('GET', '/api/system-info', async (req, res) => {
  let cpuTemp = null, cpuFreq = null;
  try {
    const tempRaw = await fs.promises.readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8');
    cpuTemp = (parseInt(tempRaw) / 1000).toFixed(1);
  } catch (_) {}
  try {
    const freqRaw = await fs.promises.readFile('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq', 'utf8');
    cpuFreq = (parseInt(freqRaw) / 1000).toFixed(0);
  } catch (_) {}
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  let diskInfo = {};
  try {
    const { exec } = require('child_process');
    const df = await new Promise((resolve, reject) => {
      exec('df -k / | tail -1', (err, stdout) => err ? reject(err) : resolve(stdout.trim()));
    });
    const parts = df.split(/\s+/);
    if (parts.length >= 5) {
      diskInfo = { total: parseInt(parts[1]) * 1024, used: parseInt(parts[2]) * 1024, available: parseInt(parts[3]) * 1024 };
    }
  } catch (_) {}
  sendJson(res, 200, {
    hostname: os.hostname(),
    platform: os.platform(),
    uptime: os.uptime(),
    nodeVersion: process.version,
    cpuModel: cpus[0]?.model || '',
    cpuCores: cpus.length,
    cpuLoad: os.loadavg(),
    cpuTemp,
    cpuFreq,
    totalMem,
    freeMem,
    usedMem: totalMem - freeMem,
    diskInfo,
  });
});

// App version & git info
route('GET', '/api/app-version', async (req, res) => {
  try {
    const pkg = JSON.parse(await fs.promises.readFile(path.join(__dirname, 'package.json'), 'utf8'));
    let version = pkg.version || '1.0.0';
    let gitHash = '', gitBranch = '', gitRemote = '', isGitRepo = false;
    try {
      gitHash = (await new Promise((resolve, reject) => {
        exec('git rev-parse --short HEAD', { cwd: __dirname }, (err, stdout) => err ? reject(err) : resolve(stdout.trim()));
      }));
      gitBranch = (await new Promise((resolve, reject) => {
        exec('git branch --show-current', { cwd: __dirname }, (err, stdout) => err ? reject(err) : resolve(stdout.trim()));
      }));
      gitRemote = (await new Promise((resolve, reject) => {
        exec('git remote get-url origin', { cwd: __dirname }, (err, stdout) => err ? reject(err) : resolve(stdout.trim()));
      }));
      try {
        const desc = await new Promise((resolve, reject) => {
          exec('git describe --tags', { cwd: __dirname }, (err, stdout) => err ? reject(err) : resolve(stdout.trim()));
        });
        version = desc;
      } catch {
        try {
          const cnt = await new Promise((resolve, reject) => {
            exec('git rev-list --count HEAD', { cwd: __dirname }, (err, stdout) => err ? reject(err) : resolve(stdout.trim()));
          });
          version = 'r' + cnt;
        } catch {}
      }
      isGitRepo = true;
    } catch {}
    sendJson(res, 200, { success: true, version, gitHash, gitBranch, gitRemote, isGit: isGitRepo });
  } catch (err) {
    sendJson(res, 500, { success: false, message: err.message });
  }
});

// Check for git updates
route('POST', '/api/update-check', async (req, res) => {
  try {
    const isGit = (await new Promise(r => exec('git rev-parse --is-inside-work-tree', { cwd: __dirname }, (e, o) => r(!e && o.trim() === 'true'))));
    if (!isGit) return sendJson(res, 200, { success: true, isGit: false, message: 'Not a git repository' });
    try { await new Promise(r => { exec('git fetch --all --tags --force 2>/dev/null', { cwd: __dirname }, () => r()); }); } catch {}
    const tags = (await new Promise(r => exec('git tag --sort=-v:refname', { cwd: __dirname }, (e, o) => r(o || '')))).trim().split('\n').filter(Boolean);
    const currentTag = (await new Promise(r => exec('git describe --tags --exact-match 2>/dev/null || true', { cwd: __dirname }, (e, o) => r(o || '')))).trim();
    const currentBranch = (await new Promise(r => exec('git rev-parse --abbrev-ref HEAD', { cwd: __dirname }, (e, o) => r((o || '').trim())))).trim();
    const local = (await new Promise(r => exec('git rev-parse HEAD', { cwd: __dirname }, (e, o) => r(o.trim())))).trim();
    let branches = [];
    try {
      const remoteOutput = await new Promise(r => exec('git branch -r --format=%(refname:short) 2>/dev/null', { cwd: __dirname }, (e, o) => r(o || '')));
      const branchLines = remoteOutput.trim().split('\n').filter(Boolean);
      for (const b of branchLines) {
        const clean = b.replace(/^origin\//, '');
        if (clean === 'HEAD') continue;
        const commitInfo = await new Promise(r => exec('git log -1 --format=%h|%s|%ci ' + b.trim(), { cwd: __dirname }, (e, o) => r(o || '')));
        const parts = commitInfo.trim().split('|');
        branches.push({ name: clean, commit: parts[0] || '', message: parts[1] || '', date: parts[2] || '' });
      }
    } catch {}
    sendJson(res, 200, { success: true, isGit: true, tags, currentTag, currentBranch, branches, local: local.slice(0, 7) });
  } catch (err) {
    sendJson(res, 200, { success: false, message: err.message });
  }
});

// Update from git tag or branch & restart
route('POST', '/api/update-apply', (req, res) => {
  const tag = req.body && req.body.tag;
  const branch = req.body && req.body.branch;
  if (tag && branch) return sendJson(res, 400, { success: false, message: 'Specify either tag or branch, not both' });
  if (!tag && !branch) return sendJson(res, 400, { success: false, message: 'Tag or branch required' });
  const target = tag || branch;
  if (typeof target !== 'string' || target.length > 100 || /[^a-zA-Z0-9._\/-]/.test(target)) {
    return sendJson(res, 400, { success: false, message: 'Invalid target name' });
  }
  // Always fetch latest before validating
  execFile('git', ['fetch', '--all', '--tags', '--force'], { cwd: __dirname, maxBuffer: 1024 * 1024 }, () => {
    if (tag) {
      execFile('git', ['tag', '--list'], { cwd: __dirname, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err) return sendJson(res, 500, { success: false, message: 'Failed to list tags' });
        const validTags = (stdout || '').trim().split('\n').filter(Boolean);
        if (!validTags.includes(tag)) return sendJson(res, 400, { success: false, message: 'Unknown tag: ' + tag + '. Available: ' + validTags.join(', ') });
        execFile('git', ['verify-tag', tag], { cwd: __dirname }, (verr) => {
          if (verr) log.warn('Tag signature verification failed for ' + tag + ': ' + verr.message + ' (continuing)');
          // Tags are detached HEAD — checkout directly, no reset needed
          sendJson(res, 200, { success: true, message: 'Updating to tag ' + tag + '...' });
          setTimeout(() => {
            execFile('git', ['checkout', tag], { cwd: __dirname, maxBuffer: 1024 * 1024 }, (e2, o2) => {
              log.info('Git checkout ' + tag + ': ' + (e2 ? e2.message : (o2 || '').trim()));
              execFile('git', ['log', '-1', '--oneline'], { cwd: __dirname }, (e3, o3) => {
                if (!e3) log.info('Checked out: ' + (o3 || '').trim());
                setTimeout(() => { exec('sudo systemctl restart energy-controller', () => {}); }, 1000);
              });
            });
          }, 500);
        });
      });
    } else {
      execFile('git', ['branch', '-r', '--list', 'origin/' + branch], { cwd: __dirname, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err || !(stdout || '').trim()) return sendJson(res, 400, { success: false, message: 'Unknown remote branch: ' + branch });
        // Branches: fetch + reset --hard avoids merge/push issues
        sendJson(res, 200, { success: true, message: 'Updating to branch ' + branch + '...' });
        setTimeout(() => {
          execFile('git', ['stash', '--include-untracked'], { cwd: __dirname }, () => {
            execFile('git', ['reset', '--hard', 'origin/' + branch], { cwd: __dirname, maxBuffer: 1024 * 1024 }, (e2, o2) => {
              log.info('Git reset --hard origin/' + branch + ': ' + (e2 ? e2.message : (o2 || '').trim()));
              execFile('git', ['log', '-1', '--oneline'], { cwd: __dirname }, (e3, o3) => {
                if (!e3) log.info('Checked out: ' + (o3 || '').trim());
                setTimeout(() => { exec('sudo systemctl restart energy-controller', () => {}); }, 1000);
              });
            });
          });
        }, 500);
      });
    }
  });
});
// Backup — package selected data into downloadable JSON
route('POST', '/api/backup', async (req, res) => {
  try {
    const { scope } = req.body || {};
    if (!Array.isArray(scope)) return sendJson(res, 400, { success: false, message: 'Invalid scope' });
    const data = {};
    for (const s of scope) {
      if (s === 'config') {
        try { data.config = JSON.parse(await fs.promises.readFile(CONFIG_FILE, 'utf8')); } catch { data.config = {}; }
      }
      if (s === 'auth') {
        try { data.auth = JSON.parse(await fs.promises.readFile(AUTH_FILE, 'utf8')); } catch { data.auth = {}; }
      }
      if (s === 'scenes') {
        try { data.scenes = JSON.parse(await fs.promises.readFile(SCENES_FILE, 'utf8')); } catch { data.scenes = []; }
      }
      if (s === 'history') {
        try { data.history = {}; for (const l of ['1m','15m','1h']) data.history[l] = JSON.parse(await fs.promises.readFile(DATA_DIR + '/history_' + l + '.json', 'utf8')); } catch { data.history = {}; }
        try { data.socketHistory = {}; for (const l of ['1m','15m','1h']) data.socketHistory[l] = JSON.parse(await fs.promises.readFile(DATA_DIR + '/sockets_' + l + '.json', 'utf8')); } catch { data.socketHistory = {}; }
      }
      if (s === 'devices') {
        try { data.devices = JSON.parse(await fs.promises.readFile(DEVICES_FILE, 'utf8')); } catch { data.devices = []; }
      }
    }
    const pkg = await new Promise(r => exec('git rev-parse --short HEAD', { cwd: __dirname }, (e, o) => r(e ? 'unknown' : o.trim())));
    sendJson(res, 200, { success: true, backup: { version: '1.0', createdAt: new Date().toISOString(), gitHash: pkg, data } });
  } catch (err) {
    sendJson(res, 500, { success: false, message: err.message });
  }
});

// Restore — write backup data back
route('POST', '/api/backup/restore', async (req, res) => {
  try {
    const { data, overwrite, confirmPassword } = req.body || {};
    if (!data) return sendJson(res, 400, { success: false, message: 'No backup data' });
    const files = overwrite || ['config', 'auth', 'scenes', 'history'];
    
    // Require password confirmation if restoring auth
    if (files.includes('auth') && data.auth && data.auth.salt && data.auth.hash) {
      if (!confirmPassword) {
        return sendJson(res, 400, { success: false, message: 'Current password required to restore authentication settings' });
      }
      const auth = await loadAuthFile();
      const passOk = verifyPassword(confirmPassword, auth.salt, auth.hash);
      if (!passOk) {
        return sendJson(res, 401, { success: false, message: 'Incorrect password' });
      }
    }
    
    for (const f of files) {
      if (f === 'config' && data.config) {
        try { const cur = JSON.parse(await fs.promises.readFile(CONFIG_FILE, 'utf8')); const m = { ...cur, ...data.config }; await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(m, null, 2), { mode: 0o600 }); } catch { await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(data.config, null, 2), { mode: 0o600 }); }
      }
      if (f === 'auth' && data.auth && data.auth.salt && data.auth.hash) {
        await fs.promises.writeFile(AUTH_FILE, JSON.stringify(data.auth, null, 2), { mode: 0o600 });
      }
      if (f === 'scenes' && data.scenes) {
        await fs.promises.writeFile(SCENES_FILE, JSON.stringify(data.scenes, null, 2), { mode: 0o600 });
      }
      if (f === 'history' && data.history) {
        for (const l of ['1m','15m','1h']) {
          if (data.history[l]) await fs.promises.writeFile(DATA_DIR + '/history_' + l + '.json', JSON.stringify(data.history[l], null, 2), { mode: 0o600 });
        }
      }
      if (f === 'history' && data.socketHistory) {
        for (const l of ['1m','15m','1h']) {
          if (data.socketHistory[l]) await fs.promises.writeFile(DATA_DIR + '/sockets_' + l + '.json', JSON.stringify(data.socketHistory[l], null, 2), { mode: 0o600 });
        }
      }
      if (f === 'devices' && data.devices) {
        await fs.promises.writeFile(DEVICES_FILE, JSON.stringify(data.devices, null, 2), { mode: 0o600 });
        try { tuyaDevices = JSON.parse(JSON.stringify(data.devices)); } catch {}
      }
    }
    // Reload in-memory state after restore
    if (files.includes('scenes')) await loadScenes();
    sendJson(res, 200, { success: true, message: 'Restore complete. Changes applied immediately.' });
  } catch (err) {
    sendJson(res, 500, { success: false, message: err.message });
  }
});

// Main UI
route('GET', '/', (req, res) => {
  sendHtml(res, 200, getWebUI());
});

// PWA manifest
route('GET', '/manifest.json', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
  res.end(JSON.stringify({
    name: 'Energy Controller',
    short_name: 'Energy',
    description: 'Energy conservation controller dashboard',
    start_url: '/',
    display: 'standalone',
    background_color: '#000000',
    theme_color: '#000000',
    orientation: 'any',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  }));
});

// Service worker
route('GET', '/sw.js', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
  res.end(`
const CACHE = 'ecm-v5';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.map(x => caches.delete(x))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  if (e.request.url.includes('/api/') || e.request.destination === 'document') return;
  e.respondWith(fetch(e.request).then(resp => {
    if (resp.ok && e.request.method === 'GET') { const c = resp.clone(); caches.open(CACHE).then(cache => cache.put(e.request, c)); }
    return resp;
  }).catch(() => caches.match(e.request)));
});
`);
});

// PWA icons (SVG-based PNG placeholders)
route('GET', '/icon-:size.png', (req, res) => {
  const size = parseInt(req.params.size) || 192;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" rx="${size * 0.2}" fill="#000"/>
    <text x="50%" y="55%" text-anchor="middle" dominant-baseline="middle" font-family="system-ui" font-size="${size * 0.35}" font-weight="bold" fill="#bf5af2">&#9889;</text>
  </svg>`;
  res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
  res.end(svg);
});

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
function authMiddleware(req, res) {
  if (req.url === '/login' || req.url === '/api/login') return true;
  if (req.method === 'POST' && req.url === '/login') return true;
  if (req.url === '/sw.js' || req.url === '/manifest.json' || req.url === '/healthz') return true;
  if (req.url.startsWith('/vendor/')) return true;
  if (req.url.startsWith('/api/metrics')) return true;

  const cookies = parseCookies(req);
  const token = cookies['ecm_session'];
  if (token && isSessionValid(token)) {
    if (['POST', 'PATCH', 'DELETE'].includes(req.method) && req.url.startsWith('/api/')) {
      const csrf = getSessionCsrf(token);
      const header = req.headers['x-csrf-token'];
      if (!header || header !== csrf) {
        sendJson(res, 403, { success: false, message: 'CSRF token invalid' });
        return false;
      }
    }
    return true;
  }

  if (req.url.startsWith('/api/')) {
    sendJson(res, 401, { success: false, message: 'Unauthorized' });
    return false;
  }
  res.writeHead(302, { Location: '/login' });
  res.end();
  return false;
}

// ============================================================
// CREATE HTTP SERVER
// ============================================================
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const urlPath = url.pathname;

    // Auth middleware
    if (!authMiddleware(req, res)) return;

    // Rate limiting for API endpoints
    if (urlPath.startsWith('/api/')) {
      const ip = getClientIp(req);
      if (!rateLimit(ip)) {
        sendJson(res, 429, { success: false, message: 'Rate limit exceeded. Please slow down.' });
        return;
      }
    }

    // Find matching route
    const matched = matchRoute(req.method, urlPath);
    if (matched) {
      req.params = matched.params;
      req.body = {};
      if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
        req.body = await parseBody(req);
      }
      await matched.handler(req, res);
      return;
    }

    // Vendor static files
    if (urlPath.startsWith('/vendor/')) {
      const full = path.join(__dirname, 'public', urlPath.slice(1));
      if (full.startsWith(path.join(__dirname, 'public', 'vendor'))) {
        try {
          const data = fs.readFileSync(full);
          const ext = path.extname(full).toLowerCase();
          const mimes = { '.js':'application/javascript','.css':'text/css','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon' };
          res.writeHead(200, { 'Content-Type': mimes[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' });
          res.end(data);
        } catch {
          sendJson(res, 404, { error: 'Not found' });
        }
      } else {
        sendJson(res, 403, { error: 'Forbidden' });
      }
      return;
    }

    // 404
    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    log.error('Request error: ' + err.message);
    sendJson(res, 500, { error: err.message });
  }
});

// ============================================================
// WEB UI — LOGIN PAGE
// ============================================================
function getLoginPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1.0" />
<meta name="theme-color" content="#000000" />
<title>Login · Energy Controller</title>
<link href="/vendor/bootstrap-icons.css" rel="stylesheet" />
<style>
:root{--bg:#000;--card:rgba(28,28,30,.72);--border:rgba(255,255,255,.09);--text:#f5f5f7;--muted:#98989f;--primary:#bf5af2;--primary-dark:#a742d6;--danger:#ff453a}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{background:radial-gradient(circle at 20% 0%,#1c1030 0%,#000 45%),#000;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:1.5rem;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;color:var(--text)}
.card{width:100%;max-width:360px;background:var(--card);-webkit-backdrop-filter:blur(24px);backdrop-filter:blur(24px);border:.5px solid var(--border);border-radius:22px;padding:2rem 1.75rem;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.7);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);display:none;align-items:center;justify-content:center;z-index:999;padding:1.5rem}
.overlay.show{display:flex}
.icon{width:64px;height:64px;border-radius:18px;background:linear-gradient(135deg,var(--primary),#7c3aed);display:flex;align-items:center;justify-content:center;font-size:1.8rem;margin:0 auto 1rem}
h1{font-size:1.3rem;text-align:center;font-weight:700;margin-bottom:.25rem;letter-spacing:-.01em}
p.sub{text-align:center;color:var(--muted);font-size:.85rem;margin-bottom:1.5rem}
label{font-size:.75rem;color:var(--muted);display:block;margin-bottom:.35rem}
.field{margin-bottom:1rem}
input{width:100%;background:rgba(255,255,255,.06);border:.5px solid var(--border);border-radius:12px;color:var(--text);padding:.75rem .9rem;font-size:16px;min-height:46px}
input:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px rgba(191,90,242,.18)}
button{width:100%;min-height:46px;border:none;border-radius:980px;background:var(--primary);color:#fff;font-weight:600;font-size:.95rem;margin-top:.5rem;cursor:pointer;transition:transform .1s,filter .15s}
button:active{transform:scale(.97);filter:brightness(.9)}
button:disabled{opacity:.6}
.error{color:var(--danger);font-size:.82rem;text-align:center;margin-top:.85rem;min-height:1.1rem}



</style>
</head>
<body>
<form class="card" id="loginForm" autocomplete="on">
<div class="icon"><i class="bi bi-lightning-charge-fill"></i></div>
<h1>Energy Controller</h1>
<p class="sub">Sign in to continue</p>
<div class="field"><label>Username</label><input type="text" id="username" name="username" autocomplete="username" required /></div>
<div class="field"><label>Password</label><input type="password" id="password" name="password" autocomplete="current-password" required /></div>
<button type="submit" id="loginBtn">Sign In</button>
<div class="error" id="loginError"></div>
</form>
<div class="overlay" id="changeOverlay">
<div class="card" style="max-width:360px">
<div class="icon"><i class="bi bi-shield-lock-fill"></i></div>
<h1>Change Password</h1>
<p class="sub">First login requires a new password</p>
<div class="field"><label>New Password</label><input type="password" id="newPass" minlength="6" required /></div>
<div class="field"><label>Confirm Password</label><input type="password" id="confirmPass" minlength="6" required /></div>
<button type="button" id="changeBtn" onclick="doChange()">Set Password</button>
<div class="error" id="changeError"></div>
</div>
</div>
<script>
async function doChange(){
const btn=document.getElementById('changeBtn');
const err=document.getElementById('changeError');
const np=document.getElementById('newPass').value;
const cp=document.getElementById('confirmPass').value;
if(!np||np.length<6){err.textContent='Minimum 6 characters';return;}
if(np!==cp){err.textContent='Passwords do not match';return;}
btn.disabled=true;btn.textContent='Saving...';
try{
const r=await fetch('/api/change-password',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':window._csrfToken},body:JSON.stringify({currentPassword:window._tmpPass,newPassword:np})});
const d=await r.json();
if(d.success){document.getElementById('changeOverlay').classList.remove('show');window.location.href='/';}
else{err.textContent=d.message||'Error';btn.disabled=false;btn.textContent='Set Password';}
}catch(e){err.textContent='Connection error';btn.disabled=false;btn.textContent='Set Password';}
}
document.getElementById('loginForm').addEventListener('submit', async function(e){
e.preventDefault();
const btn=document.getElementById('loginBtn');
const err=document.getElementById('loginError');
err.textContent='';
btn.disabled=true;btn.textContent='Signing in...';
try{
const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
username:document.getElementById('username').value,
password:document.getElementById('password').value
})});
const d=await r.json();
if(d.success){
window._csrfToken=d.csrfToken;
if(d.mustChangePassword){window._tmpPass=document.getElementById('password').value;btn.disabled=false;btn.textContent='Sign In';document.getElementById('changeOverlay').classList.add('show');}
else{window.location.href='/';}
}
else{err.textContent=d.message||'Login error';btn.disabled=false;btn.textContent='Sign In';}
}catch(e){err.textContent='Connection error';btn.disabled=false;btn.textContent='Sign In';}
});
</script>
</body>
</html>`;
}

// ============================================================
// WEB UI — MAIN APP
// ============================================================
let _cachedWebUI = null;
function getWebUI() {
  if (_cachedWebUI) return _cachedWebUI;
  _cachedWebUI = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1.0" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="theme-color" content="#000000" />
<link rel="manifest" href="/manifest.json" />
<title>Energy Controller</title>
<link href="/vendor/bootstrap.min.css" rel="stylesheet" />
<link href="/vendor/bootstrap-icons.css" rel="stylesheet" />
<script src="/vendor/chart.umd.min.js"></script>
<style>
:root{
  --bg:#000000;
  --sidebar:rgba(28,28,30,.78);
  --card:rgba(28,28,30,.72);
  --card-solid:#1c1c1e;
  --border:rgba(255,255,255,.09);
  --separator:rgba(84,84,88,.48);
  --text:#f5f5f7;
  --muted:#98989f;
  --primary:#bf5af2;
  --primary-dark:#a742d6;
  --primary-light:#d18ffb;
  --success:#30d158;
  --danger:#ff453a;
  --blue:#0a84ff;
  --sidebar-e:250px;
  --radius-lg:20px;
  --radius-md:14px;
  --radius-sm:10px;
  --tabbar-h:56px;
  --safe-t:env(safe-area-inset-top,0px);
  --safe-b:env(safe-area-inset-bottom,0px);
  --safe-l:env(safe-area-inset-left,0px);
  --safe-r:env(safe-area-inset-right,0px);
}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html{-webkit-text-size-adjust:100%}
body{
  background:radial-gradient(circle at 20% 0%,#1c1030 0%,#000 45%),#000;
  background-attachment:fixed;
  color:var(--text);
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","Segoe UI",Roboto,Arial,sans-serif;
  display:flex;min-height:100vh;min-height:100dvh;
  -webkit-font-smoothing:antialiased;
  overscroll-behavior-y:none;
  overflow-x:hidden;
}
a{color:inherit}
.sidebar{position:fixed;top:0;left:0;width:var(--sidebar-e);height:100vh;height:100dvh;
  background:var(--sidebar);-webkit-backdrop-filter:saturate(180%) blur(24px);backdrop-filter:saturate(180%) blur(24px);
  border-right:.5px solid var(--separator);display:flex;flex-direction:column;z-index:1000;overflow:hidden;
  padding:calc(.6rem + var(--safe-t)) 0 .6rem;
  transform:translateX(-100%);transition:transform .25s cubic-bezier(.4,0,.2,1)}
.sidebar.open{transform:translateX(0)}
.sidebar-brand{padding:.5rem .9rem;font-size:1.4rem;color:var(--text);display:flex;align-items:center;gap:.6rem;
  border-bottom:.5px solid var(--separator);margin-bottom:.6rem;white-space:nowrap;overflow:hidden;position:relative}
.sidebar-brand i{color:var(--primary);font-size:1.4rem;flex-shrink:0}
.sidebar-brand .brand-version{font-size:.68rem;color:var(--muted);margin-left:auto}
.sidebar-menu{flex:1;list-style:none;padding:0 .4rem;margin:0;overflow:hidden}
.menu-item{padding:.65rem .7rem;margin:.15rem 0;display:flex;align-items:center;gap:.75rem;color:var(--muted);
  cursor:pointer;font-size:.92rem;white-space:nowrap;border-radius:var(--radius-sm);transition:background .15s,color .15s}
.menu-item:hover{color:var(--text);background:rgba(255,255,255,.06)}
.menu-item.active{color:var(--text);background:rgba(191,90,242,.16)}
.menu-item.active i{color:var(--primary)}
.menu-item i{font-size:1.25rem;width:1.6rem;text-align:center;flex-shrink:0;color:var(--muted)}
.menu-item .badge-hb{margin-left:auto}
.sidebar-footer{padding:.3rem .4rem;border-top:.5px solid var(--separator);display:flex;justify-content:space-around;align-items:center}
.power-item{display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;color:var(--muted);cursor:pointer;transition:background .15s,color .15s}
.power-item:hover{color:var(--text);background:rgba(255,255,255,.08)}
.power-item i{font-size:.9rem}
.power-item.c-primary{color:var(--muted)}.power-item.c-danger{color:var(--muted)}
.main{margin-left:0;flex:1;padding:calc(1.5rem + var(--safe-t)) 2rem 2rem;min-height:100vh;min-height:100dvh;
  max-width:100%;transition:margin-left .25s cubic-bezier(.4,0,.2,1)}
.sidebar.open~.main{margin-left:var(--sidebar-e);max-width:calc(100% - var(--sidebar-e))}

.sidebar-toggle{position:fixed;top:.75rem;left:0;z-index:1001;width:28px;height:28px;
  display:flex;align-items:center;justify-content:center;
  border-radius:0 8px 8px 0;background:var(--sidebar);
  border:.5px solid var(--separator);border-left:none;
  color:var(--muted);cursor:pointer;transition:left .25s cubic-bezier(.4,0,.2,1);
  box-shadow:0 1px 6px rgba(0,0,0,.4);font-size:.8rem}
.sidebar-toggle:hover{color:var(--text);background:var(--card)}
.sidebar.open~.sidebar-toggle{left:var(--sidebar-e)}
.page-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem;padding-bottom:.75rem;
  border-bottom:.5px solid var(--separator)}
.page-header h1{font-size:1.75rem;font-weight:700;letter-spacing:-.02em;color:var(--text);margin:0}
.hb-card{background:var(--card);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);
  border:.5px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;height:100%;
  display:flex;flex-direction:column;box-shadow:0 1px 0 rgba(255,255,255,.03) inset,0 10px 30px rgba(0,0,0,.35);
  contain:layout style}
.hb-card-header{padding:.85rem 1.25rem;border-bottom:.5px solid var(--separator);display:flex;justify-content:space-between;align-items:center}
.hb-card-title{font-weight:600;font-size:.98rem;margin:0;color:var(--text);letter-spacing:-.01em}
.hb-card-body{padding:1.1rem 1.25rem;flex:1;overflow:auto;-webkit-overflow-scrolling:touch}
.hb-card.collapsed .hb-card-body{display:none}
.hb-card.collapsed .hb-card-header{cursor:pointer}
.hb-card.collapsed .hb-card-header:hover{background:rgba(255,255,255,.03)}
.hb-card.collapsed .save-btn-h{display:none}
.hb-card.collapsed #syncBtn{display:none}
.tiles-container{display:flex;flex-wrap:wrap;gap:.75rem;margin-bottom:.75rem;contain:layout style}
.tiles-container .tile{flex:0 0 calc(25% - .5625rem);min-width:0}
.tile{background:var(--card);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);
  border:.5px solid var(--border);border-radius:var(--radius-md);padding:1rem .6rem;text-align:center;
  transition:border-color .2s,transform .12s;min-height:112px;display:flex;flex-direction:column;justify-content:center}
.tile:active{transform:scale(.97)}
.tile .icon{font-size:1.5rem;display:block;margin-bottom:.2rem;color:var(--muted)}
.tile .label{font-size:.66rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:.25rem;font-weight:600}
.tile .value{font-size:1.5rem;font-weight:700;color:var(--text);line-height:1.2;letter-spacing:-.01em}
.tile .sub{font-size:.72rem;color:var(--muted)}
.tile.on{border-color:rgba(48,209,88,.55)}.tile.on .value{color:var(--success)}.tile.on .icon{color:var(--success)}
.tile.off{border-color:rgba(255,69,58,.55)}.tile.off .value{color:var(--danger)}.tile.off .icon{color:var(--danger)}
.hb-card.collapsed #debug-grid{display:none!important}
.hb-card.collapsed .toggle-arrow{transform:rotate(0deg)}
.hb-card:not(.collapsed) .toggle-arrow{transform:rotate(180deg)}
.tile-edit-panel{display:none;padding:.5rem .75rem;background:rgba(255,255,255,.03);border-radius:var(--radius-sm);margin-bottom:.75rem}
.tile-edit-panel.open{display:block}
.tile-edit-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:.4rem}
.tile-edit-item{display:flex;align-items:center;gap:.4rem;padding:.4rem .6rem;border-radius:var(--radius-sm);background:rgba(255,255,255,.04);border:.5px solid var(--border);cursor:pointer;font-size:.75rem;color:var(--text);transition:background .15s;user-select:none}
.tile-edit-item input[type="checkbox"]{margin:0}
.tile-edit-arrows{display:flex;flex-direction:column;margin-left:auto;gap:0}
.tile-edit-arrows button{background:none;border:none;color:var(--muted);cursor:pointer;font-size:.6rem;padding:0 .15rem;line-height:1;transition:color .15s}
.tile-edit-arrows button:hover{color:var(--primary)}
.tile-edit-item:active{background:rgba(255,255,255,.08)}
.tile-edit-item input{accent-color:var(--primary)}
.tile-edit-item.hidden-tile{opacity:.4}
.tile-edit-cat{grid-column:1/-1;font-size:.7rem;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.05em;padding:.6rem 0 .2rem;border-bottom:1px solid var(--border);margin-top:.3rem}
#pull-indicator{position:fixed;top:0;left:50%;transform:translateX(-50%) translateY(-60px);width:40px;height:40px;border-radius:50%;background:rgba(30,30,32,.9);border:.5px solid var(--border);display:flex;align-items:center;justify-content:center;transition:transform .25s ease;z-index:200;pointer-events:none}
#pull-indicator.show{transform:translateX(-50%) translateY(20px)}
#pull-indicator.pulling{transform:translateX(-50%) translateY(40px)}
#pull-indicator i{color:var(--primary);font-size:1.1rem;transition:transform .25s}
#pull-indicator.refreshing i{animation:spin .8s linear infinite}
@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
.terminal{background:rgba(0,0,0,.55);border-radius:var(--radius-sm);padding:.6rem .8rem;
  font-family:'SF Mono','Menlo','Courier New',monospace;font-size:.74rem;color:var(--text);
  max-height:280px;overflow-y:auto;-webkit-overflow-scrolling:touch;white-space:pre-wrap;word-break:break-all;border:.5px solid var(--border)}
.log-line{padding:.08rem 0;color:var(--muted)}
.badge-hb{display:inline-block;padding:.2rem .65rem;border-radius:980px;font-size:.65rem;font-weight:600;
  text-transform:uppercase;letter-spacing:.02em}
.badge-hb.purple{background:rgba(191,90,242,.2);color:var(--primary-light)}
.badge-hb.online{background:rgba(48,209,88,.18);color:var(--success)}
.badge-hb.offline{background:rgba(255,69,58,.18);color:var(--danger)}
.badge-hb.active{background:rgba(48,209,88,.18);color:var(--success)}
.badge-hb.inactive{background:rgba(152,152,159,.18);color:var(--muted)}
.btn-hb{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;padding:.62rem 1.2rem;
  border-radius:980px;font-weight:600;font-size:.85rem;border:.5px solid transparent;cursor:pointer;
  background:rgba(255,255,255,.08);color:var(--text);min-height:44px;transition:transform .1s,filter .15s;
  -webkit-user-select:none;user-select:none}
.btn-hb:active{transform:scale(.96);filter:brightness(.9)}
.btn-hb-primary{background:var(--primary);color:#fff}
.btn-hb-primary:hover{background:var(--primary-dark);color:#fff}
.btn-hb-outline{background:rgba(255,255,255,.05);border-color:var(--border);color:var(--text)}
.btn-hb-outline:hover{border-color:var(--primary);color:var(--text)}
.btn-hb-sm{padding:.4rem .85rem;font-size:.75rem;min-height:34px}
.btn-hb-icon{padding:.45rem .6rem;font-size:.95rem;line-height:1;min-height:38px;min-width:38px}
.btn-hb-danger{background:var(--danger);color:#fff}
.btn-hb-danger:hover{background:#e0352b;color:#fff}
.btn-hb-success{background:var(--success);color:#04220c}
.btn-hb-success:hover{background:#28b94d;color:#04220c}
.form-hb{background:rgba(255,255,255,.06);border:.5px solid var(--border);border-radius:var(--radius-sm);
  color:var(--text);padding:.65rem .8rem;width:100%;font-size:16px;min-height:44px}
.form-hb:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px rgba(191,90,242,.18)}
select.form-hb{background-color:var(--card-solid);color-scheme:dark}
select.form-hb option{background-color:var(--card-solid);color:var(--text)}
select.form-hb option:checked,select.form-hb option:hover{background-color:var(--primary);color:#fff}
.sw{position:relative;display:inline-block;width:38px;height:22px;flex-shrink:0}
.sw input{opacity:0;width:0;height:0}
.sw-slider{position:absolute;inset:0;background:rgba(255,255,255,.12);border-radius:22px;cursor:pointer;transition:.25s}
.sw-slider::before{content:'';position:absolute;width:18px;height:18px;left:2px;bottom:2px;background:#fff;border-radius:50%;transition:.25s}
.sw input:checked+.sw-slider{background:var(--primary)}
.sw input:checked+.sw-slider::before{transform:translateX(16px)}
.empty-state{text-align:center;padding:2.25rem 1rem;color:var(--muted)}
.empty-state i{font-size:2.5rem;display:block;margin-bottom:.6rem;color:var(--border)}
.empty-state p{margin:0;font-size:.9rem}
.tab-pane{display:none;animation:fadeIn .25s ease}
.tab-pane.active{display:block}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.entity-card{background:var(--card);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);
  border:.5px solid var(--border);border-radius:var(--radius-md);transition:border-color .2s,transform .12s}
.entity-card:active{transform:scale(.98)}
.device-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:.9rem;align-items:start}
.device-card{padding:1.1rem}
.device-card.is-on{border-color:rgba(48,209,88,.4)}
.device-card-top{display:flex;align-items:center;gap:.6rem;margin-bottom:.6rem}
.device-icon{width:10px;height:10px;border-radius:50%;flex-shrink:0;transition:background .2s,box-shadow .2s}
.device-icon.on{background:var(--success);box-shadow:0 0 8px rgba(48,209,88,.7)}
.device-icon.off{background:var(--danger);box-shadow:0 0 6px rgba(255,69,58,.5)}
.device-icon.unknown{background:var(--muted)}
.device-icon.pulse{animation:iconPulse .6s ease}
@keyframes iconPulse{0%{transform:scale(1)}50%{transform:scale(1.8)}100%{transform:scale(1)}}
.device-name{font-weight:600;font-size:.95rem;color:var(--text);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.device-info{font-size:.75rem;color:var(--muted);margin-bottom:.7rem;word-break:break-all}
.device-toggle-group{display:flex;gap:.5rem}
.device-toggle-btn{flex:1;border:none;border-radius:980px;padding:.55rem 0;font-weight:600;font-size:.78rem;
  cursor:pointer;display:flex;align-items:center;justify-content:center;gap:.35rem;
  min-height:40px;transition:background .15s,color .15s,transform .1s}
.device-toggle-btn:active{transform:scale(.96)}
.device-toggle-btn.on{background:rgba(255,255,255,.06);color:var(--muted);border:.5px solid var(--border)}
.device-toggle-btn.on.active{background:var(--success);color:#04220c;border-color:var(--success)}
.device-toggle-btn.off{background:rgba(255,255,255,.06);color:var(--muted);border:.5px solid var(--border)}
.device-toggle-btn.off.active{background:var(--danger);color:#fff;border-color:var(--danger)}
.automation-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:.9rem;align-items:start}
.automation-card{padding:1.1rem}
.automation-card.is-active{border-color:rgba(48,209,88,.4)}
.automation-card-top{display:flex;align-items:center;gap:.6rem;margin-bottom:.6rem}
.automation-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
.automation-dot.on{background:var(--success);box-shadow:0 0 8px rgba(48,209,88,.7)}
.automation-dot.off{background:var(--muted)}
.automation-name{font-weight:600;color:var(--text);font-size:.9rem;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.automation-rule{font-size:.78rem;color:var(--muted);line-height:1.5;margin-bottom:.85rem;word-break:break-word}
.automation-rule b{color:var(--text);font-weight:600}
.automation-footer{display:flex;align-items:center;justify-content:flex-end;gap:.5rem}
.scene-traces{display:flex;flex-direction:column;gap:2px;margin-bottom:.5rem;font-size:.7rem;line-height:1.3;font-family:'SF Mono',SFMono-Regular,ui-monospace,'Fira Code',monospace}
.trace-item{display:flex;align-items:center;gap:.3rem;color:var(--muted);padding:2px 4px;border-radius:4px;background:rgba(255,255,255,.03)}
.trace-err{color:var(--danger);background:rgba(255,69,58,.08)}
.trace-ts{white-space:nowrap;color:var(--text-dim);min-width:4.5em;font-size:.65rem}
.trace-act{font-weight:600;white-space:nowrap;min-width:7em;font-size:.7rem}
.trace-d{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.flow-section{display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:.5rem;align-items:center}
.flow-svg-wrap{flex:1;min-width:260px}
.flow-svg-wrap svg{width:100%;height:auto;border-radius:var(--radius-md);background:var(--card);border:.5px solid var(--border);padding:.5rem}
.flow-metrics{display:flex;flex-wrap:wrap;gap:.35rem;min-width:200px}
.metric-card{flex:1;min-width:90px;background:var(--card);border:.5px solid var(--border);border-radius:var(--radius-md);padding:.5rem .65rem;display:flex;flex-direction:column;gap:2px}
.metric-lbl{font-size:.68rem;color:var(--muted);text-transform:uppercase;letter-spacing:.03em}
.metric-val{font-size:1rem;font-weight:700;color:var(--text)}
.metric-sub{font-size:.65rem;color:var(--muted)}
.hb-toast{position:fixed;bottom:calc(2rem + var(--safe-b));right:2rem;background:var(--card-solid);
  -webkit-backdrop-filter:blur(24px);backdrop-filter:blur(24px);border:.5px solid var(--border);
  border-radius:var(--radius-md);padding:.9rem 1.25rem;box-shadow:0 12px 40px rgba(0,0,0,.55);
  max-width:360px;z-index:9999;display:none;border-left:4px solid var(--success)}
.hb-toast.error{border-left-color:var(--danger)}
.toast-title{font-weight:700;margin-bottom:.2rem}
.toast-body{color:var(--muted);font-size:.85rem}
.hb-toast.show{display:block;animation:slideUp .3s cubic-bezier(.25,.8,.25,1)}
.modal-backdrop{display:none!important;position:fixed!important;inset:0!important;background:rgba(0,0,0,.5)!important;backdrop-filter:blur(20px)!important;-webkit-backdrop-filter:blur(20px)!important;z-index:999!important;align-items:center!important;justify-content:center!important}
.modal-backdrop.show{display:flex!important}
.modal-box{background:rgba(44,44,46,.85)!important;border:1px solid rgba(255,255,255,.18)!important;border-radius:16px!important;padding:2rem 1.5rem!important;max-width:360px!important;width:92%!important;text-align:center!important;box-shadow:0 8px 32px rgba(0,0,0,.4)!important;backdrop-filter:blur(40px)!important;-webkit-backdrop-filter:blur(40px)!important}
.modal-box h3{margin:0 0 .5rem!important;font-size:1.1rem!important;color:#fff!important}
.modal-box p{margin:0 0 1.4rem!important;font-size:.88rem!important;color:rgba(255,255,255,.6)!important}
.modal-btns{display:flex!important;gap:.6rem!important;justify-content:center!important}
.modal-btns .btn-hb{flex:1!important;max-width:160px!important}
#restartOverlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);backdrop-filter:blur(30px);-webkit-backdrop-filter:blur(30px);z-index:9999;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:#fff}
#restartOverlay.show{display:flex}
.restart-spinner{width:48px;height:48px;border:3px solid rgba(255,255,255,.15);border-top-color:var(--primary);border-radius:50%;animation:restartSpin .8s linear infinite;margin-bottom:1.2rem}
@keyframes restartSpin{to{transform:rotate(360deg)}}
#restartOverlay h3{font-size:1.1rem;margin:0 0 .5rem;font-weight:600}
#restartOverlay p{font-size:.85rem;color:rgba(255,255,255,.6);margin:0}
#restartOverlay .check-icon{width:48px;height:48px;border-radius:50%;background:rgba(34,197,94,.2);display:flex;align-items:center;justify-content:center;margin-bottom:1.2rem;animation:fadeInScale .4s cubic-bezier(.25,.8,.25,1)}
#restartOverlay .check-icon i{color:#22c55e;font-size:1.5rem}
@keyframes fadeInScale{from{opacity:0;transform:scale(.5)}to{opacity:1;transform:scale(1)}}
.restart-dots::after{content:'';animation:restartDots 1.5s steps(4,end) infinite}
@keyframes restartDots{0%{content:''}25%{content:'.'}50%{content:'..'}75%{content:'...'}100%{content:''}}
@keyframes slideUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
.spinner-hb{display:inline-block;width:1rem;height:1rem;border:2px solid rgba(255,255,255,.25);
  border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:8px}
::-webkit-scrollbar-thumb:hover{background:var(--primary)}
.rule-row{display:flex;gap:.5rem;align-items:center;margin-bottom:.6rem;flex-wrap:wrap;
  background:rgba(255,255,255,.04);border:.5px solid var(--border);border-radius:var(--radius-sm);padding:.6rem}
.rule-row .rule-field{flex:1;min-width:120px}
.rule-row .rule-field-sm{flex:0 0 100px}
.rule-row .rule-remove{flex-shrink:0}
.text-muted-hb{color:var(--muted)}
.mb-3{margin-bottom:.75rem}
.mb-3 label{display:block;margin-bottom:.35rem}
.mt-2{margin-top:.5rem}
.w-100{width:100%}
.mobile-only{display:none}
.chart-section{margin-top:1rem;content-visibility:auto;contain-intrinsic-size:0 350px}
.chart-section+.hb-card{margin-top:1rem}
.chart-current{display:flex;flex-wrap:wrap;gap:.4rem .8rem;padding:.35rem .75rem .1rem;font-size:.75rem;color:#98989f}
.chart-current .cc-item{display:flex;align-items:center;gap:.3rem}
.chart-current .cc-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.chart-current .cc-val{color:#f5f5f7;font-weight:600;font-variant-numeric:tabular-nums}
.chart-tabs{display:flex;gap:.4rem;margin-bottom:.75rem}
.chart-tab{padding:.4rem .85rem;border-radius:980px;font-size:.75rem;cursor:pointer;border:1px solid var(--border);background:rgba(255,255,255,.05);color:var(--text);transition:all .15s;min-height:34px;display:inline-flex;align-items:center;justify-content:center}
.chart-tab.active{border-color:var(--primary);color:var(--text)}
.chart-tab:hover{border-color:var(--primary);color:var(--text)}
.chart-wrap{position:relative;height:220px;width:100%}
@media(max-width:768px){.chart-wrap{height:180px}}
.device-controls{display:flex;gap:.5rem;align-items:center}
.device-controls .btn-hb{padding:.4rem .9rem;font-size:.75rem}
.backup-opt{display:flex;align-items:center;gap:.45rem;padding:.35rem .5rem;border-radius:6px;cursor:pointer;font-size:.82rem;color:var(--text);transition:background .15s}
.backup-opt:hover{background:rgba(255,255,255,.05)}
.backup-opt input[type=checkbox]{accent-color:var(--primary);width:16px;height:16px;cursor:pointer}
.wdays{display:flex;flex-wrap:wrap;gap:.3rem}
.wday-lbl{display:flex;align-items:center;gap:.2rem;font-size:.72rem;color:var(--text);padding:.2rem .35rem;border-radius:6px;cursor:pointer;background:rgba(255,255,255,.05)}
.wday-lbl input{accent-color:var(--primary)}
.update-tag{display:flex;align-items:center;justify-content:space-between;padding:.5rem .75rem;border-radius:8px;cursor:pointer;font-size:.82rem;border:.5px solid var(--border);margin-bottom:.35rem;transition:background .15s,border-color .15s;color:var(--text)}
.update-tag:hover{background:rgba(255,255,255,.06);border-color:var(--muted)}
.update-tag.active{background:var(--primary);color:#fff;border-color:var(--primary)}
@media(max-width:768px){
  .mobile-only{display:block}
  body{display:block;overflow-x:hidden}
  .sidebar,.sidebar.open{top:auto;bottom:0;left:0;width:100%;height:auto;overflow:visible;transform:none;
    padding:.35rem 0 calc(.35rem + var(--safe-b));
    flex-direction:row;align-items:stretch;justify-content:space-around;
    border-right:none;border-top:.5px solid var(--separator);
    background:rgba(20,20,22,.82);-webkit-backdrop-filter:saturate(180%) blur(28px);backdrop-filter:saturate(180%) blur(28px)}
  .sidebar-brand,.sidebar-footer,.sidebar-toggle{display:none}
  .sidebar-menu{display:flex;flex-direction:row;justify-content:space-around;align-items:stretch;flex:1;padding:0;overflow:visible}
  .menu-item{flex-direction:column;justify-content:center;align-items:center;gap:.15rem;padding:.3rem .4rem;
    margin:0;border-radius:var(--radius-sm);flex:1;min-width:0;background:none!important}
  .menu-item.active{background:none!important}
  .menu-item i{font-size:1.4rem;width:auto}
  .menu-item span:not(.badge-hb){opacity:1;font-size:.66rem;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
  .menu-item .badge-hb{opacity:1;position:absolute;margin-left:0;transform:translate(10px,-14px);padding:.05rem .4rem;font-size:.55rem}
  .menu-item{position:relative}
  .main,.sidebar.open~.main{margin-left:0;max-width:100%;padding:calc(1rem + var(--safe-t)) 1rem calc(var(--tabbar-h) + var(--safe-b) + 1.5rem)}
  .page-header{position:sticky;top:calc(-1rem - var(--safe-t));margin:calc(-1rem - var(--safe-t)) -1rem 1rem;
    padding:calc(.85rem + var(--safe-t)) 1rem .85rem;z-index:50;
    background:rgba(0,0,0,.65);-webkit-backdrop-filter:saturate(180%) blur(20px);backdrop-filter:saturate(180%) blur(20px);
    border-bottom:.5px solid var(--separator)}
  .page-header h1{font-size:1.5rem}
  .tiles-container .tile{flex:0 0 calc(50% - .375rem)}
  .tile{min-height:100px}
  .device-grid{grid-template-columns:1fr;gap:.75rem}
  .device-card{padding:.9rem;min-width:0;overflow:hidden}
  .device-card-top{gap:.5rem}
  .device-name{font-size:.85rem}
  .device-toggle-group{gap:.5rem}
  .device-toggle-btn{padding:.45rem .6rem;font-size:.75rem}
  .device-info{font-size:.7rem}
  .automation-grid{grid-template-columns:1fr}
  .automation-card{padding:.9rem}
  .hb-card{border-radius:var(--radius-md);overflow:hidden}
  .hb-card-body{padding:.9rem 1rem;overflow:hidden}
  .rule-row{flex-direction:column;align-items:stretch}
  .rule-row .rule-field,.rule-row .rule-field-sm{width:100%;min-width:0;flex:1}
  .rule-row .rule-remove{align-self:flex-end}
  .item-actions{width:100%;justify-content:flex-start;margin-left:0}
  .device-controls{width:100%}
  .device-controls .btn-hb{flex:1}
  .hb-toast{left:1rem;right:1rem;bottom:calc(var(--tabbar-h) + var(--safe-b) + 1rem);max-width:none}
  .btn-hb-primary.w-100{position:sticky;bottom:0}
}
@media(max-width:380px){
  .tiles-container .tile{flex:0 0 calc(50% - .375rem)}
  .tile .value{font-size:1.3rem}
  .device-grid{grid-template-columns:1fr;gap:.6rem}
  .device-card{padding:.8rem;min-width:0;overflow:hidden}
  .device-card-top{gap:.4rem}
  .device-name{font-size:.8rem}
  .device-toggle-btn{padding:.4rem .5rem;font-size:.7rem}
}
@media (hover:none) and (pointer:coarse) and (min-width:769px){
  .sidebar.open{width:210px;padding-top:calc(.5rem + var(--safe-t));padding-left:var(--safe-l)}
  .main,.sidebar.open~.main{margin-left:210px;max-width:calc(100% - 210px);padding:calc(1.25rem + var(--safe-t)) 1.5rem 1.5rem}
  .device-grid{grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}
  .rule-row .rule-field{min-width:160px}
}
@media (hover:none) and (pointer:coarse) and (min-width:1080px){
  .device-grid{grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
}

@keyframes sheetUp{from{transform:translateY(100%)}to{transform:translateY(0)}}
@keyframes sheetIn{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:scale(1)}}
.type-sheet-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.55);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);display:none;align-items:flex-end;justify-content:center;z-index:1002}
.type-sheet-backdrop.show{display:flex}
.type-sheet{width:100%;max-width:400px;background:var(--card-solid);border-radius:20px 20px 0 0;padding:1.1rem 1rem calc(1.1rem + var(--safe-b));max-height:70vh;overflow-y:auto;animation:sheetUp .22s ease;margin:0 auto}
.type-sheet h4{font-size:.95rem;margin-bottom:.9rem;text-align:center;color:var(--text)}
.type-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:.6rem}
.type-tile{display:flex;flex-direction:column;align-items:center;gap:.4rem;padding:.9rem .5rem;background:rgba(255,255,255,.05);border:1px solid var(--border);border-radius:var(--radius-md);cursor:pointer;transition:background .15s,border-color .15s}
.type-tile:hover{background:rgba(191,90,242,.15);border-color:var(--primary)}
.type-tile:active{transform:scale(.96);background:rgba(191,90,242,.18)}
.type-tile i{font-size:1.4rem;color:var(--primary-light)}
@media(min-width:770px){.type-sheet-backdrop{align-items:center}.type-sheet{border-radius:20px;padding:1.3rem;animation:sheetIn .2s ease;max-width:420px}.type-grid{grid-template-columns:repeat(5,1fr);gap:.5rem}}
.chip-select,.chip-input{appearance:none;-webkit-appearance:none;background:rgba(191,90,242,.14);border:1px solid rgba(191,90,242,.35);color:var(--primary-light);font-weight:600;font-size:.82rem;padding:.4rem .8rem;border-radius:980px;min-height:34px;cursor:pointer}
.chip-input{background:rgba(255,255,255,.08);border-color:var(--border);color:var(--text);text-align:center;cursor:text;font-weight:500;-moz-appearance:textfield}
.chip-input::-webkit-inner-spin-button,.chip-input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
.chip-input[type=time]{min-width:96px}
.chip-input[type=number]{width:64px}
.chip-label{display:inline-flex;align-items:center;gap:.35rem;font-size:.82rem;font-weight:600;white-space:nowrap}
.rule-sentence{display:flex;flex-wrap:wrap;align-items:center;gap:.45rem;padding:.7rem .8rem;background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:var(--radius-md);margin-bottom:.5rem}
.rule-sentence .rule-remove-x{margin-left:auto;flex-shrink:0}
.rule-sentence .wdays{display:flex;flex-wrap:wrap;gap:.3rem}
.rule-sentence .wday-lbl{display:flex;align-items:center;gap:.2rem;font-size:.7rem;color:var(--muted);background:rgba(255,255,255,.05);padding:.25rem .5rem;border-radius:8px;cursor:pointer}
.rule-sentence .wday-lbl:has(input:checked){background:rgba(191,90,242,.2);color:var(--primary-light)}
.rule-sentence .chip-label.type-battery i{color:#22c55e}
.rule-sentence .chip-label.type-grid i{color:#f59e0b}
.rule-sentence .chip-label.type-time i{color:#3b82f6}
.rule-sentence .chip-label.type-weekday i{color:#a855f7}
.rule-sentence .chip-label.type-device_online i{color:#14b8a6}
.automation-section{border-left:3px solid var(--blue);padding-left:.8rem;margin-bottom:1rem}
.automation-section.then-section{border-left-color:var(--success)}
.automation-section-label{display:flex;align-items:center;gap:.4rem;font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:700;margin-bottom:.55rem}
.automation-summary{background:linear-gradient(135deg,rgba(191,90,242,.12),rgba(10,132,255,.08));border:1px solid rgba(191,90,242,.25);border-radius:var(--radius-md);padding:.8rem 1rem;margin-bottom:1rem;font-size:.85rem;line-height:1.55;color:var(--text)}
.automation-summary b{color:var(--primary-light)}
.rule-sentence details.advanced-fields{width:100%;margin-top:.4rem;font-size:.75rem;color:var(--muted)}
.rule-sentence details.advanced-fields summary{cursor:pointer;color:var(--blue);list-style:none;display:flex;align-items:center;gap:.3rem}
.rule-sentence details.advanced-fields[open] summary{margin-bottom:.4rem}
.rule-sentence details.advanced-fields summary i.bi{transition:transform .2s;font-size:.65rem}
.rule-sentence details.advanced-fields[open] summary i.bi{transform:rotate(90deg)}
.rule-sentence .action-notify{display:flex;flex:1;gap:.5rem;align-items:center;min-width:0}
.rule-sentence .action-notify input{flex:1;min-width:80px}
@media(min-width:770px){.rule-sentence{flex-wrap:nowrap;gap:.5rem;padding:.5rem .8rem} .rule-sentence .chip-select{max-width:160px} .rule-sentence .chip-input[type=number]{width:72px} }

.type-tile span{font-size:.72rem;color:var(--text);text-align:center}
</style>

</head>
<body>
<aside class="sidebar open">
<div class="sidebar-brand"><i class="bi bi-lightning-charge-fill"></i><span class="brand-main">Energy</span><span class="brand-version" id="sidebar-version"></span></div>
<ul class="sidebar-menu">
<li class="menu-item active" data-tab="status"><i class="bi bi-speedometer2"></i><span>Status</span></li>
<li class="menu-item" data-tab="devices"><i class="bi bi-cpu"></i><span>Devices</span><span class="badge-hb purple" id="sidebar-device-count">0</span></li>
<li class="menu-item" data-tab="automations"><i class="bi bi-diagram-3"></i><span>Automations</span><span class="badge-hb purple" id="sidebar-scene-count">0</span></li>
<li class="menu-item" data-tab="server"><i class="bi bi-server"></i><span>Server</span></li>
<li class="menu-item" data-tab="settings"><i class="bi bi-gear"></i><span>Settings</span></li>
</ul>
<div class="sidebar-footer">
<div class="power-item" onclick="location.reload()" title="Restart UI"><i class="bi bi-arrow-clockwise"></i></div>
<div class="power-item c-primary" onclick="document.getElementById('restartModal').classList.add('show')" title="Restart App"><i class="bi bi-arrow-repeat"></i></div>
<div class="power-item c-danger" onclick="logout()" title="Log Out"><i class="bi bi-box-arrow-right"></i></div>
</div>
</aside>
<button class="sidebar-toggle" onclick="toggleSidebar()" title="Toggle sidebar"><i class="bi bi-chevron-left"></i></button>
<main class="main">
<div class="tab-pane active" id="tab-status">
<div id="pull-indicator"><i class="bi bi-arrow-down"></i></div>
<div class="page-header"><h1>Status</h1></div>
<div class="tiles-container" id="tilesContainer"></div>
<div class="flow-section" id="flowSection"><div class="flow-metrics" id="flowMetrics"></div><div class="flow-svg-wrap"><svg id="energyFlow" viewBox="0 0 400 190" xmlns="http://www.w3.org/2000/svg"></svg></div></div>
<div class="hb-card chart-section collapsed" style="margin-bottom:.75rem">
<div class="hb-card-header" style="cursor:pointer" onclick="this.parentElement.classList.toggle('collapsed')"><div class="hb-card-title"><i class="bi bi-cpu" style="margin-right:.5rem"></i>Inverter Debug</div></div>
<div id="debug-grid" style="padding:.5rem .75rem;font-size:.78rem;font-family:monospace;color:var(--text);display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:.25rem .75rem"></div>
</div>
<div class="hb-card chart-section">
<div class="hb-card-header"><div class="hb-card-title"><i class="bi bi-graph-up" style="margin-right:.5rem"></i>Power History</div><div class="chart-tabs" id="chartTabs"><div class="chart-tab" data-period="1h">1h</div><div class="chart-tab" data-period="3h">3h</div><div class="chart-tab" data-period="6h">6h</div><div class="chart-tab" data-period="12h">12h</div><div class="chart-tab active" data-period="day">Day</div><div class="chart-tab" data-period="week">Week</div><div class="chart-tab" data-period="month">Month</div><div class="chart-tab" data-period="year">Year</div></div></div>
<div class="chart-current" id="historyCurrent"></div>
<div class="hb-card-body" style="padding:.5rem .75rem"><div class="chart-wrap"><canvas id="historyChart"></canvas></div></div>
</div>
<div class="hb-card chart-section">
<div class="hb-card-header"><div class="hb-card-title"><i class="bi bi-plug" style="margin-right:.5rem"></i>Socket Power History</div><div class="chart-tabs" id="socketChartTabs"><div class="chart-tab" data-period="1h">1h</div><div class="chart-tab" data-period="3h">3h</div><div class="chart-tab" data-period="6h">6h</div><div class="chart-tab" data-period="12h">12h</div><div class="chart-tab active" data-period="day">Day</div><div class="chart-tab" data-period="week">Week</div><div class="chart-tab" data-period="month">Month</div><div class="chart-tab" data-period="year">Year</div></div></div>
<div class="chart-current" id="socketCurrent"></div>
<div class="hb-card-body" style="padding:.5rem .75rem"><div class="chart-wrap"><canvas id="socketChart"></canvas></div></div>
</div>
<div class="hb-card chart-section">
<div class="hb-card-header"><div class="hb-card-title"><i class="bi bi-lightning" style="margin-right:.5rem"></i>Other Load</div><div class="chart-tabs" id="otherChartTabs"><div class="chart-tab" data-period="1h">1h</div><div class="chart-tab" data-period="3h">3h</div><div class="chart-tab" data-period="6h">6h</div><div class="chart-tab" data-period="12h">12h</div><div class="chart-tab active" data-period="day">Day</div><div class="chart-tab" data-period="week">Week</div><div class="chart-tab" data-period="month">Month</div><div class="chart-tab" data-period="year">Year</div></div></div>
<div class="chart-current" id="otherCurrent"></div>
<div class="hb-card-body" style="padding:.5rem .75rem"><div class="chart-wrap"><canvas id="otherChart"></canvas></div></div>
</div>
<div class="hb-card">
<div class="hb-card-header"><div class="hb-card-title">Logs</div></div>
<div class="hb-card-body" style="padding:.5rem"><div class="terminal" id="log-container">Loading logs...</div></div>
</div>
</div>
<div class="tab-pane" id="tab-devices">
<div class="page-header"><h1>Devices</h1></div>
<div class="hb-card collapsed">
<div class="hb-card-header" style="cursor:pointer" onclick="this.parentElement.classList.toggle('collapsed')"><div class="hb-card-title"><i class="bi bi-arrow-repeat" style="margin-right:.5rem"></i>Sync with Tuya</div><span><button class="btn-hb btn-hb-outline btn-hb-sm" id="syncBtn" onclick="event.stopPropagation();syncTuya()"><i class="bi bi-arrow-repeat"></i> Sync Devices</button></span></div>
<div class="hb-card-body"><p class="text-muted-hb">Pull devices from your Tuya account.</p></div>
</div>
<div class="hb-card" style="margin-top:1rem">
<div class="hb-card-header"><div class="hb-card-title">Available Devices</div><span class="badge-hb purple" id="device-count-badge">0</span></div>
<div class="hb-card-body" id="devices-list"><div class="empty-state"><i class="bi bi-inbox"></i><p>No devices synced yet.</p></div></div>
</div>
</div>
<div class="tab-pane" id="tab-automations">
<div class="page-header"><h1>Automations</h1></div>
<div class="hb-card collapsed" id="new-automation-card">
<div class="hb-card-header" onclick="toggleNewAutomation()"><div class="hb-card-title"><i class="bi bi-plus-circle" style="margin-right:.5rem"></i>New Automation</div><span><button class="btn-hb btn-hb-outline btn-hb-sm save-btn-h" onclick="event.stopPropagation();saveScene()" style="margin-left:.5rem"><i class="bi bi-save"></i> Save</button></span></div>
<div class="hb-card-body">
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Name</label><input type="text" id="scene-name" class="form-hb" placeholder="e.g. Battery Saver" oninput="renderAutomationSummary()" /></div>
<div id="automation-summary" class="automation-summary">Add a condition and an action to see a preview here.</div>
<div class="automation-section">
<div class="automation-section-label"><i class="bi bi-arrow-down-right-circle"></i> WHEN</div>
<select id="scene-logic" class="form-hb" style="margin-bottom:.6rem;font-size:.8rem" onchange="renderAutomationSummary()"><option value="AND">Match ALL conditions</option><option value="OR">Match ANY condition</option></select>
<div id="if-conditions"></div>
<button class="btn-hb btn-hb-outline btn-hb-sm mt-2" onclick="addCondition()"><i class="bi bi-plus"></i> Add Condition</button>
</div>
<div class="automation-section then-section">
<div class="automation-section-label"><i class="bi bi-lightning-charge-fill"></i> THEN</div>
<div id="then-actions"></div>
<button class="btn-hb btn-hb-outline btn-hb-sm mt-2" onclick="addAction()"><i class="bi bi-plus"></i> Add Action</button>
</div>
</div>
</div>
<div class="hb-card" style="margin-top:1rem">
<div class="hb-card-header"><div class="hb-card-title">Saved Automations</div><span class="badge-hb purple" id="scene-count-badge2">0</span></div>
<div class="hb-card-body" id="scenes-list"><div class="empty-state"><i class="bi bi-diagram-3"></i><p>No automations yet.</p></div></div>
</div>
</div>
<div class="tab-pane" id="tab-server">
<div class="page-header"><h1>Server</h1></div>
<div class="hb-card">
<div class="hb-card-header"><div class="hb-card-title"><i class="bi bi-cpu"></i> System Resources</div></div>
<div class="hb-card-body" id="server-info-body">
<div style="text-align:center;padding:1rem"><i class="bi bi-hourglass-split"></i> Loading...</div>
</div>
</div>
</div>
<div class="tab-pane" id="tab-settings">
<div class="page-header"><h1>Settings</h1></div>
<div class="hb-card collapsed">
<div class="hb-card-header" style="cursor:pointer" onclick="this.parentElement.classList.toggle('collapsed')"><div class="hb-card-title"><i class="bi bi-pencil-square" style="margin-right:.5rem"></i>Status Tiles</div><span><button class="btn-hb btn-hb-outline btn-hb-sm save-btn-h" onclick="event.stopPropagation();saveTilePrefs(loadTilePrefs());saveTileOrder(loadTileOrder());buildTileEditor();"><i class="bi bi-save"></i> Save</button></span></div>
<div class="hb-card-body">
<div class="tile-edit-grid" id="tileEditGrid"></div>
</div>
</div>
<div class="hb-card collapsed" style="margin-top:1rem">
<div class="hb-card-header" style="cursor:pointer" onclick="this.parentElement.classList.toggle('collapsed')"><div class="hb-card-title"><i class="bi bi-plug" style="margin-right:.5rem"></i>Inverter</div><span><button class="btn-hb btn-hb-outline btn-hb-sm save-btn-h" onclick="event.stopPropagation();savePluginConfig()"><i class="bi bi-save"></i> Save</button></span></div>
<div class="hb-card-body">
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Inverter IP</label><input type="text" id="cfg-inverter-ip" class="form-hb" placeholder="192.168.0.116" /></div>
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Serial Number</label><input type="text" id="cfg-inverter-serial" class="form-hb" placeholder="2317564280" /></div>
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Modbus Port</label><input type="number" id="cfg-inverter-port" class="form-hb" value="8899" /></div>
</div>
</div>
<div class="hb-card collapsed" style="margin-top:1rem">
<div class="hb-card-header" style="cursor:pointer" onclick="this.parentElement.classList.toggle('collapsed')"><div class="hb-card-title"><i class="bi bi-cloud" style="margin-right:.5rem"></i>Tuya Cloud</div><span><button class="btn-hb btn-hb-outline btn-hb-sm save-btn-h" onclick="event.stopPropagation();savePluginConfig()"><i class="bi bi-save"></i> Save</button></span></div>
<div class="hb-card-body">
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Access ID</label><input type="text" id="cfg-tuya-accessId" class="form-hb" placeholder="Enter Tuya Access ID" /></div>
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Access Key</label><input type="password" id="cfg-tuya-accessKey" class="form-hb" placeholder="Enter Tuya Access Key" /></div>
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Country Code</label><input type="number" id="cfg-tuya-countryCode" class="form-hb" value="48" /></div>
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Username / Email</label><input type="text" id="cfg-tuya-username" class="form-hb" placeholder="user@example.com" /></div>
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Password</label><input type="password" id="cfg-tuya-password" class="form-hb" placeholder="&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;" /></div>
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">App Schema</label><select id="cfg-tuya-appSchema" class="form-hb"><option value="tuyaSmart">Tuya Smart</option><option value="smartlife">Smart Life</option></select></div>
</div>
</div>
<div class="hb-card collapsed" style="margin-top:1rem">
<div class="hb-card-header" style="cursor:pointer" onclick="this.parentElement.classList.toggle('collapsed')"><div class="hb-card-title"><i class="bi bi-globe" style="margin-right:.5rem"></i>Web UI</div><span><button class="btn-hb btn-hb-outline btn-hb-sm save-btn-h" onclick="event.stopPropagation();savePluginConfig()"><i class="bi bi-save"></i> Save</button></span></div>
<div class="hb-card-body">
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Web Port</label><input type="number" id="cfg-webPort" class="form-hb" value="8583" /></div>
</div>
</div>
<div class="hb-card collapsed" style="margin-top:1rem">
<div class="hb-card-header" style="cursor:pointer" onclick="this.parentElement.classList.toggle('collapsed')"><div class="hb-card-title"><i class="bi bi-shield-lock" style="margin-right:.5rem"></i>Security</div><span><button class="btn-hb btn-hb-outline btn-hb-sm save-btn-h" onclick="event.stopPropagation();changePassword()"><i class="bi bi-key"></i> Update</button></span></div>
<div class="hb-card-body">
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Current password</label><input type="password" id="cp-current" class="form-hb" autocomplete="current-password" /></div>
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">New password (min. 6 characters)</label><input type="password" id="cp-new" class="form-hb" autocomplete="new-password" /></div>
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Confirm new password</label><input type="password" id="cp-confirm" class="form-hb" autocomplete="new-password" /></div>
</div>
</div>
<div class="hb-card collapsed" style="margin-top:1rem">
<div class="hb-card-header" style="cursor:pointer" onclick="this.parentElement.classList.toggle('collapsed')"><div class="hb-card-title"><i class="bi bi-bell" style="margin-right:.5rem"></i>Notifications</div><span><button class="btn-hb btn-hb-outline btn-hb-sm save-btn-h" onclick="event.stopPropagation();saveNotifConfig()"><i class="bi bi-save"></i> Save</button></span></div>
<div class="hb-card-body">
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.6rem;padding:.4rem .6rem;border-radius:8px;background:rgba(255,255,255,.04)"><span style="font-size:.85rem;font-weight:600"><i class="bi bi-bell" style="margin-right:.4rem"></i>Enable notifications</span><label class="sw"><input type="checkbox" id="cfg-notif-enabled" checked onchange="document.getElementById('notif-body-rest').style.display=this.checked?'block':'none'"><span class="sw-slider"></span></label></div>
<div id="notif-body-rest">
<div id="notif-integrations">
<div style="display:flex;align-items:center;justify-content:space-between;margin:.4rem 0;padding:.4rem .6rem;border-radius:8px;background:rgba(255,255,255,.04)" id="notif-ntfy-row"><span style="font-size:.85rem"><i class="bi bi-bell" style="margin-right:.4rem"></i>Via ntfy.sh</span><label class="sw"><input type="checkbox" id="cfg-ntfy-notif-enabled" checked><span class="sw-slider"></span></label></div>
<div style="display:flex;align-items:center;justify-content:space-between;margin:.4rem 0;padding:.4rem .6rem;border-radius:8px;background:rgba(255,255,255,.04)" id="notif-tg-row"><span style="font-size:.85rem"><i class="bi bi-telegram" style="margin-right:.4rem"></i>Via Telegram</span><label class="sw"><input type="checkbox" id="cfg-tg-notif-enabled" checked><span class="sw-slider"></span></label></div>
</div>
<div style="display:flex;align-items:center;justify-content:space-between;margin:.6rem 0;padding:.4rem .6rem;border-radius:8px;background:rgba(255,255,255,.04)"><span style="font-size:.85rem;font-weight:600"><i class="bi bi-exclamation-triangle" style="margin-right:.4rem"></i>Critical alerts</span><label class="sw"><input type="checkbox" id="cfg-notif-critical-enabled" checked onchange="document.getElementById('critical-fields').style.display=this.checked?'block':'none'"><span class="sw-slider"></span></label></div>
<div id="critical-fields">
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Low SOC alert (%)</label><input type="number" id="cfg-soc-alert" class="form-hb" min="0" max="100" /></div>
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Connection timeout (min)</label><input type="number" id="cfg-conn-timeout" class="form-hb" min="0" /></div>
</div>
<div style="display:flex;align-items:center;justify-content:space-between;margin:.6rem 0;padding:.4rem .6rem;border-radius:8px;background:rgba(255,255,255,.04)"><span style="font-size:.85rem;font-weight:600"><i class="bi bi-lightning" style="margin-right:.4rem"></i>Grid outage report</span><label class="sw"><input type="checkbox" id="cfg-notif-grid-outage" checked><span class="sw-slider"></span></label></div>
<button class="btn-hb btn-hb-outline btn-hb-sm" onclick="testNotification()" style="width:100%"><i class="bi bi-send"></i> Send Test</button>
<div id="notif-status" style="margin-top:.6rem;font-size:.8rem;display:none"></div>
</div>
</div>
</div>
<div class="hb-card collapsed" style="margin-top:1rem">
<div class="hb-card-header" style="cursor:pointer" onclick="this.parentElement.classList.toggle('collapsed')"><div class="hb-card-title"><i class="bi bi-cash-coin" style="margin-right:.5rem"></i>Tariff & Cost</div><span><button class="btn-hb btn-hb-outline btn-hb-sm save-btn-h" onclick="event.stopPropagation();saveTariffConfig()"><i class="bi bi-save"></i> Save</button></span></div>
<div class="hb-card-body">
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Currency</label><input type="text" id="cfg-tariff-currency" class="form-hb" placeholder="UAH" maxlength="8" /></div>
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Tariff type</label><select id="cfg-tariff-type" class="form-hb" onchange="toggleTariffFields()"><option value="flat">Flat rate</option><option value="daynight">Day / Night</option></select></div>
<div id="tariff-flat-fields"><div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Rate (per kWh)</label><input type="number" step="0.01" min="0" id="cfg-tariff-flat-rate" class="form-hb" placeholder="0" /></div></div>
<div id="tariff-daynight-fields">
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Day rate (per kWh)</label><input type="number" step="0.01" min="0" id="cfg-tariff-day-rate" class="form-hb" placeholder="0" /></div>
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Night rate (per kWh)</label><input type="number" step="0.01" min="0" id="cfg-tariff-night-rate" class="form-hb" placeholder="0" /></div>
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Day tariff starts</label><input type="time" id="cfg-tariff-day-start" class="form-hb" value="07:00" /></div>
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Night tariff starts</label><input type="time" id="cfg-tariff-night-start" class="form-hb" value="23:00" /></div>
</div>
<p class="text-muted-hb" style="font-size:.72rem;margin-top:-.4rem">Estimate only, based on the inverter's daily import counter. Not billing-grade.</p>
<div id="tariff-status" style="margin-top:.4rem;font-size:.8rem;display:none"></div>
</div>
</div>
<div class="hb-card collapsed" style="margin-top:1rem">
<div class="hb-card-header" style="cursor:pointer" onclick="this.parentElement.classList.toggle('collapsed')"><div class="hb-card-title"><i class="bi bi-hdd-network" style="margin-right:.5rem"></i>Integrations</div><span><button class="btn-hb btn-hb-outline btn-hb-sm save-btn-h" onclick="event.stopPropagation();savePluginConfig()"><i class="bi bi-save"></i> Save</button></span></div>
<div class="hb-card-body">
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.6rem;padding:.4rem .6rem;border-radius:8px;background:rgba(255,255,255,.04)"><span style="font-size:.85rem;font-weight:600"><i class="bi bi-bell" style="margin-right:.4rem"></i>ntfy.sh</span><label class="sw"><input type="checkbox" id="cfg-ntfy-enabled" checked onchange="document.getElementById('ntfy-fields').style.display=this.checked?'block':'none'"><span class="sw-slider"></span></label></div>
<div id="ntfy-fields">
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Topic</label><input type="text" id="cfg-ntfy-topic" class="form-hb" placeholder="my-topic" /></div>
</div>
<div style="display:flex;align-items:center;justify-content:space-between;margin:.8rem 0 .6rem;padding:.4rem .6rem;border-radius:8px;background:rgba(255,255,255,.04)"><span style="font-size:.85rem;font-weight:600"><i class="bi bi-telegram" style="margin-right:.4rem"></i>Telegram</span><label class="sw"><input type="checkbox" id="cfg-tg-enabled" checked onchange="document.getElementById('tg-fields').style.display=this.checked?'block':'none'"><span class="sw-slider"></span></label></div>
<div id="tg-fields">
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Bot Token</label><input type="password" id="cfg-tg-token" class="form-hb" placeholder="123456:ABC-DEF1234..." /></div>
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Chat ID</label><input type="text" id="cfg-tg-chat" class="form-hb" placeholder="-1001234567890" /></div>
</div>
</div>
</div>
<div class="hb-card collapsed" style="margin-top:1rem">
<div class="hb-card-header" style="cursor:pointer" onclick="this.parentElement.classList.toggle('collapsed')"><div class="hb-card-title"><i class="bi bi-cloud-download" style="margin-right:.5rem"></i>Application Update</div><span><button class="btn-hb btn-hb-outline btn-hb-sm save-btn-h" id="btn-check-update" onclick="event.stopPropagation();checkForUpdates()"><i class="bi bi-arrow-clockwise"></i> Check</button></span></div>
<div class="hb-card-body">
<div id="update-info" style="font-size:.85rem;color:var(--text-secondary);margin-bottom:.75rem">Loading...</div>
<div id="update-branches" style="display:none;margin-bottom:.75rem"></div>
<div id="update-tags" style="display:none;margin-bottom:.75rem"></div>
<button class="btn-hb btn-hb-outline btn-hb-sm" id="btn-apply-update" onclick="applyUpdate()" style="display:none;width:100%"><i class="bi bi-download"></i> Update & Restart</button>
<div id="update-status" style="margin-top:.6rem;font-size:.8rem;display:none"></div>
</div>
</div>
<div class="hb-card collapsed" style="margin-top:1rem">
<div class="hb-card-header" style="cursor:pointer" onclick="this.parentElement.classList.toggle('collapsed')"><div class="hb-card-title"><i class="bi bi-archive" style="margin-right:.5rem"></i>Backup & Restore</div></div>
<div class="hb-card-body">
<div style="display:flex;gap:.5rem;flex-wrap:wrap">
<button class="btn-hb btn-hb-outline btn-hb-sm" onclick="createBackup()"><i class="bi bi-download"></i> Backup</button>
<button class="btn-hb btn-hb-outline btn-hb-sm" onclick="document.getElementById('restoreInput').click()"><i class="bi bi-upload"></i> Restore</button>
<input type="file" id="restoreInput" accept=".json" style="display:none" onchange="restoreBackup(this.files[0])" />
</div>
<div id="backup-status" style="margin-top:.6rem;font-size:.8rem;display:none"></div>
</div>
</div>
<div class="hb-card mobile-only" style="margin-top:1rem">
<div class="hb-card-header"><div class="hb-card-title"><i class="bi bi-phone" style="margin-right:.5rem"></i>Session</div></div>
<div class="hb-card-body">
<div style="display:flex;flex-direction:column;gap:.6rem">
<button class="btn-hb btn-hb-outline w-100" onclick="location.reload()"><i class="bi bi-arrow-clockwise"></i> Restart UI</button>
<button class="btn-hb btn-hb-outline btn-hb-sm" onclick="document.getElementById('restartModal').classList.add('show')"><i class="bi bi-arrow-repeat"></i> Restart App</button>
<button class="btn-hb btn-hb-outline btn-hb-sm" onclick="logout()"><i class="bi bi-box-arrow-right"></i> Log Out</button>
</div>
</div>
</div>

</div>
<div class="hb-toast" id="toast"><div class="toast-title" id="toastTitle">Success</div><div class="toast-body" id="toastBody">Done.</div></div>
<div class="modal-backdrop" id="restartModal" style="background:#000!important"><div class="modal-box" style="background:#1c1c1e!important;border:1px solid rgba(255,255,255,.15)!important;border-radius:14px!important;padding:1.8rem 1.5rem!important;max-width:340px;width:90%;text-align:center;box-shadow:0 12px 48px rgba(0,0,0,.7)!important"><div style="width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,.08);display:flex;align-items:center;justify-content:center;margin:0 auto 1rem"><i class="bi bi-arrow-repeat" style="font-size:1.3rem;color:var(--primary)"></i></div><h3 style="margin:0 0 .5rem;font-size:1.05rem;color:#f5f5f7!important">Restart now?</h3><p style="margin:0 0 1.2rem;font-size:.85rem;color:#a1a1a6!important">Changes will be applied after restart.</p><div style="display:flex;gap:.6rem;justify-content:center"><button class="btn-hb btn-hb-primary btn-hb-sm" onclick="restartApp()" style="flex:1;max-width:160px"><i class="bi bi-arrow-repeat"></i> Restart</button><button class="btn-hb btn-hb-outline btn-hb-sm" onclick="document.getElementById('restartModal').classList.remove('show')" style="flex:1;max-width:160px">Later</button></div></div></div>
<div id="restartOverlay"><div class="restart-spinner"></div><h3>Restarting<span class="restart-dots"></span></h3><p>Waiting for server to come back online</p></div>
<div class="modal-backdrop" id="tileDetailModal" style="background:rgba(0,0,0,.6)!important" onclick="if(event.target===this)closeTileDetail()"><div class="modal-box" style="background:#1c1c1e!important;border:1px solid rgba(255,255,255,.15)!important;border-radius:14px!important;padding:1.2rem!important;max-width:420px;width:92%;box-shadow:0 12px 48px rgba(0,0,0,.7)!important">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.8rem"><h3 id="tileDetailTitle" style="margin:0;font-size:1rem;color:#f5f5f7!important">\u2014</h3><button class="btn-hb btn-hb-sm btn-hb-icon btn-hb-outline" onclick="closeTileDetail()"><i class="bi bi-x"></i></button></div>
<div id="tileDetailStats" style="display:flex;gap:.8rem;margin-bottom:.8rem;font-size:.78rem;color:#a1a1a6"></div>
<div style="height:180px"><canvas id="tileDetailChart"></canvas></div>
</div></div>
</main>
<script>
let tuyaDevices=[];
let _csrfToken=null;
document.querySelectorAll('.menu-item').forEach(item=>{
item.addEventListener('click',function(){
const tab=this.dataset.tab;
document.querySelectorAll('.menu-item').forEach(m=>m.classList.remove('active'));
this.classList.add('active');
document.querySelectorAll('.tab-pane').forEach(p=>p.classList.remove('active'));
const pane=document.getElementById('tab-'+tab);
if(pane)pane.classList.add('active');
const titles={status:'Status',devices:'Devices',automations:'Automations',server:'Server',settings:'Settings'};
const h1=pane.querySelector('.page-header h1');
if(h1)h1.textContent=titles[tab]||tab;
if(tab==='status'){loadStatus();loadLogs();loadHistory();loadSocketHistory();loadOtherHistory();}
if(tab==='devices')loadTuyaDevices();
if(tab==='automations'){loadScenes();populateDeviceSelects();}
if(tab==='server')loadServerInfo();
if(tab==='settings'){loadPluginConfig();loadAppVersion();}
});
});
function showToast(t,b,e){const el=document.getElementById('toast');document.getElementById('toastTitle').textContent=t;document.getElementById('toastBody').textContent=b;el.className='hb-toast show'+(e?' error':'');clearTimeout(el._hide);el._hide=setTimeout(()=>el.classList.remove('show'),4000);}
function handleAuthStatus(r){if(r.status===401){window.location.href='/login';throw new Error('Unauthorized');}return r;}
async function apiGet(p){const r=handleAuthStatus(await fetch(p));if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}
async function apiPost(p,b){const h={'Content-Type':'application/json'};if(_csrfToken)h['X-CSRF-Token']=_csrfToken;const r=handleAuthStatus(await fetch(p,{method:'POST',headers:h,body:JSON.stringify(b)}));if(!r.ok){let msg='HTTP '+r.status;try{const e=await r.json();if(e.message)msg=e.message;}catch{}throw new Error(msg);}return r.json();}
async function apiDelete(p){const h={};if(_csrfToken)h['X-CSRF-Token']=_csrfToken;const r=handleAuthStatus(await fetch(p,{method:'DELETE',headers:h}));if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}
async function apiPatch(p,b){const h={'Content-Type':'application/json'};if(_csrfToken)h['X-CSRF-Token']=_csrfToken;const r=handleAuthStatus(await fetch(p,{method:'PATCH',headers:h,body:JSON.stringify(b)}));if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}
async function loadStatus(){
try{
const d=await apiGet('/api/status');
if(d.csrfToken)_csrfToken=d.csrfToken;
updateTiles(d,d.debug||{});
renderEnergyFlow(d);
const dg=d.debug||{};
const dgEl=document.getElementById('debug-grid');
if(dgEl){
const groups=[
{title:'DC Block (48-111)',items:[
['reg59 overallState',dg.overallState],['reg60 dayActive',dg.dayActiveEnergy+' kWh'],
['reg65 monthPV',dg.monthPV+' kWh'],['reg66 monthLoad',dg.monthLoad+' kWh'],['reg67 monthGrid',dg.monthGrid+' kWh'],
['reg70 dayBatChg',dg.dayBatCharge+' kWh'],['reg71 dayBatDisch',dg.dayBatDischarge+' kWh'],
['reg72-73 totalBatChg',dg.totalBatCharge+' kWh'],['reg74-75 totalBatDisch',dg.totalBatDischarge+' kWh'],
['reg76 dayGridImp',dg.dayGridImport+' kWh'],['reg77 dayGridExp',dg.dayGridExport+' kWh'],
['reg79 gridFreq',dg.gridFreq+' Hz'],['reg81-82 totalGridExp',dg.totalGridExport+' kWh'],
['reg84 dayLoad',dg.dayLoadEnergy+' kWh'],['reg85-86 totalLoad',dg.totalLoadEnergy+' kWh'],
['reg90 dcTransfTemp',dg.dcTransfTemp+' °C'],['reg91 radiatorTemp',dg.radiatorTemp+' °C'],
['reg95 envTemp',dg.envTemp+' °C'],['reg96-97 totalPV',dg.totalPV+' kWh'],
['reg98-99 yearGridExp',dg.yearGridExport+' kWh'],['reg78+80 totalGridImp',dg.totalGridImport+' kWh'],
['reg103 fault1',dg.fault1],['reg104 fault2',dg.fault2],['reg105 fault3',dg.fault3],['reg106 fault4',dg.fault4],
['reg108 dayPV',dg.dayPV+' kWh'],['reg109 pv1V',dg.pv1Voltage+' V'],['reg110 pv1A',dg.pv1Current+' A'],['reg111 pv2V',dg.pv2Voltage+' V']
]},
{title:'AC Block (150-249)',items:[
['reg150 gridV',dg.gridVoltage+' V'],['reg154 invV',dg.inverterVoltage+' V'],
['reg160 gridI1',dg.gridCurrent1],['reg161 gridI2',dg.gridCurrent2],
['reg164 invI',dg.inverterCurrent+' A'],['reg166 auxPower',dg.auxPower+' W'],
['reg167 gridL1',dg.gridL1Power+' W'],['reg169 gridPwr',dg.gridPower+' W'],
['reg172 gridCT',dg.gridCTPower+' W'],['reg175 invPwr',dg.inverterPower+' W'],
['reg178 loadPwr',dg.loadPower+' W'],['reg179 offGridMode',dg.offGridMode],
['reg182 batTemp',dg.batteryTemp+' °C'],['reg183 batV',dg.batteryVoltage+' V'],
['reg184 batSOC',dg.batterySOC+' %'],['reg186 pv1Pwr',dg.pv1Power+' W'],
['reg187 pv2Pwr',dg.pv2Power+' W'],['reg190 batPwr',dg.batteryPower+' W'],
['reg191 batI',dg.batteryCurrent+' A'],['reg192 loadFreq',dg.loadFreq+' Hz'],
['reg193 invFreq',dg.inverterFreq+' Hz'],['reg194 gridConn',dg.gridConnected]
]},
{title:'Settings (200-249)',items:[
['reg200 ctrlMode',dg.controlMode],['reg201 batEqV',dg.batteryEqVoltage+' V'],
['reg202 batAbsV',dg.batteryAbsVoltage+' V'],['reg203 batFloatV',dg.batteryFloatVoltage+' V'],
['reg209 upsDelay',dg.upsDelayTime],['reg210 batMaxChgI',dg.batMaxChargeCurrent],
['reg211 batMaxDisI',dg.batMaxDischargeCurrent],['reg217 batShdSOC',dg.batShutdownSOC],
['reg218 batRstSOC',dg.batRestartSOC],['reg219 batLowSOC',dg.batLowSOC],
['reg220 batShdV',dg.batShutdownVoltage+' V'],['reg221 batRstV',dg.batRestartVoltage+' V'],
['reg222 batLowV',dg.batLowVoltage+' V'],['reg228 remoteCfg',dg.remoteConfig],
['reg230 gridChg',dg.gridChargeEnabled],['reg243 priorityLoad',dg.priorityLoad],
['reg244 loadLimit',dg.loadLimit],['reg245 maxSell',dg.maxSellPower],
['reg247 solarExport',dg.solarExport],['reg248 useTimer',dg.useTimer]
]}
];
const dgHash=JSON.stringify(dg);
if(dgEl._lastHash!==dgHash){dgEl._lastHash=dgHash;
dgEl.innerHTML=groups.map(g=>'<div style="grid-column:1/-1;font-weight:600;margin-top:.35rem;color:var(--accent)">'+g.title+'</div>'+
g.items.map(([k,v])=>'<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><span style="color:var(--muted)">'+k+':</span> <b>'+(v==null?'—':v)+'</b></div>').join('')).join('');
}}
}catch(e){console.error('loadStatus',e);}
}
async function loadLogs(){
try{
const d=await apiGet('/api/logs');
const c=document.getElementById('log-container');
if(d.success&&d.logs){
const lines=d.logs.split('\\n').slice(-50);
const html=lines.map(l=>'<div class="log-line">'+escHtml(l)+'</div>').join('');
if(c._lastHtml!==html){c._lastHtml=html;c.innerHTML=html;c.scrollTop=c.scrollHeight;}
}else c.innerHTML='<div class="log-line">No logs available</div>';
}catch(e){document.getElementById('log-container').innerHTML='<div class="log-line">Error loading logs</div>';}
}
async function loadTuyaDevices(){
try{
tuyaDevices=await apiGet('/api/tuya-devices');
document.getElementById('device-count-badge').textContent=tuyaDevices.length;
document.getElementById('sidebar-device-count').textContent=tuyaDevices.length;
const list=document.getElementById('devices-list');
if(tuyaDevices.length===0){list.innerHTML='<div class="empty-state"><i class="bi bi-inbox"></i><p>No devices synced yet.</p></div>';populateDeviceSelects();return;}
list.innerHTML='<div class="device-grid">'+tuyaDevices.map(d=>{
const onlineBadge=d.online?'<span class="badge-hb online">Online</span>':'<span class="badge-hb offline">Offline</span>';
const iconClass=d.switch===true?'on':(d.switch===false?'off':'unknown');
const activeOn=d.switch===true?' active':'';
const activeOff=d.switch===false?' active':'';
const idSafe=escHtml(d.id);
return '<div class="entity-card device-card'+(d.switch===true?' is-on':'')+'">'
+'<div class="device-card-top"><span class="device-icon '+iconClass+'"></span><span class="device-name">'+escHtml(d.name)+'</span>'+onlineBadge+'</div>'
+'<div class="device-info">ID: '+idSafe+'</div>'
+'<div class="device-toggle-group">'
+'<button class="device-toggle-btn on'+activeOn+'" onclick="controlDevice(\\''+idSafe+'\\',true,this)"><i class="bi bi-power"></i> ON</button>'
+'<button class="device-toggle-btn off'+activeOff+'" onclick="controlDevice(\\''+idSafe+'\\',false,this)"><i class="bi bi-power"></i> OFF</button>'
+'</div></div>';
}).join('')+'</div>';
populateDeviceSelects();
}catch(e){console.error('loadTuyaDevices',e);}
}
async function controlDevice(id,value,btnEl){
const card=btnEl?btnEl.closest('.device-card'):null;
let iconEl=null,prevClass='';
if(card){
card.querySelectorAll('.device-toggle-btn').forEach(b=>b.classList.remove('active'));
const targetBtn=card.querySelector('.device-toggle-btn.'+(value?'on':'off'));
if(targetBtn)targetBtn.classList.add('active');
card.classList.toggle('is-on',value);
iconEl=card.querySelector('.device-icon');
if(iconEl){prevClass=iconEl.className;iconEl.className='device-icon '+(value?'on':'off')+' pulse';}
}
const dev=tuyaDevices.find(d=>d.id===id);
if(dev)dev.switch=value;
try{
const r=await apiPost('/api/tuya-control',{deviceId:id,value});
if(!r.success){showToast('Error',r.message||'Control failed',true);if(iconEl)iconEl.className=prevClass;}
}catch(e){showToast('Error',e.message,true);if(iconEl)iconEl.className=prevClass;}
finally{if(iconEl)setTimeout(()=>iconEl.classList.remove('pulse'),600);}
}
async function syncTuya(){
const btn=document.getElementById('syncBtn');
btn.disabled=true;btn.innerHTML='<span class="spinner-hb"></span> Syncing...';
try{const d=await apiPost('/api/sync-tuya',{});if(d.success){await loadTuyaDevices();}else showToast('Sync error',d.message||'Unknown error',true);}
catch(e){showToast('Sync error',e.message,true);}
finally{btn.disabled=false;btn.innerHTML='<i class="bi bi-arrow-repeat"></i> Sync Devices';}
}
async function loadScenes(){
try{
const scenes=await apiGet('/api/scenes');
const traceRes=await fetch('/api/scene-traces');
const traceData=traceRes.ok?await traceRes.json():{traces:{}};
const allTraces=traceData.traces||{};
document.getElementById('scene-count-badge2').textContent=scenes.length;
document.getElementById('sidebar-scene-count').textContent=scenes.length;
const list=document.getElementById('scenes-list');
if(scenes.length===0){list.innerHTML='<div class="empty-state"><i class="bi bi-diagram-3"></i><p>No automations yet.</p></div>';return;}
list.innerHTML='<div class="automation-grid">'+scenes.map(s=>{
const lg=s.if&&s.if.logic==='OR'?' OR ':' AND ';
const ifT=(s.if&&s.if.conditions)?s.if.conditions.map(c=>{
if(c.type==='grid')return 'Grid '+(c.value?'ON':'OFF');
if(c.type==='battery')return 'Battery '+(c.operator||'=')+' '+c.value+'%';
if(c.type==='time')return 'Time '+c.after+'-'+c.before;
if(c.type==='weekday'&&c.days){const wd=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];return c.days.map(d=>wd[d]).join('/');}
if(c.type==='device_online'){const dev=tuyaDevices.find(d=>d.id===c.value);return (dev?dev.name:'Device')+' '+(c.expectedStatus?'Online':'Offline');}
return '';
}).join(lg):'\\u2014';
const thenT=(s.then&&s.then.actions)?s.then.actions.map(a=>{
if(a.type==='notify')return '\ud83d\udd14 '+(a.title||a.message||'Notify');
const dev=tuyaDevices.find(d=>d.id===a.device);
const dn=dev?dev.name:a.device;
let t=dn+' \\u2192 '+(a.value?'ON':'OFF');
if(a.duration>0)t+=' for '+a.duration+'min';
if(a.interval>0)t+=' every '+a.interval+'min';
return t;
}).join(', '):'\\u2014';
const en=s.enabled!==false;
const toggleBtn=en
?'<button class="btn-hb btn-hb-sm btn-hb-icon" style="background:rgba(255,69,58,.15);color:var(--danger)" onclick="toggleScene(\\''+escHtml(s.name)+'\\',false,this)" title="Pause"><i class="bi bi-pause-fill"></i></button>'
:'<button class="btn-hb btn-hb-sm btn-hb-icon" style="background:rgba(48,209,88,.15);color:var(--success)" onclick="toggleScene(\\''+escHtml(s.name)+'\\',true,this)" title="Resume"><i class="bi bi-play-fill"></i></button>';
const sceneT=allTraces[s.name];
let traceHtml='';
if(sceneT&&sceneT.length){
const last=sceneT.slice(-3).reverse();
traceHtml='<div class="scene-traces">'+last.map(t=>{
const d=new Date(t.ts);
const tm=d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0')+':'+d.getSeconds().toString().padStart(2,'0');
let lbl=t.action;
if(t.action==='apply')lbl='Applied';
else if(t.action==='revert (timeout)')lbl='Revert (timeout)';
else if(t.action==='revert (conditions)')lbl='Revert (changed)';
else if(t.action.endsWith(':error'))lbl='Error';
const err=t.action.endsWith(':error');
return '<span class="trace-item'+(err?' trace-err':'')+'"><span class="trace-ts">'+tm+'</span><span class="trace-act">'+lbl+'</span><span class="trace-d">'+(t.detail||'')+'</span></span>';
}).join('')+'</div>';
}
return '<div class="entity-card automation-card'+(en?' is-active':'')+'">'
+'<div class="automation-card-top"><span class="automation-dot '+(en?'on':'off')+'"></span><span class="automation-name">'+escHtml(s.name)+'</span><span class="badge-hb '+(en?'active':'inactive')+'">'+(en?'Active':'Paused')+'</span></div>'
+'<div class="automation-rule"><b>IF</b> '+escHtml(ifT)+' <b>\u2192 THEN</b> '+escHtml(thenT)+'</div>'
+traceHtml
+'<div class="automation-footer">'+toggleBtn+'<button class="btn-hb btn-hb-outline btn-hb-sm btn-hb-icon" onclick="runSceneNow(\\\''+escHtml(s.name)+'\\\',this)" title="Run now"><i class="bi bi-play-circle"></i></button><button class="btn-hb btn-hb-outline btn-hb-sm btn-hb-icon" onclick="deleteScene(\\\''+escHtml(s.name)+'\\\')"><i class="bi bi-trash"></i></button></div>'
+'</div>';
}).join('')+'</div>';
}catch(e){console.error('loadScenes',e);}
}
async function toggleScene(name,enabled,btnEl){
const card=btnEl?btnEl.closest('.automation-card'):null;
if(card){
card.classList.toggle('is-active',enabled);
const dot=card.querySelector('.automation-dot');
if(dot){dot.classList.remove('on','off');dot.classList.add(enabled?'on':'off');}
const badge=card.querySelector('.badge-hb.active,.badge-hb.inactive');
if(badge){badge.classList.remove('active','inactive');badge.classList.add(enabled?'active':'inactive');badge.textContent=enabled?'Active':'Paused';}
}
try{const r=await apiPatch('/api/scenes/'+encodeURIComponent(name),{enabled});if(!r.success)showToast('Error',r.message||'Toggle failed',true);loadScenes();}
catch(e){showToast('Error',e.message,true);loadScenes();}
}
async function deleteScene(n){
if(!confirm('Delete automation "'+n+'"?'))return;
try{await apiDelete('/api/scenes/'+encodeURIComponent(n));loadScenes();}
catch(e){showToast('Error',e.message,true);}
}
async function runSceneNow(name,btnEl){
if(btnEl)btnEl.disabled=true;
try{
const r=await apiPost('/api/scenes/'+encodeURIComponent(name)+'/run',{});
if(r.success){
const failed=(r.results||[]).filter(x=>!x.ok);
showToast(failed.length?'Ran with errors':'Ran','"'+name+'" applied'+(failed.length?' ('+failed.length+' failed)':''),!!failed.length);
}else{showToast('Error',r.message||'Run failed',true);}
loadScenes();
}catch(e){showToast('Error',e.message,true);}
finally{if(btnEl)btnEl.disabled=false;}
}
function toggleNewAutomation(){
document.getElementById('new-automation-card').classList.toggle('collapsed');
}
function expandNewAutomation(){
const card=document.getElementById('new-automation-card');
if(card.classList.contains('collapsed'))card.classList.remove('collapsed');
}
function addCondition(){
expandNewAutomation();
openTypeSheet('Add Condition', CONDITION_TYPES, function(type){
const c=document.getElementById('if-conditions');
const r=document.createElement('div');r.className='rule-sentence';r.dataset.type=type;
renderConditionRow(r,type);
c.appendChild(r);
renderAutomationSummary();
});
}
function renderConditionRow(r,type){
var meta=CONDITION_TYPES.find(function(t){return t.value===type;});
var body='<span class="chip-label type-'+type+'"><i class="bi '+meta.icon+'"></i> '+meta.label+'</span>';
if(type==='battery'){
body+='<select class="chip-select condition-operator"><option value="<">is below</option><option value=">">is above</option><option value="=">equals</option></select><input type="number" class="chip-input condition-value" placeholder="20" min="0" max="100" />%';
}else if(type==='grid'){
body+='<select class="chip-select condition-value"><option value="true">is ON</option><option value="false">is OFF</option></select>';
}else if(type==='time'){
body+='<span class="text-muted-hb" style="font-size:.78rem">between</span><input type="time" class="chip-input condition-after" value="00:00" /><span class="text-muted-hb" style="font-size:.78rem">and</span><input type="time" class="chip-input condition-before" value="23:59" />';
}else if(type==='weekday'){
body+='<span class="wdays">'+["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(function(d,i){return '<label class="wday-lbl"><input type="checkbox" class="wday-cb" value="'+i+'"'+(i>0&&i<6?' checked':'')+' />'+d+'</label>';}).join('')+'</span>';
}else if(type==='device_online'){
body+='<select class="chip-select condition-device"><option value="">\u2014 device \u2014</option>'+tuyaDevices.map(function(d){return '<option value="'+d.id+'">'+d.name+'</option>';}).join('')+'</select><select class="chip-select condition-device-status"><option value="true">Online</option><option value="false">Offline</option></select>';
}
body+='<button class="rule-remove-x btn-hb btn-hb-sm btn-hb-icon btn-hb-outline" onclick="this.closest(\\'.rule-sentence\\').remove();renderAutomationSummary()"><i class="bi bi-x"></i></button>';
r.innerHTML=body;
r.querySelectorAll('select,input').forEach(function(el){el.addEventListener('input',renderAutomationSummary);});
}
function addAction(){
expandNewAutomation();
openTypeSheet('Add Action', ACTION_TYPES, function(type){
var c=document.getElementById('then-actions');
var r=document.createElement('div');r.className='rule-sentence';r.dataset.type=type;
renderActionRow(r,type);
c.appendChild(r);
renderAutomationSummary();
});
}
function renderActionRow(r,type){
var body;
if(type==='tuya'){
var opts=tuyaDevices.map(function(d){return '<option value="'+escHtml(d.id)+'">'+escHtml(d.name)+'</option>';}).join('');
body='<select class="chip-select action-device"><option value="">\u2014 device \u2014</option>'+opts+'</select><select class="chip-select action-value"><option value="true">turn ON</option><option value="false">turn OFF</option></select><details class="advanced-fields"><summary><i class="bi bi-chevron-right"></i> duration / interval <span class="text-muted-hb" style="font-weight:400;font-size:.75rem">(optional)</span></summary><div style="display:flex;gap:.5rem;margin-top:.3rem"><input type="number" class="chip-input action-duration" placeholder="min" min="0" style="width:70px" /><input type="number" class="chip-input action-interval" placeholder="min" min="0" style="width:70px" /></div></details>';
}else{
body='<div class="action-notify"><i class="bi bi-bell-fill" style="color:var(--primary-light);flex-shrink:0"></i><input type="text" class="chip-input action-title" placeholder="Title" style="flex:1" /><input type="text" class="chip-input action-message" placeholder="Message" style="flex:1" /></div>';
}
body+='<button class="rule-remove-x btn-hb btn-hb-sm btn-hb-icon btn-hb-outline" onclick="this.closest(\\'.rule-sentence\\').remove();renderAutomationSummary()"><i class="bi bi-x"></i></button>';
r.innerHTML=body;
r.querySelectorAll('select,input').forEach(function(el){el.addEventListener('input',renderAutomationSummary);});
}
function renderAutomationSummary(){
var el=document.getElementById('automation-summary');
if(!el)return;
var logicSel=document.getElementById('scene-logic');
var isOr=logicSel&&logicSel.value==='OR';
var condParts=[];
document.querySelectorAll('#if-conditions > .rule-sentence').forEach(function(r){
var type=r.dataset.type;
if(type==='battery'){
var op=r.querySelector('.condition-operator').value;
var val=r.querySelector('.condition-value').value||'0';
var opText=op==='<'?'below':op==='>'?'above':'equal to';
condParts.push('Battery is '+opText+' '+val+'%');
}else if(type==='grid'){
condParts.push('Grid is '+(r.querySelector('.condition-value').value==='true'?'ON':'OFF'));
}else if(type==='time'){
condParts.push('time is between '+r.querySelector('.condition-after').value+' and '+r.querySelector('.condition-before').value);
}else if(type==='weekday'){
var days=[].map.call(r.querySelectorAll('.wday-cb:checked'),function(c){return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][+c.value];});
condParts.push('day is '+(days.join(', ')||'\u2014'));
}else if(type==='device_online'){
var dev=r.querySelector('.condition-device');
var dn=dev.options[dev.selectedIndex]?dev.options[dev.selectedIndex].text:'\u2026';
condParts.push(dn+' is '+(r.querySelector('.condition-device-status').value==='true'?'Online':'Offline'));
}
});
var actionParts=[];
document.querySelectorAll('#then-actions > .rule-sentence').forEach(function(r){
var type=r.dataset.type;
if(type==='notify'){
actionParts.push('notify "'+(r.querySelector('.action-title').value||'\u2026')+'"');
}else{
var devSel=r.querySelector('.action-device');
var dn=devSel.options[devSel.selectedIndex]?devSel.options[devSel.selectedIndex].textContent:'\u2026';
var val=r.querySelector('.action-value').value==='true'?'ON':'OFF';
actionParts.push('turn '+dn+' '+val);
}
});
if(!condParts.length&&!actionParts.length){
el.innerHTML='<span class=\"text-muted-hb\">Add a condition and an action to see a preview here.</span>';
return;
}
var joiner=isOr?' <span class=\"text-muted-hb\">or</span> ':' <span class=\"text-muted-hb\">and</span> ';
el.innerHTML='When <b>'+(condParts.join(joiner)||'\u2026')+'</b>, then <b>'+(actionParts.join(', ')||'\u2026')+'</b>.';
}
function closeTypeSheet(){
var sheet=document.getElementById('typeSheetBackdrop');
if(sheet)sheet.classList.remove('show');
}
var CONDITION_TYPES=[{value:'battery',icon:'bi-battery-half',label:'Battery Level'},{value:'grid',icon:'bi-plug-fill',label:'City Grid'},{value:'time',icon:'bi-clock-fill',label:'Time of Day'},{value:'weekday',icon:'bi-calendar-week',label:'Day of Week'},{value:'device_online',icon:'bi-wifi',label:'Device Online'}];
var ACTION_TYPES=[{value:'tuya',icon:'bi-toggle-on',label:'Device'},{value:'notify',icon:'bi-bell-fill',label:'Notify'}];
function openTypeSheet(title,options,onPick){
var sheet=document.getElementById('typeSheetBackdrop');
if(!sheet){
sheet=document.createElement('div');
sheet.id='typeSheetBackdrop';
sheet.className='type-sheet-backdrop';
sheet.onclick=function(e){if(e.target===sheet)closeTypeSheet();};
document.body.appendChild(sheet);
}
sheet.innerHTML='<div class="type-sheet"><h4>'+escHtml(title)+'</h4><div class="type-grid">'+options.map(function(o,i){return '<div class="type-tile" data-i="'+i+'"><i class="bi '+o.icon+'"></i><span>'+escHtml(o.label)+'</span></div>';}).join('')+'</div></div>';
sheet.classList.add('show');
sheet.querySelectorAll('.type-tile').forEach(function(t){t.onclick=function(){onPick(options[+t.dataset.i].value);closeTypeSheet();};});
}
function populateDeviceSelects(){
const sels=document.querySelectorAll('.action-device');
const opts=tuyaDevices.map(d=>'<option value="'+escHtml(d.id)+'">'+escHtml(d.name)+'</option>').join('');
sels.forEach(s=>{const cur=s.value;s.innerHTML='<option value="">\\u2014 Device \\u2014</option>'+opts;if(cur)s.value=cur;});
}
async function saveScene(){
const name=document.getElementById('scene-name').value.trim();
if(!name)return;
const logic=document.getElementById('scene-logic').value;
const conds=[];
document.querySelectorAll('#if-conditions > .rule-sentence').forEach(r=>{
var t=r.dataset.type;
const v=r.querySelector('.condition-value');
const o=r.querySelector('.condition-operator');
if(!t)return;
let c;
if(t==='time'){
const after=r.querySelector('.condition-after');
const before=r.querySelector('.condition-before');
c={type:'time',after:after?after.value:'00:00',before:before?before.value:'23:59'};
}else if(t==='weekday'){
const cbs=r.querySelectorAll('.wday-cb:checked');
const days=Array.from(cbs).map(cb=>parseInt(cb.value));
c={type:'weekday',days};
}else{
let val=v?v.value:'';
if(t==='grid')val=val==='true';
else if(t==='battery')val=parseInt(val)||0;
else if(t==='device_online'){const dev=r.querySelector('.condition-device').value;const st=r.querySelector('.condition-device-status').value;val=dev;}
c={type:t,value:val};
if(t==='device_online')c.expectedStatus=r.querySelector('.condition-device-status').value==='true';
if(o&&o.value)c.operator=o.value;
}
conds.push(c);
});
if(conds.length===0)return;
const acts=[];
document.querySelectorAll('#then-actions > .rule-sentence').forEach(r=>{
var atype=r.dataset.type||'tuya';
if(atype==='notify'){
const title=r.querySelector('.action-title').value.trim();
const message=r.querySelector('.action-message').value.trim();
if(title||message)acts.push({type:'notify',title,message});
}else{
const d=r.querySelector('.action-device').value;
const v=r.querySelector('.action-value').value==='true';
const dur=parseInt(r.querySelector('.action-duration').value)||0;
const int=parseInt(r.querySelector('.action-interval').value)||0;
if(d)acts.push({type:'tuya',device:d,value:v,duration:dur,interval:int});
}
});
if(acts.length===0)return;
try{
await apiPost('/api/scenes',{name,if:{logic,conditions:conds},then:{actions:acts}});
document.getElementById('scene-name').value='';
document.getElementById('if-conditions').innerHTML='';
document.getElementById('then-actions').innerHTML='';
loadScenes();
}catch(e){showToast('Error',e.message,true);}
}
function escHtml(s){if(!s)return '';const d=document.createElement('div');d.textContent=s;return d.innerHTML;}
async function logout(){try{await apiPost('/api/logout',{});}catch(e){}window.location.href='/login';}
function resetRestartOverlay(){const ov=document.getElementById('restartOverlay');ov.classList.remove('show');const sp=ov.querySelector('.restart-spinner');if(sp)sp.style.display='';const ci=ov.querySelector('.check-icon');if(ci)ci.remove();ov.querySelector('h3').innerHTML='Restarting<span class="restart-dots"></span>';ov.querySelector('p').textContent='Waiting for server to come back online';}
async function restartApp(){
  resetRestartOverlay();
  document.getElementById('restartModal').classList.remove('show');
  document.getElementById('restartOverlay').classList.add('show');
  try{await apiPost('/api/restart',{});}catch(e){}
  const start=Date.now();
  const iv=setInterval(async()=>{
    if(Date.now()-start>60000){clearInterval(iv);document.getElementById('restartOverlay').classList.remove('show');showToast('Restart timed out','Server did not respond. Check the device.',true);return;}
    try{const r=await fetch('/healthz',{signal:AbortSignal.timeout(3000)});if(r.ok){clearInterval(iv);window.location.reload();}}catch{}
  },2000);
}
function toggleSidebar(){if(window.innerWidth<=768)return;const s=document.querySelector('.sidebar');const isOpen=s.classList.contains('open');s.classList.toggle('open');localStorage.setItem('sidebarOpen',isOpen?'0':'1');const btn=document.querySelector('.sidebar-toggle i');if(btn)btn.className=isOpen?'bi bi-chevron-right':'bi bi-chevron-left';}


// ============================================================
// HISTORY CHART
// ============================================================
let historyChart=null;
let currentPeriod='day';

const gridBandsPlugin={id:'gridBands',beforeDraw(chart){const{ctx,chartArea,scales}=chart;if(!chartArea)return;const xScale=scales.x;const ds=chart.data.datasets.find(d=>d._isGrid);if(!ds||!ds.data.length)return;ctx.save();for(let i=0;i<ds.data.length;i++){const val=ds.data[i];if(val===null||val===undefined)continue;const x1=xScale.getPixelForValue(i);const x2=i<ds.data.length-1?xScale.getPixelForValue(i+1):xScale.right;ctx.fillStyle=val?'rgba(34,197,94,0.1)':'rgba(239,68,68,0.1)';ctx.fillRect(x1,chartArea.top,x2-x1,chartArea.height);}ctx.restore();}};

const lineLabelsPlugin={id:'lineLabels',afterDraw(chart){const{ctx,chartArea,scales}=chart;if(!chartArea)return;const xScale=scales.x;const yScale=scales.y;ctx.save();chart.data.datasets.forEach((ds,di)=>{if(!ds._lineLabel||!ds.data.length)return;const meta=chart.getDatasetMeta(di);if(meta.hidden)return;const firstPt=meta.data[0];if(!firstPt)return;const x=firstPt.x;const y=firstPt.y;if(y<chartArea.top-10||y>chartArea.bottom+10)return;ctx.font='bold 11px -apple-system,BlinkMacSystemFont,sans-serif';ctx.textBaseline='middle';const lbl=ds._lineLabel;const col=typeof ds.borderColor==='string'?ds.borderColor:'#98989f';ctx.fillStyle=col;const m=ctx.measureText(lbl);const px=Math.max(chartArea.left+2,Math.min(x-m.width-6,chartArea.right-m.width-4));ctx.fillRect(px-3,y-9,m.width+10,18);ctx.fillStyle='rgba(28,28,30,0.85)';ctx.fillRect(px-3,y-9,m.width+10,18);ctx.fillStyle=col;ctx.fillText(lbl,px,y);});ctx.restore();}};

function renderCurrentValues(elId,items){const el=document.getElementById(elId);if(!el)return;el.innerHTML=items.map(i=>'<span class="cc-item"><span class="cc-dot" style="background:'+i.color+'"></span>'+i.label+': <span class="cc-val">'+i.value+'</span></span>').join('');}
async function loadHistory(period){
currentPeriod=period||currentPeriod;
try{
const r=await fetch('/api/history?period='+currentPeriod);
const d=await r.json();
if(!d.success||!d.points||d.points.length===0){if(historyChart){historyChart.destroy();historyChart=null;}return;}
const labels=d.points.map(p=>{const dt=new Date(p.ts);if(currentPeriod==='day'||currentPeriod==='1h'||currentPeriod==='3h'||currentPeriod==='6h'||currentPeriod==='12h')return dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});if(currentPeriod==='week')return dt.toLocaleDateString([],{weekday:'short',hour:'2-digit',minute:'2-digit'});if(currentPeriod==='month')return dt.toLocaleDateString([],{day:'numeric',hour:'2-digit'});return dt.toLocaleDateString([],{month:'short',day:'numeric'});});
const loadData=d.points.map(p=>p.load);
const batData=d.points.map(p=>p.bat);
const gridData=d.points.map(p=>p.grid);
const ctx=document.getElementById('historyChart');
if(!ctx)return;
if(historyChart)historyChart.destroy();
historyChart=new Chart(ctx,{type:'line',plugins:[lineLabelsPlugin],data:{labels,datasets:[
{label:'Load (W)',data:loadData,_lineLabel:'Load',borderColor:'#3b82f6',backgroundColor:'rgba(59,130,246,0.06)',fill:true,tension:0.3,pointRadius:0,borderWidth:2,order:1,segment:{borderColor:ctx2=>{const gi=gridData[ctx2.p0DataIndex];return gi?'#3b82f6':'#333333';}}},
{label:'Battery (W)',data:batData,_lineLabel:'Battery',borderColor:'#22c55e',fill:false,tension:0.3,pointRadius:0,borderWidth:2,order:2,segment:{borderColor:ctx2=>{const v=batData[ctx2.p0DataIndex];return v>=0?'#22c55e':'#ef4444';}}}
]},options:{responsive:true,maintainAspectRatio:false,animation:{duration:300},interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(28,28,30,0.95)',titleColor:'#f5f5f7',bodyColor:'#f5f5f7',borderColor:'rgba(255,255,255,0.09)',borderWidth:0.5,cornerRadius:10,padding:10,displayColors:true,callbacks:{label:function(ctx2){if(ctx2.dataset.label==='Load (W)')return 'Load: '+ctx2.raw+'W';if(ctx2.dataset.label==='Battery (W)')return 'Battery: '+(ctx2.raw>=0?'+':'')+ctx2.raw+'W';return ctx2.dataset.label+': '+ctx2.raw;},title:function(items){if(!items.length)return '';const idx=items[0].dataIndex;const pt=d.points[idx];const gridTxt=pt?'Grid: '+(pt.grid?'ON':'OFF'):'';return items[0].label+(gridTxt?' | '+gridTxt:'');}}}},scales:{x:{ticks:{color:'#98989f',font:{size:10},maxTicksLimit:currentPeriod==='day'||currentPeriod==='1h'||currentPeriod==='3h'||currentPeriod==='6h'||currentPeriod==='12h'?12:currentPeriod==='week'?14:currentPeriod==='month'?12:12,maxRotation:0},grid:{color:'rgba(255,255,255,0.04)'}},y:{ticks:{color:'#98989f',font:{size:10},callback:v=>v+'W'},grid:{color:'rgba(255,255,255,0.04)'}}}}});
const lp=d.points[d.points.length-1];
renderCurrentValues('historyCurrent',[
{label:'Load',value:lp.load+'W',color:'#3b82f6'},
{label:'Battery',value:(lp.bat>=0?'+':'')+lp.bat+'W',color:lp.bat>=0?'#22c55e':'#ef4444'},
{label:'Grid',value:lp.grid?'ON':'OFF',color:lp.grid?'#22c55e':'#ef4444'}
]);
}catch(e){console.error('loadHistory',e);}
}

document.querySelectorAll('#chartTabs .chart-tab').forEach(tab=>{
tab.addEventListener('click',function(){
document.querySelectorAll('#chartTabs .chart-tab').forEach(t=>t.classList.remove('active'));
this.classList.add('active');
loadHistory(this.dataset.period);
});
});

// ============================================================
// SOCKET POWER CHART
// ============================================================
let socketChart=null;
let socketPeriod='day';
const socketColors=['#3b82f6','#f59e0b','#a855f7','#ef4444','#22c55e','#06b6d4','#f97316','#ec4899','#14b8a6','#8b5cf6'];
let socketColorMap={};
let socketColorIdx=0;
function getSocketColor(id){if(!socketColorMap[id]){socketColorMap[id]=socketColors[socketColorIdx%socketColors.length];socketColorIdx++;}return socketColorMap[id];}

async function loadSocketHistory(period){
socketPeriod=period||socketPeriod;
try{
const r=await fetch('/api/socket-history?period='+socketPeriod);
const d=await r.json();
if(!d.success||!d.points||d.points.length===0){if(socketChart){socketChart.destroy();socketChart=null;}document.getElementById('socketChart').parentElement.style.display='none';return;}
document.getElementById('socketChart').parentElement.style.display='';
const allIds=new Set();
d.points.forEach(p=>{if(p.devices)Object.keys(p.devices).forEach(k=>allIds.add(k));});
if(allIds.size===0){if(socketChart){socketChart.destroy();socketChart=null;}return;}
const labels=d.points.map(p=>{const dt=new Date(p.ts);if(socketPeriod==='day'||socketPeriod==='1h'||socketPeriod==='3h'||socketPeriod==='6h'||socketPeriod==='12h')return dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});if(socketPeriod==='week')return dt.toLocaleDateString([],{weekday:'short',hour:'2-digit',minute:'2-digit'});if(socketPeriod==='month')return dt.toLocaleDateString([],{day:'numeric',hour:'2-digit'});return dt.toLocaleDateString([],{month:'short',day:'numeric'});});
const datasets=[];
for(const id of allIds){
const data=d.points.map(p=>p.devices&&p.devices[id]!=null?p.devices[id]:null);
const name=d.deviceNames&&d.deviceNames[id]?d.deviceNames[id]:id.slice(-6);
const col=getSocketColor(id);
datasets.push({label:name,data,borderColor:col,backgroundColor:col+'15',fill:false,tension:0.3,pointRadius:0,borderWidth:2,spanGaps:true,_lineLabel:name});
}
const ctx=document.getElementById('socketChart');
if(!ctx)return;
if(socketChart)socketChart.destroy();
socketChart=new Chart(ctx,{type:'line',plugins:[lineLabelsPlugin],data:{labels,datasets},options:{responsive:true,maintainAspectRatio:false,animation:{duration:300},interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(28,28,30,0.95)',titleColor:'#f5f5f7',bodyColor:'#f5f5f7',borderColor:'rgba(255,255,255,0.09)',borderWidth:0.5,cornerRadius:10,padding:10,displayColors:true,callbacks:{label:function(ctx2){return ctx2.dataset.label+': '+ctx2.raw+'W';}}}},scales:{x:{ticks:{color:'#98989f',font:{size:10},maxTicksLimit:socketPeriod==='day'||socketPeriod==='1h'||socketPeriod==='3h'||socketPeriod==='6h'||socketPeriod==='12h'?12:socketPeriod==='week'?14:12,maxRotation:0},grid:{color:'rgba(255,255,255,0.04)'}},y:{ticks:{color:'#98989f',font:{size:10},callback:v=>v+'W'},grid:{color:'rgba(255,255,255,0.04)'}}}}});
const lastPt=d.points[d.points.length-1];
const siItems=[];
for(const id of allIds){const nm=d.deviceNames&&d.deviceNames[id]?d.deviceNames[id]:id.slice(-6);const val=lastPt.devices&&lastPt.devices[id]!=null?lastPt.devices[id]:0;siItems.push({label:nm,value:val+'W',color:getSocketColor(id)});}
renderCurrentValues('socketCurrent',siItems);
}catch(e){console.error('loadSocketHistory',e);}
}
document.querySelectorAll('#socketChartTabs .chart-tab').forEach(tab=>{
tab.addEventListener('click',function(){
document.querySelectorAll('#socketChartTabs .chart-tab').forEach(t=>t.classList.remove('active'));
this.classList.add('active');
loadSocketHistory(this.dataset.period);
});
});

// ============================================================
// OTHER LOAD CHART (load minus sockets)
// ============================================================
let otherChart=null;
let otherPeriod='day';

async function loadOtherHistory(period){
otherPeriod=period||otherPeriod;
try{
const d=await(await fetch('/api/history?period='+otherPeriod)).json();
if(!d.success||!d.points||d.points.length===0){if(otherChart){otherChart.destroy();otherChart=null;}document.getElementById('otherChart').parentElement.style.display='none';return;}
document.getElementById('otherChart').parentElement.style.display='';
const labels=d.points.map(p=>{const dt=new Date(p.ts);if(otherPeriod==='day'||otherPeriod==='1h'||otherPeriod==='3h'||otherPeriod==='6h'||otherPeriod==='12h')return dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});if(otherPeriod==='week')return dt.toLocaleDateString([],{weekday:'short',hour:'2-digit',minute:'2-digit'});if(otherPeriod==='month')return dt.toLocaleDateString([],{day:'numeric',hour:'2-digit'});return dt.toLocaleDateString([],{month:'short',day:'numeric'});});
const loadData=d.points.map(p=>p.load);
const otherData=d.points.map(p=>p.otherLoad!=null?p.otherLoad:0);
const sumData=d.points.map(p=>Math.max(0,Math.round((p.load-(p.otherLoad||0))*10)/10));
const ctx=document.getElementById('otherChart');
if(!ctx)return;
if(otherChart)otherChart.destroy();
otherChart=new Chart(ctx,{type:'line',plugins:[lineLabelsPlugin],data:{labels,datasets:[
{label:'Load (W)',data:loadData,borderColor:'#6366f1',backgroundColor:'rgba(99,102,241,0.06)',fill:true,tension:0.3,pointRadius:0,borderWidth:2,order:1,_lineLabel:'Load'},
{label:'Socket Sum (W)',data:sumData,borderColor:'#00e5ff',backgroundColor:'rgba(0,229,255,0.06)',fill:false,tension:0.3,pointRadius:0,borderWidth:2,order:2,_lineLabel:'Sockets'},
{label:'Other Load (W)',data:otherData,borderColor:'#f59e0b',backgroundColor:'rgba(245,158,11,0.06)',fill:true,tension:0.3,pointRadius:0,borderWidth:2,order:3,_lineLabel:'Other'}
]},options:{responsive:true,maintainAspectRatio:false,animation:{duration:300},interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(28,28,30,0.95)',titleColor:'#f5f5f7',bodyColor:'#f5f5f7',borderColor:'rgba(255,255,255,0.09)',borderWidth:0.5,cornerRadius:10,padding:10,displayColors:true,callbacks:{label:function(ctx2){return ctx2.dataset.label.split(' (')[0]+': '+ctx2.raw+'W';}}}},scales:{x:{ticks:{color:'#98989f',font:{size:10},maxTicksLimit:otherPeriod==='day'||otherPeriod==='1h'||otherPeriod==='3h'||otherPeriod==='6h'||otherPeriod==='12h'?12:otherPeriod==='week'?14:12,maxRotation:0},grid:{color:'rgba(255,255,255,0.04)'}},y:{ticks:{color:'#98989f',font:{size:10},callback:v=>v+'W'},grid:{color:'rgba(255,255,255,0.04)'}}}}});
const olp=d.points[d.points.length-1];
const lastSum=sumData[sumData.length-1]||0;
renderCurrentValues('otherCurrent',[
{label:'Load',value:olp.load+'W',color:'#6366f1'},
{label:'Sockets',value:lastSum+'W',color:'#00e5ff'},
{label:'Other',value:(olp.otherLoad||0)+'W',color:'#f59e0b'}
]);
}catch(e){console.error('loadOtherHistory',e);}
}
document.querySelectorAll('#otherChartTabs .chart-tab').forEach(tab=>{
tab.addEventListener('click',function(){
document.querySelectorAll('#otherChartTabs .chart-tab').forEach(t=>t.classList.remove('active'));
this.classList.add('active');
loadOtherHistory(this.dataset.period);
});
});

async function changePassword(){
const cur=document.getElementById('cp-current').value;
const nw=document.getElementById('cp-new').value;
const cf=document.getElementById('cp-confirm').value;
if(!cur||!nw){showToast('Error','Fill in all fields.',true);return;}
if(nw.length<6){showToast('Error','New password must be at least 6 characters.',true);return;}
if(nw!==cf){showToast('Error','Passwords do not match.',true);return;}
const btn=document.querySelector('[onclick="changePassword()"]');
if(btn){btn.disabled=true;btn.innerHTML='<i class="bi bi-hourglass-split"></i> Saving...';}
try{const h={'Content-Type':'application/json'};if(_csrfToken)h['X-CSRF-Token']=_csrfToken;const r=await fetch('/api/change-password',{method:'POST',headers:h,body:JSON.stringify({currentPassword:cur,newPassword:nw})});const d=await r.json();if(d.success){resetRestartOverlay();const ov=document.getElementById('restartOverlay');ov.querySelector('.restart-spinner').style.display='none';const ci=document.createElement('div');ci.className='check-icon';ci.innerHTML='<i class="bi bi-check-lg"></i>';ov.querySelector('.restart-spinner').parentNode.insertBefore(ci,ov.querySelector('h3'));ov.querySelector('h3').textContent='Password changed';ov.querySelector('p').textContent='Please log in with your new password';ov.classList.add('show');setTimeout(()=>{window.location.href='/login';},2500);}else{showToast('Error',d.message||'Failed.',true);if(btn){btn.disabled=false;btn.innerHTML='<i class="bi bi-shield-lock"></i> Change Password';}}}
catch(e){showToast('Error',e.message,true);if(btn){btn.disabled=false;btn.innerHTML='<i class="bi bi-shield-lock"></i> Change Password';}}
}
async function loadPluginConfig(){
try{
const d=await apiGet('/api/plugin-config');
if(!d.success){showToast('Error',d.message||'Failed to load config',true);return;}
const c=d.config;
document.getElementById('cfg-inverter-ip').value=(c.inverter&&c.inverter.ip)||'';
document.getElementById('cfg-inverter-serial').value=(c.inverter&&c.inverter.serial)||'';
document.getElementById('cfg-inverter-port').value=(c.inverter&&c.inverter.port)||8899;
document.getElementById('cfg-tuya-accessId').value=(c.tuya&&c.tuya.accessId)||'';
document.getElementById('cfg-tuya-accessKey').value=(c.tuya&&c.tuya.accessKey)||'';
document.getElementById('cfg-tuya-countryCode').value=(c.tuya&&c.tuya.countryCode)||48;
document.getElementById('cfg-tuya-username').value=(c.tuya&&c.tuya.username)||'';
document.getElementById('cfg-tuya-password').value=(c.tuya&&c.tuya.password)||'';
document.getElementById('cfg-tuya-appSchema').value=(c.tuya&&c.tuya.appSchema)||'tuyaSmart';
 document.getElementById('cfg-webPort').value=c.webPort||8583;
 document.getElementById('cfg-ntfy-topic').value=(c.notifications&&c.notifications.ntfyTopic)||'';
 document.getElementById('cfg-ntfy-enabled').checked=(c.notifications&&c.notifications.ntfyEnabled!==false);
 document.getElementById('cfg-tg-token').value=(c.notifications&&c.notifications.telegramToken)||'';
 document.getElementById('cfg-tg-chat').value=(c.notifications&&c.notifications.telegramChatId)||'';
 document.getElementById('cfg-tg-enabled').checked=(c.notifications&&c.notifications.telegramEnabled!==false);
 document.getElementById('cfg-notif-enabled').checked=(c.notifications&&c.notifications.notifEnabled!==false);
 document.getElementById('cfg-ntfy-notif-enabled').checked=(c.notifications&&c.notifications.ntfyNotifEnabled!==false);
 document.getElementById('cfg-tg-notif-enabled').checked=(c.notifications&&c.notifications.telegramNotifEnabled!==false);
 const ntfye=document.getElementById('notif-ntfy-row');if(ntfye)ntfye.style.display=(c.notifications&&c.notifications.ntfyEnabled!==false)?'flex':'none';
 const tge=document.getElementById('notif-tg-row');if(tge)tge.style.display=(c.notifications&&c.notifications.telegramEnabled!==false)?'flex':'none';
 document.getElementById('cfg-notif-critical-enabled').checked=(c.notifications&&c.notifications.criticalEnabled!==false);
 document.getElementById('cfg-soc-alert').value=(c.notifications&&c.notifications.lowSocAlert)||20;
 document.getElementById('cfg-conn-timeout').value=(c.notifications&&c.notifications.connTimeout)||10;
 document.getElementById('critical-fields').style.display=(c.notifications&&c.notifications.criticalEnabled!==false)?'block':'none';
 document.getElementById('cfg-notif-grid-outage').checked=(c.notifications&&c.notifications.gridOutageReport!==false);
 document.getElementById('ntfy-fields').style.display=(c.notifications&&c.notifications.ntfyEnabled!==false)?'block':'none';
 document.getElementById('tg-fields').style.display=(c.notifications&&c.notifications.telegramEnabled!==false)?'block':'none';
 const tf=c.tariff||{};
 document.getElementById('cfg-tariff-currency').value=tf.currency||'UAH';
 document.getElementById('cfg-tariff-type').value=tf.type||'daynight';
 document.getElementById('cfg-tariff-flat-rate').value=tf.flatRate||0;
 document.getElementById('cfg-tariff-day-rate').value=tf.dayRate||0;
 document.getElementById('cfg-tariff-night-rate').value=tf.nightRate||0;
 document.getElementById('cfg-tariff-day-start').value=tf.dayStart||'07:00';
 document.getElementById('cfg-tariff-night-start').value=tf.nightStart||'23:00';
 toggleTariffFields();

}catch(e){}
}
async function savePluginConfig(){
try{
const cfg={
inverter:{ip:document.getElementById('cfg-inverter-ip').value.trim(),serial:document.getElementById('cfg-inverter-serial').value.trim(),port:parseInt(document.getElementById('cfg-inverter-port').value)||8899},
tuya:{accessId:document.getElementById('cfg-tuya-accessId').value.trim(),accessKey:document.getElementById('cfg-tuya-accessKey').value,countryCode:parseInt(document.getElementById('cfg-tuya-countryCode').value)||48,username:document.getElementById('cfg-tuya-username').value.trim(),password:document.getElementById('cfg-tuya-password').value,appSchema:document.getElementById('cfg-tuya-appSchema').value},
webPort:parseInt(document.getElementById('cfg-webPort').value)||8583,
notifications:{ntfyEnabled:document.getElementById('cfg-ntfy-enabled').checked,ntfyNotifEnabled:document.getElementById('cfg-ntfy-notif-enabled').checked,ntfyTopic:document.getElementById('cfg-ntfy-topic').value.trim(),telegramEnabled:document.getElementById('cfg-tg-enabled').checked,telegramNotifEnabled:document.getElementById('cfg-tg-notif-enabled').checked,telegramToken:document.getElementById('cfg-tg-token').value,telegramChatId:document.getElementById('cfg-tg-chat').value.trim(),criticalEnabled:document.getElementById('cfg-notif-critical-enabled').checked,lowSocAlert:parseInt(document.getElementById('cfg-soc-alert').value)||20,connTimeout:parseInt(document.getElementById('cfg-conn-timeout').value)||10,gridOutageReport:document.getElementById('cfg-notif-grid-outage').checked}
};
const r=await apiPost('/api/plugin-config',{config:cfg});
if(r.success){document.getElementById('restartModal').classList.add('show');}else showToast('Error',r.message||'Save failed',true);
}catch(e){showToast('Error',e.message,true);}
}
async function saveNotifConfig(){
const cfg={
notifications:{notifEnabled:document.getElementById('cfg-notif-enabled').checked,ntfyNotifEnabled:document.getElementById('cfg-ntfy-notif-enabled').checked,telegramNotifEnabled:document.getElementById('cfg-tg-notif-enabled').checked,criticalEnabled:document.getElementById('cfg-notif-critical-enabled').checked,gridOutageReport:document.getElementById('cfg-notif-grid-outage').checked,lowSocAlert:parseInt(document.getElementById('cfg-soc-alert').value)||20,connTimeout:parseInt(document.getElementById('cfg-conn-timeout').value)||10}
};
const st=document.getElementById('notif-status');st.style.display='block';st.innerHTML='<i class="bi bi-hourglass-split"></i> Saving...';
try{const r=await apiPost('/api/plugin-config',{config:cfg});if(r.success){st.innerHTML='<i class="bi bi-check-circle" style="color:#22c55e"></i> Saved.';setTimeout(()=>st.style.display='none',3000);}else st.innerHTML='<i class="bi bi-x-circle" style="color:#ef4444"></i> '+(r.message||'Error');}catch(e){st.innerHTML='<i class="bi bi-x-circle" style="color:#ef4444"></i> '+e.message;}
}
async function testNotification(){
const st=document.getElementById('notif-status');st.style.display='block';st.innerHTML='<i class="bi bi-hourglass-split"></i> Sending...';
try{const r=await apiPost('/api/test-notification',{});st.innerHTML=r.results&&r.results.length?'<span style="color:var(--text)">'+r.results.join('<br>')+'</span>':'<span style="color:#22c55e">Sent</span>';}catch(e){st.innerHTML='<i class="bi bi-x-circle" style="color:#ef4444"></i> '+e.message;}
}
function toggleTariffFields(){const t=document.getElementById('cfg-tariff-type').value;document.getElementById('tariff-flat-fields').style.display=t==='flat'?'block':'none';document.getElementById('tariff-daynight-fields').style.display=t==='daynight'?'block':'none';}
async function saveTariffConfig(){
const cfg={tariff:{
currency:document.getElementById('cfg-tariff-currency').value.trim()||'UAH',
type:document.getElementById('cfg-tariff-type').value||'daynight',
flatRate:parseFloat(document.getElementById('cfg-tariff-flat-rate').value)||0,
dayRate:parseFloat(document.getElementById('cfg-tariff-day-rate').value)||0,
nightRate:parseFloat(document.getElementById('cfg-tariff-night-rate').value)||0,
dayStart:document.getElementById('cfg-tariff-day-start').value||'07:00',
nightStart:document.getElementById('cfg-tariff-night-start').value||'23:00'
}};
const st=document.getElementById('tariff-status');st.style.display='block';st.innerHTML='<i class="bi bi-hourglass-split"></i> Saving...';
try{const r=await apiPost('/api/plugin-config',{config:cfg});if(r.success){st.innerHTML='<i class="bi bi-check-circle" style="color:#22c55e"></i> Saved';setTimeout(()=>st.style.display='none',3000);}else st.innerHTML='<i class="bi bi-x-circle" style="color:#ef4444"></i> '+(r.message||'Error');}catch(e){st.innerHTML='<i class="bi bi-x-circle" style="color:#ef4444"></i> '+e.message;}
}
function copyMetricsUrl(){
const el=document.getElementById('cfg-metrics-url');
if(!el||!el.value)return;
el.select();
try{navigator.clipboard.writeText(el.value);showToast('Copied','Metrics URL copied to clipboard');}catch(e){document.execCommand('copy');}
}
// Tile registry
const TILE_REGISTRY=[
// Main tiles
{id:'tile-grid',label:'City Grid',icon:'bi-plug',cat:'main',def:true,update:d=>{const on=d.gridPower===true;return{value:on?'ON':'OFF',sub:(on&&d.gridVoltage>0)?d.gridVoltage.toFixed(1)+'V':'\u2014',cls:on?'on':'off'};}},
{id:'tile-battery',label:'Battery',icon:'bi-battery-half',cat:'main',def:true,update:d=>{const bp=d.batteryPower||0;return{value:(d.batterySOC||0)+'%',sub:bp>0?'+'+bp+'W':bp<0?bp+'W':'0W'};}},
{id:'tile-pv',label:'Solar PV',icon:'bi-sun',cat:'main',def:true,update:d=>{const pv1=d.pvPower||0,pv2=d.pvPower2||0;return{value:(pv1+pv2)?(pv1+pv2)+'W':'0W',sub:pv2>0?'PV1='+pv1+'W PV2='+pv2+'W':'PV='+pv1+'W'};}},
{id:'tile-load',label:'Load',icon:'bi-laptop',cat:'main',def:true,update:d=>({value:d.loadPower?d.loadPower+'W':'0W',sub:new Date().toLocaleTimeString()})},
{id:'tile-day-pv',label:'Solar Today',icon:'bi-sun',cat:'main',def:true,update:d=>({value:(d.dayPV||0).toFixed(1)+' kWh',sub:''})},
{id:'tile-day-import',label:'Grid Import',icon:'bi-box-arrow-in-down',cat:'main',def:true,update:d=>({value:(d.dayGridImport||0).toFixed(1)+' kWh',sub:'today'})},
{id:'tile-day-export',label:'Grid Export',icon:'bi-box-arrow-up',cat:'main',def:true,update:d=>({value:(d.dayGridExport||0).toFixed(1)+' kWh',sub:'today'})},
{id:'tile-day-load',label:'Load Today',icon:'bi-lightning',cat:'main',def:true,update:d=>({value:(d.dayLoadEnergy||0).toFixed(1)+' kWh',sub:'consumed'})},
{id:'tile-day-batcharge',label:'Bat Charge',icon:'bi-battery-charging',cat:'main',def:true,update:d=>({value:(d.dayBatCharge||0).toFixed(1)+' kWh',sub:'today'})},
{id:'tile-day-batdischarge',label:'Bat Discharge',icon:'bi-battery',cat:'main',def:true,update:d=>({value:(d.dayBatDischarge||0).toFixed(1)+' kWh',sub:'today'})},
{id:'tile-battemp',label:'Battery Temp',icon:'bi-thermometer-half',cat:'main',def:true,update:d=>({value:(d.batteryTemp||0).toFixed(1)+' °C',sub:''})},
{id:'tile-envtemp',label:'Environment',icon:'bi-thermometer',cat:'main',def:true,update:d=>({value:(d.envTemp||0).toFixed(1)+' °C',sub:'temperature'})},
// DC Block debug tiles
{id:'tile-d-overall',label:'Overall State',icon:'bi-gear',cat:'dc',def:false,update:(_,g)=>({value:g.overallState??'--',sub:'reg59'})},
{id:'tile-d-dayActive',label:'Day Active',icon:'bi-graph-up',cat:'dc',def:false,update:(_,g)=>({value:(g.dayActiveEnergy??0)+' kWh',sub:'reg60'})},
{id:'tile-d-monthPV',label:'Month PV',icon:'bi-sun',cat:'dc',def:false,update:(_,g)=>({value:(g.monthPV??0)+' kWh',sub:'reg65'})},
{id:'tile-d-monthLoad',label:'Month Load',icon:'bi-lightning',cat:'dc',def:false,update:(_,g)=>({value:(g.monthLoad??0)+' kWh',sub:'reg66'})},
{id:'tile-d-monthGrid',label:'Month Grid',icon:'bi-plug',cat:'dc',def:false,update:(_,g)=>({value:(g.monthGrid??0)+' kWh',sub:'reg67'})},
{id:'tile-d-totalBatChg',label:'Total Bat Charge',icon:'bi-battery-charging',cat:'dc',def:false,update:(_,g)=>({value:(g.totalBatCharge??0)+' kWh',sub:'reg72-73'})},
{id:'tile-d-totalBatDisch',label:'Total Bat Discharge',icon:'bi-battery',cat:'dc',def:false,update:(_,g)=>({value:(g.totalBatDischarge??0)+' kWh',sub:'reg74-75'})},
{id:'tile-d-totalGridImp',label:'Total Grid Import',icon:'bi-box-arrow-in-down',cat:'dc',def:false,update:(_,g)=>({value:(g.totalGridImport??0)+' kWh',sub:'reg78+80'})},
{id:'tile-d-totalGridExp',label:'Total Grid Export',icon:'bi-box-arrow-up',cat:'dc',def:false,update:(_,g)=>({value:(g.totalGridExport??0)+' kWh',sub:'reg81-82'})},
{id:'tile-d-gridFreq',label:'Grid Frequency',icon:'bi-activity',cat:'dc',def:false,update:(_,g)=>({value:(g.gridFreq??0)+' Hz',sub:'reg79'})},
{id:'tile-d-totalLoad',label:'Total Load',icon:'bi-graph-down',cat:'dc',def:false,update:(_,g)=>({value:(g.totalLoadEnergy??0)+' kWh',sub:'reg85-86'})},
{id:'tile-d-totalPV',label:'Total PV',icon:'bi-sun',cat:'dc',def:false,update:(_,g)=>({value:(g.totalPV??0)+' kWh',sub:'reg96-97'})},
{id:'tile-d-yearGridExp',label:'Year Grid Export',icon:'bi-calendar',cat:'dc',def:false,update:(_,g)=>({value:(g.yearGridExport??0)+' kWh',sub:'reg98-99'})},
{id:'tile-d-dcTransfTemp',label:'DC Transformer',icon:'bi-thermometer-half',cat:'dc',def:false,update:(_,g)=>({value:(g.dcTransfTemp??0)+' °C',sub:'reg90'})},
{id:'tile-d-radiator',label:'Radiator Temp',icon:'bi-thermometer',cat:'dc',def:false,update:(_,g)=>({value:(g.radiatorTemp??0)+' °C',sub:'reg91'})},
{id:'tile-d-pv1V',label:'PV1 Voltage',icon:'bi-lightning',cat:'dc',def:false,update:(_,g)=>({value:(g.pv1Voltage??0)+' V',sub:'reg109'})},
{id:'tile-d-pv1A',label:'PV1 Current',icon:'bi-lightning',cat:'dc',def:false,update:(_,g)=>({value:(g.pv1Current??0)+' A',sub:'reg110'})},
{id:'tile-d-pv2V',label:'PV2 Voltage',icon:'bi-lightning',cat:'dc',def:false,update:(_,g)=>({value:(g.pv2Voltage??0)+' V',sub:'reg111'})},
{id:'tile-d-fault1',label:'Fault Code 1',icon:'bi-exclamation-triangle',cat:'dc',def:false,update:(_,g)=>({value:g.fault1??'--',sub:'reg103'})},
{id:'tile-d-fault2',label:'Fault Code 2',icon:'bi-exclamation-triangle',cat:'dc',def:false,update:(_,g)=>({value:g.fault2??'--',sub:'reg104'})},
{id:'tile-d-fault3',label:'Fault Code 3',icon:'bi-exclamation-triangle',cat:'dc',def:false,update:(_,g)=>({value:g.fault3??'--',sub:'reg105'})},
{id:'tile-d-fault4',label:'Fault Code 4',icon:'bi-exclamation-triangle',cat:'dc',def:false,update:(_,g)=>({value:g.fault4??'--',sub:'reg106'})},
// AC Block debug tiles
{id:'tile-a-invV',label:'Inverter Voltage',icon:'bi-plug',cat:'ac',def:false,update:(_,g)=>({value:(g.inverterVoltage??0)+' V',sub:'reg154'})},
{id:'tile-a-gridI1',label:'Grid Current 1',icon:'bi-graph-up',cat:'ac',def:false,update:(_,g)=>({value:g.gridCurrent1??'--',sub:'reg160'})},
{id:'tile-a-gridI2',label:'Grid Current 2',icon:'bi-graph-up',cat:'ac',def:false,update:(_,g)=>({value:g.gridCurrent2??'--',sub:'reg161'})},
{id:'tile-a-invI',label:'Inverter Current',icon:'bi-graph-up',cat:'ac',def:false,update:(_,g)=>({value:(g.inverterCurrent??0)+' A',sub:'reg164'})},
{id:'tile-a-auxPower',label:'Aux Power',icon:'bi-lightning',cat:'ac',def:false,update:(_,g)=>({value:(g.auxPower??0)+' W',sub:'reg166'})},
{id:'tile-a-gridL1',label:'Grid L1 Power',icon:'bi-plug',cat:'ac',def:false,update:(_,g)=>({value:(g.gridL1Power??0)+' W',sub:'reg167'})},
{id:'tile-a-gridCT',label:'Grid CT Power',icon:'bi-plug',cat:'ac',def:false,update:(_,g)=>({value:(g.gridCTPower??0)+' W',sub:'reg172'})},
{id:'tile-a-invPower',label:'Inverter Power',icon:'bi-lightning',cat:'ac',def:false,update:(_,g)=>({value:(g.inverterPower??0)+' W',sub:'reg175'})},
{id:'tile-a-offGrid',label:'Off-Grid Mode',icon:'bi-power',cat:'ac',def:false,update:(_,g)=>({value:g.offGridMode??'--',sub:'reg179'})},
{id:'tile-a-batV',label:'Battery Voltage',icon:'bi-battery-half',cat:'ac',def:false,update:(_,g)=>({value:(g.batteryVoltage??0)+' V',sub:'reg183'})},
{id:'tile-a-batI',label:'Battery Current',icon:'bi-battery-half',cat:'ac',def:false,update:(_,g)=>({value:(g.batteryCurrent??0)+' A',sub:'reg191'})},
{id:'tile-a-pv1Pwr',label:'PV1 Power',icon:'bi-sun',cat:'ac',def:false,update:(_,g)=>({value:(g.pv1Power??0)+' W',sub:'reg186'})},
{id:'tile-a-pv2Pwr',label:'PV2 Power',icon:'bi-sun',cat:'ac',def:false,update:(_,g)=>({value:(g.pv2Power??0)+' W',sub:'reg187'})},
{id:'tile-a-loadFreq',label:'Load Frequency',icon:'bi-activity',cat:'ac',def:false,update:(_,g)=>({value:(g.loadFreq??0)+' Hz',sub:'reg192'})},
{id:'tile-a-invFreq',label:'Inverter Frequency',icon:'bi-activity',cat:'ac',def:false,update:(_,g)=>({value:(g.inverterFreq??0)+' Hz',sub:'reg193'})},
{id:'tile-a-gridConn',label:'Grid Connected',icon:'bi-plug',cat:'ac',def:false,update:(_,g)=>({value:g.gridConnected??'--',sub:'reg194'})},
// Settings debug tiles
{id:'tile-s-ctrlMode',label:'Control Mode',icon:'bi-gear',cat:'settings',def:false,update:(_,g)=>({value:g.controlMode??'--',sub:'reg200'})},
{id:'tile-s-batEqV',label:'Bat EQ Voltage',icon:'bi-battery-half',cat:'settings',def:false,update:(_,g)=>({value:(g.batteryEqVoltage??0)+' V',sub:'reg201'})},
{id:'tile-s-batAbsV',label:'Bat Abs Voltage',icon:'bi-battery-half',cat:'settings',def:false,update:(_,g)=>({value:(g.batteryAbsVoltage??0)+' V',sub:'reg202'})},
{id:'tile-s-batFloatV',label:'Bat Float Voltage',icon:'bi-battery-half',cat:'settings',def:false,update:(_,g)=>({value:(g.batteryFloatVoltage??0)+' V',sub:'reg203'})},
{id:'tile-s-upsDelay',label:'UPS Delay',icon:'bi-clock',cat:'settings',def:false,update:(_,g)=>({value:g.upsDelayTime??'--',sub:'reg209'})},
{id:'tile-s-maxChgI',label:'Max Charge Current',icon:'bi-battery-charging',cat:'settings',def:false,update:(_,g)=>({value:g.batMaxChargeCurrent??'--',sub:'reg210'})},
{id:'tile-s-maxDisI',label:'Max Discharge Current',icon:'bi-battery',cat:'settings',def:false,update:(_,g)=>({value:g.batMaxDischargeCurrent??'--',sub:'reg211'})},
{id:'tile-s-shdSOC',label:'Shutdown SOC',icon:'bi-exclamation-triangle',cat:'settings',def:false,update:(_,g)=>({value:g.batShutdownSOC??'--',sub:'reg217'})},
{id:'tile-s-rstSOC',label:'Restart SOC',icon:'bi-arrow-clockwise',cat:'settings',def:false,update:(_,g)=>({value:g.batRestartSOC??'--',sub:'reg218'})},
{id:'tile-s-lowSOC',label:'Low SOC',icon:'bi-exclamation',cat:'settings',def:false,update:(_,g)=>({value:g.batLowSOC??'--',sub:'reg219'})},
{id:'tile-s-shdV',label:'Shutdown Voltage',icon:'bi-exclamation-triangle',cat:'settings',def:false,update:(_,g)=>({value:(g.batShutdownVoltage??0)+' V',sub:'reg220'})},
{id:'tile-s-rstV',label:'Restart Voltage',icon:'bi-arrow-clockwise',cat:'settings',def:false,update:(_,g)=>({value:(g.batRestartVoltage??0)+' V',sub:'reg221'})},
{id:'tile-s-lowV',label:'Low Voltage',icon:'bi-exclamation',cat:'settings',def:false,update:(_,g)=>({value:(g.batLowVoltage??0)+' V',sub:'reg222'})},
{id:'tile-s-remoteCfg',label:'Remote Config',icon:'bi-gear',cat:'settings',def:false,update:(_,g)=>({value:g.remoteConfig??'--',sub:'reg228'})},
{id:'tile-s-gridChg',label:'Grid Charge',icon:'bi-plug',cat:'settings',def:false,update:(_,g)=>({value:g.gridChargeEnabled??'--',sub:'reg230'})},
{id:'tile-s-priority',label:'Priority Load',icon:'bi-lightning',cat:'settings',def:false,update:(_,g)=>({value:g.priorityLoad??'--',sub:'reg243'})},
{id:'tile-s-loadLimit',label:'Load Limit',icon:'bi-speedometer',cat:'settings',def:false,update:(_,g)=>({value:g.loadLimit??'--',sub:'reg244'})},
{id:'tile-s-maxSell',label:'Max Sell Power',icon:'bi-cash',cat:'settings',def:false,update:(_,g)=>({value:g.maxSellPower??'--',sub:'reg245'})},
{id:'tile-s-solarExport',label:'Solar Export',icon:'bi-box-arrow-up',cat:'settings',def:false,update:(_,g)=>({value:g.solarExport??'--',sub:'reg247'})},
{id:'tile-s-useTimer',label:'Use Timer',icon:'bi-clock',cat:'settings',def:false,update:(_,g)=>({value:g.useTimer??'--',sub:'reg248'})}
];
const TILE_IDS=TILE_REGISTRY.map(t=>t.id);
const TILE_MAP={};TILE_REGISTRY.forEach(t=>{TILE_MAP[t.id]=t;});
const TILE_METRIC_MAP={'tile-battery':{key:'soc',label:'Battery SOC',unit:'%'},'tile-pv':{key:'pv',label:'Solar PV',unit:'W'},'tile-load':{key:'load',label:'Load',unit:'W'}};
const TILE_CATEGORIES=[{id:'main',label:'Main'},{id:'dc',label:'DC Block (48-111)'},{id:'ac',label:'AC Block (150-249)'},{id:'settings',label:'Settings (200-249)'}];
function buildTiles(){const c=document.getElementById('tilesContainer');c.innerHTML='';TILE_REGISTRY.forEach(t=>{const tile=document.createElement('div');tile.className='tile';tile.id=t.id;tile.innerHTML='<span class="icon"><i class="bi '+t.icon+'"></i></span><div class="label">'+t.label+'</div><div class="value">--</div><div class="sub"></div>';if(TILE_METRIC_MAP[t.id]){tile.style.cursor='pointer';tile.onclick=()=>openTileDetail(t.id);}c.appendChild(tile);});}
function updateTiles(d,g){const dg=g||{};TILE_REGISTRY.forEach(t=>{const el=document.getElementById(t.id);if(!el)return;try{const r=t.update(d,dg);if(!r)return;const v=el.querySelector('.value');const s=el.querySelector('.sub');if(v)v.textContent=r.value;if(s)s.textContent=r.sub;el.classList.remove('on','off');if(r.cls)el.classList.add(r.cls);}catch{}})}
function loadTilePrefs(){try{return JSON.parse(localStorage.getItem('tileVis')||'null')||{}}catch{return{}}}
function saveTilePrefs(p){localStorage.setItem('tileVis',JSON.stringify(p));}
function loadTileOrder(){try{const o=JSON.parse(localStorage.getItem('tileOrder')||'null');if(Array.isArray(o)){const ids=TILE_IDS.filter(id=>o.includes(id));TILE_IDS.forEach(id=>{if(!ids.includes(id))ids.push(id);});return ids;}}catch{}return[...TILE_IDS];}
function saveTileOrder(o){localStorage.setItem('tileOrder',JSON.stringify(o));}
function applyTileVisibility(){const p=loadTilePrefs();TILE_IDS.forEach(id=>{const el=document.getElementById(id);if(!el)return;const t=TILE_MAP[id];const vis=t?(p[id]!==undefined?p[id]:t.def):true;el.style.display=vis===false?'none':'';});}
function applyTileOrder(){const order=loadTileOrder();const c=document.getElementById('tilesContainer');order.forEach(id=>{const el=document.getElementById(id);if(el)c.appendChild(el);});}
function moveTile(id,dir){const order=loadTileOrder();const idx=order.indexOf(id);if(idx<0)return;const ni=idx+dir;if(ni<0||ni>=order.length)return;[order[idx],order[ni]]=[order[ni],order[idx]];saveTileOrder(order);applyTileOrder();}
function buildTileEditor(){const p=loadTilePrefs();const order=loadTileOrder();const g=document.getElementById('tileEditGrid');g.innerHTML='';TILE_CATEGORIES.forEach(cat=>{const catTiles=order.filter(id=>{const t=TILE_MAP[id];return t&&t.cat===cat.id;});if(!catTiles.length)return;const hdr=document.createElement('div');hdr.className='tile-edit-cat';hdr.textContent=cat.label;g.appendChild(hdr);catTiles.forEach(id=>{const t=TILE_MAP[id];const lbl=t?t.label:id;const vis=p[id]!==undefined?p[id]:t?t.def:true;const d=document.createElement('label');d.className='tile-edit-item'+(vis?'':' hidden-tile');d.dataset.tile=id;d.innerHTML='<input type="checkbox" '+(vis?'checked':'')+' data-tile="'+id+'">'+lbl+'<div class="tile-edit-arrows"><button type="button" title="Move up" class="tile-arrow-btn" data-dir="-1">\u25B2</button><button type="button" title="Move down" class="tile-arrow-btn" data-dir="1">\u25BC</button></div>';d.querySelector('input').addEventListener('change',function(){const pp=loadTilePrefs();pp[this.dataset.tile]=this.checked;saveTilePrefs(pp);d.classList.toggle('hidden-tile',!this.checked);applyTileVisibility();});d.querySelectorAll('.tile-arrow-btn').forEach(btn=>{btn.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();moveTile(id,parseInt(this.dataset.dir));buildTileEditor();});});g.appendChild(d);});});}
// Pull-to-refresh
let _pullStart=0,_pulling=false;
const _pullEl=document.getElementById('pull-indicator');
const _pullIcon=_pullEl?_pullEl.querySelector('i'):null;
const mainEl=document.querySelector('.main');
if(mainEl){mainEl.addEventListener('touchstart',function(e){if(mainEl.scrollTop<=0){_pullStart=e.touches[0].clientY;_pulling=true;}},{passive:true});mainEl.addEventListener('touchmove',function(e){if(!_pulling)return;const dy=e.touches[0].clientY-_pullStart;if(dy>0&&mainEl.scrollTop<=0){const pct=Math.min(dy/100,1);_pullEl.classList.add('show');_pullIcon.style.transform='rotate('+pct*180+'deg)';if(pct>=1){_pullEl.classList.add('pulling');}}},{passive:true});mainEl.addEventListener('touchend',function(){if(!_pulling)return;_pulling=false;if(_pullEl.classList.contains('pulling')){_pullEl.classList.remove('pulling');_pullEl.classList.add('refreshing');_pullIcon.className='bi bi-arrow-clockwise';loadStatus();loadLogs();loadHistory();loadSocketHistory();loadOtherHistory();loadTuyaDevices();loadScenes();loadPluginConfig();loadAppVersion();setTimeout(()=>{_pullEl.classList.remove('show','refreshing');_pullIcon.className='bi bi-arrow-down';},800);}else{_pullEl.classList.remove('show','pulling');}},{passive:true});}

function renderEnergyFlow(d){
const svg=document.getElementById('energyFlow');if(!svg)return;
const pv=(d.pvPower||0)+(d.pvPower2||0);
const load=d.loadPower||0;
const bp=d.batteryPower||0;
const gridOn=d.gridPower===true;
const dayPV=d.dayPV||0;
const dayGridImport=d.dayGridImport||0;
const dayGridExport=d.dayGridExport||0;
const dayLoadEnergy=d.dayLoadEnergy||0;
const charging=bp<0;const discharging=bp>0;
const toGrid=gridOn&&pv>load+Math.max(0,-bp);
const fromGrid=gridOn&&pv+Math.max(0,bp)<load;
const soc=d.batterySOC||0;
const sc=dayPV>0?((dayPV-dayGridExport)/dayPV*100):0;
const aut=dayLoadEnergy>0?((dayLoadEnergy-dayGridImport)/dayLoadEnergy*100):0;
const html='<defs><marker id="ar" markerWidth="6" markerHeight="6" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6" fill="none" stroke-width="1.2" stroke="var(--muted)"/></marker><marker id="ar-pv" markerWidth="6" markerHeight="6" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6" fill="none" stroke-width="1.6" stroke="#f59e0b"/></marker></defs>'
+'<rect x="10" y="10" width="90" height="44" rx="8" fill="rgba(245,158,11,.15)" stroke="#f59e0b" stroke-width="1"/><text x="55" y="28" text-anchor="middle" fill="#f59e0b" font-size="11" font-weight="600">Solar</text><text x="55" y="46" text-anchor="middle" fill="var(--text)" font-size="13" font-weight="700">'+(pv||'0')+' W</text>'
+'<rect x="10" y="136" width="90" height="44" rx="8" fill="rgba(48,209,88,.15)" stroke="#30d158" stroke-width="1"/><text x="55" y="154" text-anchor="middle" fill="#30d158" font-size="11" font-weight="600">Battery</text><text x="55" y="172" text-anchor="middle" fill="var(--text)" font-size="13" font-weight="700">'+soc+'%</text><text x="55" y="133" text-anchor="middle" fill="var(--muted)" font-size="9">'+(bp?bp+'W':'0W')+'</text>'
+'<rect x="145" y="73" width="90" height="44" rx="8" fill="rgba(191,90,242,.15)" stroke="#bf5af2" stroke-width="1"/><text x="190" y="91" text-anchor="middle" fill="#bf5af2" font-size="11" font-weight="600">Home</text><text x="190" y="109" text-anchor="middle" fill="var(--text)" font-size="13" font-weight="700">'+(load||'0')+' W</text>'
+'<rect x="295" y="73" width="90" height="44" rx="8" fill="rgba(255,69,58,.12)" stroke="#ff453a" stroke-width="1"/><text x="340" y="91" text-anchor="middle" fill="#ff453a" font-size="11" font-weight="600">Grid</text><text x="340" y="109" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="700">'+(gridOn?'ON':'OFF')+'</text>'
// Solar → Home arrow
+'<line x1="100" y1="32" x2="145" y2="95" stroke="var(--muted)" stroke-width="1.2" marker-end="url(#ar)"/>'
// Battery ↔ Home arrow
+'<line x1="100" y1="158" x2="145" y2="117" stroke="var(--muted)" stroke-width="1.2" marker-end="url(#ar)"/>'
// Home ↔ Grid arrow
+(gridOn?'<line x1="235" y1="95" x2="295" y2="95" stroke="var(--muted)" stroke-width="1.2" marker-end="url(#ar)"/>':'');
const scEl=document.getElementById('flowMetrics');
if(scEl){
const tariff=d.tariff||{};
const costToday=d.costToday||{day:0,night:0};
function gCost(dk,nk){if(tariff.type==='flat')return(dk+nk)*(tariff.flatRate||0);return dk*(tariff.dayRate||0)+nk*(tariff.nightRate||0);}
const todayC=gCost(costToday.day,costToday.night);
const cur=tariff.currency||'';
const tgi=d.totalGridImport||0;
const tle=d.totalLoadEnergy||0;
const allTimeC=gCost(tgi,0);
const standbyLoss=Math.max(0,tgi-tle);
const standbyC=gCost(standbyLoss,0);
const efficiency=tgi>0?((tle/tgi)*100).toFixed(1):'—';
scEl.innerHTML='<div class="metric-card"><span class="metric-lbl">Cost Today</span><span class="metric-val">'+todayC.toFixed(2)+' '+cur+'</span><span class="metric-sub">'+costToday.day.toFixed(1)+' day + '+costToday.night.toFixed(1)+' night kWh</span></div>'
+'<div class="metric-card"><span class="metric-lbl">All-Time Cost</span><span class="metric-val">'+allTimeC.toFixed(2)+' '+cur+'</span><span class="metric-sub">'+tgi.toFixed(1)+' kWh total import</span></div>'
+'<div class="metric-card"><span class="metric-lbl">Standby Loss</span><span class="metric-val">'+standbyC.toFixed(2)+' '+cur+'</span><span class="metric-sub">'+standbyLoss.toFixed(1)+' kWh lost · efficiency '+efficiency+'%</span></div>';}
svg.innerHTML=html;
}
let _tileDetailChart=null;
async function openTileDetail(tileId){
const m=TILE_METRIC_MAP[tileId];
if(!m)return;
document.getElementById('tileDetailTitle').textContent=m.label+' \u2014 last 24h';
document.getElementById('tileDetailModal').classList.add('show');
document.getElementById('tileDetailStats').innerHTML='<span>Loading\u2026</span>';
try{
const d=await apiGet('/api/history?period=day');
const pts=(d.points||[]).filter(p=>p[m.key]!==undefined&&p[m.key]!==null);
if(!pts.length){document.getElementById('tileDetailStats').innerHTML='<span>No history yet</span>';return;}
const vals=pts.map(p=>p[m.key]);
const min=Math.min(...vals),max=Math.max(...vals);
const avg=vals.reduce((a,b)=>a+b,0)/vals.length;
document.getElementById('tileDetailStats').innerHTML=
'<span><b>Min</b> '+min.toFixed(1)+m.unit+'</span><span><b>Avg</b> '+avg.toFixed(1)+m.unit+'</span><span><b>Max</b> '+max.toFixed(1)+m.unit+'</span>';
const labels=pts.map(p=>{const dt=new Date(p.ts);return dt.getHours().toString().padStart(2,'0')+':'+dt.getMinutes().toString().padStart(2,'0');});
if(_tileDetailChart){_tileDetailChart.destroy();_tileDetailChart=null;}
const ctx=document.getElementById('tileDetailChart').getContext('2d');
_tileDetailChart=new Chart(ctx,{type:'line',data:{labels,datasets:[{data:vals,borderColor:'#0a84ff',backgroundColor:'rgba(10,132,255,.12)',fill:true,pointRadius:0,borderWidth:1.5,tension:.3}]},options:{responsive:true,maintainAspectRatio:false,animation:false,plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(28,28,30,0.95)',titleColor:'#f5f5f7',bodyColor:'#f5f5f7',cornerRadius:8,padding:8,callbacks:{label:c=>c.raw+m.unit}}},scales:{x:{ticks:{color:'#98989f',font:{size:9},maxTicksLimit:6,maxRotation:0},grid:{display:false}},y:{ticks:{color:'#98989f',font:{size:9}},grid:{color:'rgba(255,255,255,0.04)'}}}}});
}catch(e){document.getElementById('tileDetailStats').innerHTML='<span>Failed to load: '+e.message+'</span>';}
}
function closeTileDetail(){
document.getElementById('tileDetailModal').classList.remove('show');
if(_tileDetailChart){_tileDetailChart.destroy();_tileDetailChart=null;}
}
async function loadAppVersion(){try{const r=await fetch('/api/app-version');const d=await r.json();if(d.success){const el=document.getElementById('update-info');if(el){el.innerHTML=d.isGit?'Version <strong>'+d.version+'</strong> ('+d.gitHash+') · Branch: '+d.gitBranch:'Version <strong>'+d.version+'</strong> (not a git repo)';if(!d.isGit)document.getElementById('btn-check-update').style.display='none';}const sv=document.getElementById('sidebar-version');if(sv)sv.textContent='v'+d.version;}}catch(e){}}
async function createBackup(){const st=document.getElementById('backup-status');st.style.display='block';st.innerHTML='<i class="bi bi-hourglass-split"></i> Creating backup...';try{const r=await apiPost('/api/backup',{scope:['config','scenes','auth','history']});if(!r.success||!r.backup)throw new Error(r.message||'Backup failed');const bk=r.backup;bk.data.tilePrefs=loadTilePrefs();bk.data.tileOrder=loadTileOrder();const blob=new Blob([JSON.stringify(bk,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='energy-backup-'+new Date().toISOString().slice(0,10)+'.json';a.click();URL.revokeObjectURL(a.href);st.innerHTML='<i class="bi bi-check-circle" style="color:#22c55e"></i> Backup downloaded.';setTimeout(()=>st.style.display='none',4000);}catch(e){st.innerHTML='<i class="bi bi-x-circle" style="color:#ef4444"></i> '+e.message;}}
async function loadServerInfo(){const el=document.getElementById('server-info-body');el.innerHTML='<div style="text-align:center;padding:1rem"><i class="bi bi-hourglass-split"></i> Loading...</div>';try{const d=await apiGet('/api/system-info');let html='<table style="width:100%;font-size:.85rem;border-collapse:collapse">';const fmt=function(b){if(b>=1073741824)return (b/1073741824).toFixed(2)+' GB';if(b>=1048576)return (b/1048576).toFixed(1)+' MB';if(b>=1024)return (b/1024).toFixed(0)+' KB';return b+' B';};const dur=function(s){const d=Math.floor(s/86400);const h=Math.floor((s%86400)/3600);const m=Math.floor((s%3600)/60);return d+'d '+h+'h '+m+'m';};const row=function(l,v){return '<tr><td style="padding:.5rem .3rem;color:var(--text-secondary)">'+l+'</td><td style="padding:.5rem .3rem;text-align:right">'+v+'</td></tr>';};html+=row('Hostname',d.hostname);html+=row('Platform',d.platform);html+=row('Node.js',d.nodeVersion);html+=row('Uptime',dur(d.uptime));html+=row('CPU',d.cpuModel+' ('+d.cpuCores+' cores)');const bar=function(pct){const col=pct>0.7?'#ef4444':pct>0.4?'#eab308':'#22c55e';return '<div style="display:flex;align-items:center;gap:.5rem"><span style="width:3rem;text-align:right">'+pct.toFixed(2)+'</span><div style="flex:1;height:6px;background:var(--border);border-radius:4px;overflow:hidden"><div style="width:'+(pct*100)+'%;height:100%;background:'+col+';border-radius:4px;transition:width .5s"></div></div></div>';};html+=row('CPU Load (1m)',bar(d.cpuLoad[0]));html+=row('CPU Load (5m)',bar(d.cpuLoad[1]));html+=row('CPU Load (15m)',bar(d.cpuLoad[2]));if(d.cpuTemp)html+=row('CPU Temp','<span style="color:'+(parseFloat(d.cpuTemp)>70?'#ef4444':'#22c55e')+'">'+d.cpuTemp+'\u00b0C</span>');if(d.cpuFreq)html+=row('CPU Freq',d.cpuFreq+' MHz');const memPct=(d.usedMem/d.totalMem*100).toFixed(1);html+=row('Memory','<div style="display:flex;justify-content:space-between;gap:.5rem;margin-bottom:4px"><span>Used: '+fmt(d.usedMem)+' / '+fmt(d.totalMem)+'</span><span style="color:'+(parseFloat(memPct)>80?'#ef4444':'')+'">'+memPct+'%</span></div><div style="height:4px;background:var(--border);border-radius:4px;overflow:hidden"><div style="width:'+memPct+'%;height:100%;background:'+(parseFloat(memPct)>80?'#ef4444':'var(--primary)')+';border-radius:4px;transition:width .5s"></div></div>');if(d.diskInfo&&d.diskInfo.total){const diskPct=(d.diskInfo.used/d.diskInfo.total*100).toFixed(1);html+=row('Disk','<div style="display:flex;justify-content:space-between;gap:.5rem;margin-bottom:4px"><span>Used: '+fmt(d.diskInfo.used)+' / '+fmt(d.diskInfo.total)+'</span><span style="color:'+(parseFloat(diskPct)>80?'#ef4444':'')+'">'+diskPct+'%</span></div><div style="height:4px;background:var(--border);border-radius:4px;overflow:hidden"><div style="width:'+diskPct+'%;height:100%;background:'+(parseFloat(diskPct)>80?'#ef4444':'var(--primary)')+';border-radius:4px;transition:width .5s"></div></div>');}html+='</table>';el.innerHTML=html;}catch(e){el.innerHTML='<div style="color:#ef4444;padding:1rem;text-align:center"><i class="bi bi-exclamation-circle"></i> '+e.message+'</div>';}}
async function restoreBackup(file){const st=document.getElementById('backup-status');st.style.display='block';st.innerHTML='<i class="bi bi-hourglass-split"></i> Restoring...';try{const text=await file.text();const bk=JSON.parse(text);if(!bk.data)throw new Error('Invalid backup file');const overwrite=[];if(bk.data.config)overwrite.push('config');if(bk.data.scenes)overwrite.push('scenes');if(bk.data.auth)overwrite.push('auth');if(bk.data.history)overwrite.push('history');
let confirmPassword=null;
if(overwrite.includes('auth')){
  confirmPassword=prompt('This backup contains authentication settings. Enter your current password to confirm:');
  if(!confirmPassword){st.innerHTML='<i class="bi bi-x-circle" style="color:#ef4444"></i> Restore cancelled: password required';return;}
}
const r=await apiPost('/api/backup/restore',{data:bk.data,overwrite,confirmPassword});
if(!r.success)throw new Error(r.message||'Restore failed');
if(bk.data.tilePrefs)saveTilePrefs(bk.data.tilePrefs);
if(bk.data.tileOrder)saveTileOrder(bk.data.tileOrder);
st.innerHTML='<i class="bi bi-check-circle" style="color:#22c55e"></i> '+r.message;
loadScenes();loadTuyaDevices();loadStatus();buildTiles();applyTileOrder();applyTileVisibility();buildTileEditor();
document.getElementById('restoreInput').value='';}catch(e){st.innerHTML='<i class="bi bi-x-circle" style="color:#ef4444"></i> '+e.message;}}
let _updateTarget=null;
async function checkForUpdates(){const btn=document.getElementById('btn-check-update');const st=document.getElementById('update-status');const tagsEl=document.getElementById('update-tags');const branchesEl=document.getElementById('update-branches');st.style.display='none';tagsEl.style.display='none';branchesEl.style.display='none';btn.disabled=true;btn.innerHTML='<i class="bi bi-hourglass-split"></i>';_updateTarget=null;document.getElementById('btn-apply-update').style.display='none';try{const d=await apiPost('/api/update-check',{});if(!d.isGit){st.style.display='block';st.style.color='var(--text-secondary)';st.textContent='Not a git repository. Install via git clone to enable updates.';btn.disabled=false;btn.innerHTML='<i class="bi bi-arrow-clockwise"></i>';return;}if(d.branches&&d.branches.length){branchesEl.style.display='block';let html='<label style="font-size:.78rem;color:var(--muted);display:block;margin-bottom:.5rem">Branches:</label>';d.branches.forEach(b=>{const active=d.currentBranch===b.name;b.name=b.name.replace('origin/','');const style=active?'background:var(--primary);color:#fff;border-color:var(--primary)':'';html+='<div class="update-tag'+(active?' active':'')+'" data-type="branch" data-branch="'+b.name+'" onclick="selectUpdateTarget(this)" style="cursor:pointer;padding:.5rem .75rem;border:1px solid var(--border);border-radius:6px;margin-bottom:.35rem;font-size:.82rem;display:flex;justify-content:space-between;align-items:center;'+style+'"><span><strong>'+b.name+'</strong>'+(active?' <span style="font-size:.7rem;opacity:.7">(current)</span>':'')+'</span><span style="font-size:.7rem;color:var(--muted)">'+b.commit+' &middot; '+b.date.split('T')[0]+'</span></div>';});branchesEl.innerHTML=html;}if(d.tags&&d.tags.length){tagsEl.style.display='block';let html='<label style="font-size:.78rem;color:var(--muted);display:block;margin-bottom:.5rem">Tags (stable releases):</label>';d.tags.forEach(t=>{const active=d.currentTag===t;const style=active?'background:var(--primary);color:#fff;border-color:var(--primary)':'';html+='<div class="update-tag'+(active?' active':'')+'" data-type="tag" data-tag="'+t+'" onclick="selectUpdateTarget(this)" style="cursor:pointer;padding:.5rem .75rem;border:1px solid var(--border);border-radius:6px;margin-bottom:.35rem;font-size:.82rem;'+style+'"><span>'+t+'</span>'+(active?' <span style="font-size:.7rem;opacity:.7">(current)</span>':'')+'</div>';});tagsEl.innerHTML=html;}if((d.branches&&d.branches.length)||(d.tags&&d.tags.length)){document.getElementById('btn-apply-update').style.display='';}else{st.style.display='block';st.style.color='var(--text-secondary)';st.textContent='No branches or tags found.';}}catch(e){st.style.display='block';st.style.color='#ef4444';st.textContent='Error: '+e.message;}btn.disabled=false;btn.innerHTML='<i class="bi bi-arrow-clockwise"></i>';}
function selectUpdateTarget(el){document.querySelectorAll('.update-tag').forEach(t=>{t.classList.remove('active');t.style.background='';t.style.color='';t.style.borderColor='';});el.classList.add('active');el.style.background='var(--primary)';el.style.color='#fff';el.style.borderColor='var(--primary)';const type=el.dataset.type;_updateTarget=type==='branch'?{branch:el.dataset.branch}:{tag:el.dataset.tag};document.getElementById('btn-apply-update').disabled=false;}
async function applyUpdate(){const btn=document.getElementById('btn-apply-update');const st=document.getElementById('update-status');if(!_updateTarget){st.style.display='block';st.style.color='#f59e0b';st.textContent='Select a branch or tag first.';return;}const label=_updateTarget.branch||_updateTarget.tag;if(!confirm('Update to '+label+' and restart?'))return;btn.disabled=true;btn.innerHTML='<i class="bi bi-hourglass-split"></i> Updating...';st.style.display='block';st.style.color='#3b82f6';st.textContent='Checking out '+label+'...';try{await apiPost('/api/update-apply',_updateTarget);st.textContent='Updated! Reconnecting...';setTimeout(()=>{let tries=0;const iv=setInterval(async()=>{tries++;try{const r=await fetch('/');if(r.ok){clearInterval(iv);location.reload();}}catch{}if(tries>30){clearInterval(iv);st.textContent='Restart timed out. Refresh the page manually.';}},1500);},3000);}catch(e){st.style.color='#ef4444';st.textContent='Update failed: '+e.message;btn.disabled=false;btn.innerHTML='<i class="bi bi-download"></i> Update & Restart';}}
loadAppVersion();

loadStatus();loadTuyaDevices();loadScenes();loadLogs();loadHistory('day');loadSocketHistory('day');loadOtherHistory('day');
buildTiles();applyTileOrder();applyTileVisibility();buildTileEditor();
(function(){const s=document.querySelector('.sidebar');if(!s||window.innerWidth<=768)return;const ls=localStorage.getItem('sidebarOpen');const isOpen=ls!==null?ls==='1':true;s.classList.toggle('open',isOpen);const btn=document.querySelector('.sidebar-toggle i');if(btn)btn.className=isOpen?'bi bi-chevron-left':'bi bi-chevron-right';})();
setInterval(loadStatus,10000);
setInterval(loadLogs,30000);
setInterval(()=>loadHistory(),60000);
setInterval(()=>loadSocketHistory(),60000);
setInterval(()=>loadOtherHistory(),60000);
setInterval(loadTuyaDevices,30000);
if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js?v=5').catch(()=>{});}
</script>
</body>
</html>`;
  return _cachedWebUI;
}

// ============================================================
// TLS CERTIFICATE MANAGEMENT
// ============================================================
async function ensureCertificates() {
  try {
    if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
      return {
        cert: await fs.promises.readFile(CERT_FILE),
        key: await fs.promises.readFile(KEY_FILE),
      };
    }
    // Generate self-signed certificate using OpenSSL
    const cmd = `openssl req -x509 -newkey rsa:2048 -keyout "${KEY_FILE}" -out "${CERT_FILE}" -days 3650 -nodes -subj "/CN=Energy Controller" 2>/dev/null`;
    await new Promise((resolve, reject) => {
      exec(cmd, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve();
      });
    });
    await fs.promises.chmod(KEY_FILE, 0o600);
    await fs.promises.chmod(CERT_FILE, 0o600);
    log.info('Self-signed TLS certificate generated');
    return {
      cert: await fs.promises.readFile(CERT_FILE),
      key: await fs.promises.readFile(KEY_FILE),
    };
  } catch (err) {
    log.error('Failed to generate TLS certificate: ' + err.message);
    return null;
  }
}

// ============================================================
// MAIN — STARTUP
// ============================================================
async function main() {
  log.info('Energy Controller starting...');

  // Initialize
  await ensureAuth();
  await ensureMetricsToken();
  await loadSessions();
  await loadDailyRecords();
  await rrdInit();
  await loadScenes();
  const cfg = await loadConfig();
  const port = cfg.webPort || WEB_PORT_DEFAULT;

  // Generate/load TLS certificates
  const tls = await ensureCertificates();

  // Start HTTP server (redirects to HTTPS if TLS available)
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

  // Start HTTPS server if certificates available
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

  // Start inverter polling (will use demo data if connection fails)
  await connectToInverter();
  if (!inverterData.lastUpdate) injectDemoData();
  pollInverter();
  setInterval(() => {
    if (_inverterConsecutiveFails >= 5) {
      if (_pollingInverter) return;
      log.info('Inverter: too many failures, reconnecting...');
      connectToInverter().then(() => pollInverter());
    } else {
      pollInverter();
    }
  }, 10000);
  // Collect raw data every 60s (in-memory only — flushed to SD every 5 min)
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

  // Flush RRD to SD every 5 min
  setInterval(rrdFlush, RRD_FLUSH_MS);

  // Initialize Tuya
  await initTuya();
  // Push initial socket snapshot
  const devs = {};
  for (const dev of tuyaDevices) {
    if (dev.power !== undefined && dev.power !== null) devs[dev.id] = dev.power;
  }
  if (Object.keys(devs).length > 0) RRD_SOCKET_PENDING.push({ ts: Date.now(), devices: devs });

  // Periodic Tuya status polling + socket data collection
  setInterval(async () => {
    await fetchDeviceStatuses();
    const devs2 = {};
    for (const dev of tuyaDevices) {
      if (dev.power !== undefined && dev.power !== null) devs2[dev.id] = dev.power;
    }
    if (Object.keys(devs2).length > 0) RRD_SOCKET_PENDING.push({ ts: Date.now(), devices: devs2 });
  }, 60000);

  // Scene check loop
  setInterval(checkScenes, 10000);

  // Notification triggers (check every 2 min)
  let _notifiedLowSoc = false;
let _gridWasOn=null; let _gridOffSince=null; let _gridOffSoc=null; let _gridOffLoadAccum=0; let _gridOffLastTs=0;
  setInterval(async () => {
    try {
      const cfg = await loadConfig();
      const n = cfg.notifications || {};
      const soc = inverterData.batterySOC;

      // Low SOC alert
      if (soc > 0 && soc <= (n.lowSocAlert || 20) && !_notifiedLowSoc && (n.ntfyTopic || n.telegramToken)) {
        _notifiedLowSoc = true;
        sendNotification('Low Battery', 'SOC: ' + soc + '% — below ' + (n.lowSocAlert || 20) + '% threshold', true);
      } else if (soc > (n.lowSocAlert || 20) + 5) {
        _notifiedLowSoc = false;
      }

      // Inverter offline alert
      if (_inverterConsecutiveFails >= 5 && n.connTimeout && (n.ntfyTopic || n.telegramToken)) {
        sendNotification('Inverter Offline', _inverterConsecutiveFails + ' consecutive poll failures. Check connection.', true);
      }

      // Grid outage report
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
            'Battery: ' + _gridOffSoc + '% → ' + socNow + '%' + (socUsed > 0 ? ' (used ' + socUsed + '%)' : ''),
            'Load energy: ~' + loadUsed + ' kWh',
          ].join('\n');

          if (n.ntfyTopic || n.telegramToken) sendNotification('Grid Restored', report, false);
          log.info('Grid outage ended: ' + hours + 'h' + mins + 'm, SOC ' + _gridOffSoc + '%→' + socNow + '%');

          _gridOffSince = null;
          _gridOffSoc = null;
          _gridOffLoadAccum = 0;
        }
      }
    } catch {}
  }, 120000);

  // Session cleanup
  setInterval(() => {
    const now = Date.now();
    for (const token of Object.keys(sessions)) {
      if (sessions[token].exp < now) delete sessions[token];
    }
    saveSessions();
  }, 60 * 60 * 1000);

  log.info('Energy Controller started');
}

main().catch(err => {
  log.error('Fatal: ' + err.message);
  process.exit(1);
});

// Graceful shutdown
let httpServer, httpsServer;

const shutdown = async (signal) => {
  log.info(signal + ' received, shutting down...');
  if (httpServer) httpServer.close();
  if (httpsServer) httpsServer.close();
  server.close();
  // Save sessions to disk
  try {
    const now = Date.now();
    const active = {};
    for (const [token, s] of Object.entries(sessions)) {
      if (s.exp && s.exp > now) active[token] = s;
    }
    await fs.promises.writeFile(SESSIONS_FILE, JSON.stringify(active, null, 2), { mode: 0o600 });
  } catch {}
  lastRrdFlush = 0;
  try { await rrdFlush(); } catch (err) { log.error('Flush on shutdown: ' + err.message); }
  if (inverter) try { await inverter.disconnect(); } catch {}
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
