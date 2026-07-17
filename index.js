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

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const SCENES_FILE = path.join(DATA_DIR, 'scenes.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const SOCKETS_FILE = path.join(DATA_DIR, 'sockets.json');

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

async function pollInverter() {
  if (_pollingInverter) return;
  _pollingInverter = true;
  try {
    if (!inverter || !inverter.connected) {
      const connected = await connectToInverter();
      if (!connected) { _inverterConsecutiveFails++; return; }
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
// HISTORY STORAGE
// ============================================================
const HISTORY_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
let lastHistorySave = 0;
const HISTORY_SAVE_INTERVAL = 60 * 1000;

async function loadHistory() {
  try {
    return JSON.parse(await fs.promises.readFile(HISTORY_FILE, 'utf8'));
  } catch {
    return { points: [] };
  }
}

async function saveHistoryPoint() {
  const now = Date.now();
  if (now - lastHistorySave < HISTORY_SAVE_INTERVAL) return;
  lastHistorySave = now;
  try {
    const history = await loadHistory();
    const socketSum = tuyaDevices.reduce((a, d) => a + (d.power || 0), 0);
    history.points.push({
      ts: now,
      grid: inverterData.gridPower,
      soc: inverterData.batterySOC,
      load: inverterData.loadPower,
      bat: inverterData.batteryPower,
      pv: inverterData.pvPower,
      otherLoad: Math.max(0, Math.round((inverterData.loadPower - socketSum) * 10) / 10),
    });
    const cutoff = now - HISTORY_MAX_AGE_MS;
    history.points = history.points.filter(p => p.ts > cutoff);
    await fs.promises.writeFile(HISTORY_FILE, JSON.stringify(history), { mode: 0o600 });
  } catch (err) {
    log.error('History save failed: ' + err.message);
  }
}

function aggregateHistory(points, intervalMs) {
  if (!points.length) return [];
  const buckets = new Map();
  for (const p of points) {
    const key = Math.floor(p.ts / intervalMs) * intervalMs;
    if (!buckets.has(key)) buckets.set(key, { ts: key, grid: [], soc: [], load: [], bat: [], pv: [], otherLoad: [], count: 0 });
    const b = buckets.get(key);
    b.grid.push(p.grid ? 1 : 0);
    b.soc.push(p.soc);
    b.load.push(p.load);
    b.bat.push(p.bat);
    b.pv.push(p.pv);
    b.otherLoad.push(p.otherLoad || 0);
    b.count++;
  }
  const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 10) / 10 : 0;
  return [...buckets.values()].map(b => ({
    ts: b.ts,
    grid: b.grid.reduce((a, v) => a + v, 0) / b.count >= 0.5,
    soc: avg(b.soc),
    load: avg(b.load),
    bat: avg(b.bat),
    pv: avg(b.pv),
    otherLoad: avg(b.otherLoad),
  }));
}

// ============================================================
// SOCKET POWER HISTORY
// ============================================================
let lastSocketSave = 0;
const SOCKET_SAVE_INTERVAL = 60 * 1000;

async function loadSocketHistory() {
  try {
    return JSON.parse(await fs.promises.readFile(SOCKETS_FILE, 'utf8'));
  } catch {
    return { points: [] };
  }
}

async function saveSocketPoint() {
  const now = Date.now();
  if (now - lastSocketSave < SOCKET_SAVE_INTERVAL) return;
  lastSocketSave = now;
  try {
    const history = await loadSocketHistory();
    const devices = {};
    for (const dev of tuyaDevices) {
      if (dev.power !== undefined && dev.power !== null) {
        devices[dev.id] = dev.power;
      }
    }
    if (Object.keys(devices).length === 0) return;
    history.points.push({ ts: now, devices });
    const cutoff = now - HISTORY_MAX_AGE_MS;
    history.points = history.points.filter(p => p.ts > cutoff);
    await fs.promises.writeFile(SOCKETS_FILE, JSON.stringify(history), { mode: 0o600 });
  } catch (err) {
    log.error('Socket history save failed: ' + err.message);
  }
}

function aggregateSocketHistory(points, intervalMs) {
  if (!points.length) return [];
  const buckets = new Map();
  for (const p of points) {
    const key = Math.floor(p.ts / intervalMs) * intervalMs;
    if (!buckets.has(key)) buckets.set(key, { ts: key, devices: {}, count: 0 });
    const b = buckets.get(key);
    for (const [id, val] of Object.entries(p.devices || {})) {
      if (!b.devices[id]) b.devices[id] = [];
      b.devices[id].push(val);
    }
    b.count++;
  }
  return [...buckets.values()].map(b => {
    const devices = {};
    for (const [id, arr] of Object.entries(b.devices)) {
      devices[id] = Math.round(arr.reduce((a, v) => a + v, 0) / arr.length * 10) / 10;
    }
    return { ts: b.ts, devices };
  });
}

// ============================================================
// TUYA DEVICE MANAGEMENT
// ============================================================
let tuyaDevices = [];
let tuyaToken = null;
let tuyaTokenExpire = 0;
let tuyaUid = null;

async function getTuyaToken() {
  const cfg = await loadConfig();
  const tc = cfg.tuya || {};
  try {
    const body = {
      country_code: tc.countryCode || 48,
      username: tc.username,
      password: crypto.createHash('md5').update(tc.password || '').digest('hex'),
      schema: tc.appSchema || 'tuyaSmart',
    };
    const result = await tuyaRequest('POST', '/v1.0/iot-01/associated-users/actions/authorized-login', body, null, tc);
    if (result.success) {
      tuyaToken = result.result.access_token;
      tuyaTokenExpire = Date.now() + (result.result.expire_time - 60) * 1000;
      tuyaUid = result.result.uid;
      log.info('Tuya token obtained');
    } else {
      log.error('getTuyaToken failed: ' + result.msg + ' (code: ' + result.code + ')');
    }
  } catch (err) {
    log.error('getTuyaToken error: ' + err.message);
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
    log.info(device.name + ' set to ' + (value ? 'ON' : 'OFF'));
  } else {
    throw new Error(result.msg || 'Tuya control failed');
  }
}

async function initTuya() {
  await syncDeviceNamesFromCloud();
  await fetchDeviceStatuses();
}

// ============================================================
// CONFIG SYSTEM
// ============================================================
async function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(await fs.promises.readFile(CONFIG_FILE, 'utf8'));
    }
  } catch (err) {
    log.error('Failed to load config: ' + err.message);
  }
  return {
    inverter: { ip: '', serial: '', port: 8899 },
    tuya: { accessId: '', accessKey: '', countryCode: 48, username: '', password: '', appSchema: 'tuyaSmart' },
    webPort: 8583,
  };
}

async function saveConfig(cfg) {
  try {
    await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  } catch (err) {
    log.error('Failed to save config: ' + err.message);
  }
}

// ============================================================
// AUTH SYSTEM
// ============================================================
const loginAttempts = {};
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW = 60 * 1000;
let sessions = {};
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

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
      const { salt, hash } = hashPassword('admin');
      await fs.promises.writeFile(AUTH_FILE, JSON.stringify({ username: 'admin', salt, hash }, null, 2), { mode: 0o600 });
      log.info('Auth file created');
    }
  } catch (err) {
    log.error('Failed to initialize auth: ' + err.message);
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
  sessions[token] = Date.now() + SESSION_TTL;
  return token;
}

function isSessionValid(token) {
  const exp = sessions[token];
  if (!exp) return false;
  if (Date.now() > exp) { delete sessions[token]; return false; }
  sessions[token] = Date.now() + SESSION_TTL;
  return true;
}

function destroySession(token) { delete sessions[token]; }

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
  _checkingScenes = true;
  try {
    const now = Date.now();
    for (const scene of scenes) {
      if (scene.enabled === false) continue;
      let conditionsMet = true;
      for (const cond of scene.if.conditions) {
        if (cond.type === 'grid') {
          if (inverterData.gridPower !== cond.value) { conditionsMet = false; break; }
        } else if (cond.type === 'battery') {
          const op = cond.operator || '=';
          if (op === '<' && !(inverterData.batterySOC < cond.value)) { conditionsMet = false; break; }
          else if (op === '>' && !(inverterData.batterySOC > cond.value)) { conditionsMet = false; break; }
          else if (op === '=' && !(inverterData.batterySOC === cond.value)) { conditionsMet = false; break; }
        }
      }

      for (const action of scene.then.actions) {
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
              } catch (err) { log.error('Scene revert failed: ' + err.message); }
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
              } catch (err) { log.error('Scene action failed: ' + err.message); }
              state.active = true;
              state.appliedAt = now;
            }
          }
        } else {
          if (state.active) {
            try {
              await controlDevice(action.device, !action.value);
              log.info('Scene "' + scene.name + '" reverted (conditions changed)');
            } catch (err) { log.error('Scene revert failed: ' + err.message); }
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
    req.on('data', (chunk) => { body += chunk; });
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

function setCookie(res, name, value, maxAge) {
  const existing = res.getHeader('Set-Cookie') || [];
  const cookies = Array.isArray(existing) ? existing : [existing];
  cookies.push(`${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
  res.setHeader('Set-Cookie', cookies);
}

function clearCookie(res, name) {
  setCookie(res, name, '', 0);
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
      const token = createSession();
      setCookie(res, 'ecm_session', token, SESSION_TTL / 1000);
      return sendJson(res, 200, { success: true });
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
  clearCookie(res, 'ecm_session');
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
    await fs.promises.writeFile(AUTH_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 });
    sessions = {};
    log.info('Password changed, all sessions invalidated');
    sendJson(res, 200, { success: true });
  } catch (err) {
    sendJson(res, 500, { success: false, message: err.message });
  }
});

// Inverter data
route('GET', '/api/status', (req, res) => {
  sendJson(res, 200, {
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
    dayGridExport: inverterData.dayGridExport,
    dayBatCharge: inverterData.dayBatCharge,
    dayBatDischarge: inverterData.dayBatDischarge,
    dayLoadEnergy: inverterData.dayLoadEnergy,
    debug: inverterData.debug || {},
    tuyaDevices: tuyaDevices.map(d => ({ id: d.id, name: d.name, switch: d.switch, power: d.power || 0, voltage: d.voltage || 0, current: d.current || 0 })),
    scenes: scenes,
  });
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
        merged.tuya[k] = newCfg.tuya[k];
      }
    }
    if (newCfg.webPort !== undefined) merged.webPort = parseInt(newCfg.webPort) || 8583;
    await saveConfig(merged);
    sendJson(res, 200, { success: true, message: 'Config saved. Restart to apply.' });
  } catch (err) {
    sendJson(res, 500, { success: false, message: err.message });
  }
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

// History data
route('GET', '/api/history', async (req, res) => {
  try {
    const period = (req.url.split('period=')[1] || 'day').split('&')[0];
    const history = await loadHistory();
    const now = Date.now();
    const today = new Date();
    const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    let intervalMs, cutoffMs;
    switch (period) {
      case 'week': {
        const day = today.getDay();
        const diff = (day === 0 ? 6 : day - 1);
        intervalMs = 15 * 60 * 1000;
        cutoffMs = now - (midnight - diff * 24 * 60 * 60 * 1000);
        break;
      }
      case 'month': intervalMs = 60 * 60 * 1000; cutoffMs = now - new Date(today.getFullYear(), today.getMonth(), 1).getTime(); break;
      case 'year': intervalMs = 24 * 60 * 60 * 1000; cutoffMs = now - new Date(today.getFullYear(), 0, 1).getTime(); break;
      default: intervalMs = 60 * 1000; cutoffMs = now - midnight;
    }
    const filtered = history.points.filter(p => p.ts > now - cutoffMs);
    const aggregated = aggregateHistory(filtered, intervalMs);
    sendJson(res, 200, { success: true, period, points: aggregated });
  } catch (err) {
    sendJson(res, 500, { success: false, message: err.message });
  }
});

// Socket history data
route('GET', '/api/socket-history', async (req, res) => {
  try {
    const period = (req.url.split('period=')[1] || 'day').split('&')[0];
    const history = await loadSocketHistory();
    const now = Date.now();
    const today = new Date();
    const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    let intervalMs, cutoffMs;
    switch (period) {
      case 'week': {
        const day = today.getDay();
        const diff = (day === 0 ? 6 : day - 1);
        intervalMs = 15 * 60 * 1000;
        cutoffMs = now - (midnight - diff * 24 * 60 * 60 * 1000);
        break;
      }
      case 'month': intervalMs = 60 * 60 * 1000; cutoffMs = now - new Date(today.getFullYear(), today.getMonth(), 1).getTime(); break;
      case 'year': intervalMs = 24 * 60 * 60 * 1000; cutoffMs = now - new Date(today.getFullYear(), 0, 1).getTime(); break;
      default: intervalMs = 60 * 1000; cutoffMs = now - midnight;
    }
    const filtered = history.points.filter(p => p.ts > now - cutoffMs);
    const aggregated = aggregateSocketHistory(filtered, intervalMs);
    const deviceNames = {};
    for (const dev of tuyaDevices) {
      deviceNames[dev.id] = dev.name;
    }
    sendJson(res, 200, { success: true, period, points: aggregated, deviceNames });
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
route('GET', '/api/system-info', (req, res) => {
  sendJson(res, 200, {
    hostname: os.hostname(),
    platform: os.platform(),
    uptime: os.uptime(),
    nodeVersion: process.version,
  });
});

// App version & git info
route('GET', '/api/app-version', async (req, res) => {
  try {
    const pkg = JSON.parse(await fs.promises.readFile(path.join(__dirname, 'package.json'), 'utf8'));
    const version = pkg.version || '1.0.0';
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
      isGitRepo = true;
    } catch {}
    sendJson(res, 200, { success: true, version, gitHash, gitBranch, gitRemote, isGitRepo });
  } catch (err) {
    sendJson(res, 500, { success: false, message: err.message });
  }
});

// Check for git updates
route('POST', '/api/update-check', async (req, res) => {
  try {
    const isGit = (await new Promise(r => exec('git rev-parse --is-inside-work-tree', { cwd: __dirname }, (e, o) => r(!e && o.trim() === 'true'))));
    if (!isGit) return sendJson(res, 200, { success: true, isGit: false, message: 'Not a git repository' });
    await new Promise((resolve, reject) => { exec('git fetch origin', { cwd: __dirname }, (e) => e ? reject(e) : resolve()); });
    const local = (await new Promise(r => exec('git rev-parse HEAD', { cwd: __dirname }, (e, o) => r(o.trim())))).trim();
    const remote = (await new Promise(r => exec('git rev-parse origin/main', { cwd: __dirname }, (e, o) => r(o.trim())))).trim();
    const isUpToDate = local === remote;
    let commits = [];
    if (!isUpToDate) {
      const log = (await new Promise(r => exec('git log HEAD..origin/main --oneline', { cwd: __dirname }, (e, o) => r(o || '')))).trim();
      commits = log ? log.split('\n') : [];
    }
    sendJson(res, 200, { success: true, isGit: true, isUpToDate, local: local.slice(0, 7), remote: remote.slice(0, 7), commits });
  } catch (err) {
    sendJson(res, 200, { success: false, message: err.message });
  }
});

// Update from git & restart
route('POST', '/api/update-apply', (req, res) => {
  sendJson(res, 200, { success: true, message: 'Updating...' });
  setTimeout(() => {
    exec('git pull origin main', { cwd: __dirname }, (err, stdout) => {
      log.info('Git pull: ' + (err ? err.message : stdout.trim()));
      setTimeout(() => { exec('sudo systemctl restart energy-controller', () => {}); }, 1000);
    });
  }, 500);
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
const CACHE = 'ecm-v4';
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
  if (req.url === '/sw.js' || req.url === '/manifest.json') return true;

  const cookies = parseCookies(req);
  const token = cookies['ecm_session'];
  if (token && isSessionValid(token)) return true;

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
<link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.0/font/bootstrap-icons.css" rel="stylesheet" />
<style>
:root{--bg:#000;--card:rgba(28,28,30,.72);--border:rgba(255,255,255,.09);--text:#f5f5f7;--muted:#98989f;--primary:#bf5af2;--primary-dark:#a742d6;--danger:#ff453a}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{background:radial-gradient(circle at 20% 0%,#1c1030 0%,#000 45%),#000;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:1.5rem;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;color:var(--text)}
.card{width:100%;max-width:360px;background:var(--card);-webkit-backdrop-filter:blur(24px);backdrop-filter:blur(24px);border:.5px solid var(--border);border-radius:22px;padding:2rem 1.75rem;box-shadow:0 20px 60px rgba(0,0,0,.5)}
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
<script>
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
if(d.success){window.location.href='/';}
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
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet" />
<link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.0/font/bootstrap-icons.css" rel="stylesheet" />
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
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
  --sidebar-c:64px;
  --sidebar-e:230px;
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
.sidebar{position:fixed;top:0;left:0;width:var(--sidebar-c);height:100vh;height:100dvh;
  background:var(--sidebar);-webkit-backdrop-filter:saturate(180%) blur(24px);backdrop-filter:saturate(180%) blur(24px);
  border-right:.5px solid var(--separator);display:flex;flex-direction:column;z-index:1000;overflow:hidden;
  transition:width .3s cubic-bezier(.25,.8,.25,1);padding:calc(.6rem + var(--safe-t)) 0 .6rem;
  will-change:width}
.sidebar:hover{width:var(--sidebar-e)}
.sidebar-brand{padding:.5rem .9rem;font-size:1.4rem;color:var(--text);display:flex;align-items:center;gap:.6rem;
  border-bottom:.5px solid var(--separator);margin-bottom:.6rem;white-space:nowrap;overflow:hidden}
.sidebar-brand i{color:var(--primary);font-size:1.4rem;flex-shrink:0}
.sidebar-brand .brand-main,.sidebar-brand .brand-version{opacity:0;transition:opacity .2s}
.sidebar:hover .sidebar-brand .brand-main,.sidebar:hover .sidebar-brand .brand-version{opacity:1}
.sidebar-brand .brand-version{font-size:.68rem;color:var(--muted);margin-left:auto}
.sidebar-menu{flex:1;list-style:none;padding:0 .4rem;margin:0;overflow:hidden}
.menu-item{padding:.65rem .7rem;margin:.15rem 0;display:flex;align-items:center;gap:.75rem;color:var(--muted);
  cursor:pointer;transition:background .15s,color .15s;font-size:.92rem;white-space:nowrap;border-radius:var(--radius-sm)}
.menu-item:hover{color:var(--text);background:rgba(255,255,255,.06)}
.menu-item.active{color:var(--text);background:rgba(191,90,242,.16)}
.menu-item.active i{color:var(--primary)}
.menu-item i{font-size:1.25rem;width:1.6rem;text-align:center;flex-shrink:0;color:var(--muted)}
.menu-item span:not(.badge-hb){opacity:0;transition:opacity .2s}
.sidebar:hover .menu-item span:not(.badge-hb){opacity:1}
.menu-item .badge-hb{margin-left:auto;opacity:0;transition:opacity .2s}
.sidebar:hover .menu-item .badge-hb{opacity:1}
.sidebar-footer{padding:.4rem .6rem;border-top:.5px solid var(--separator);display:flex;flex-direction:column;gap:.1rem}
.power-item{display:flex;align-items:center;gap:.5rem;padding:.3rem .4rem;border-radius:6px;color:var(--muted);cursor:pointer;font-size:.75rem;white-space:nowrap;transition:background .15s,color .15s}
.power-item:hover{color:var(--text);background:rgba(255,255,255,.08)}
.power-item i{width:1.1rem;text-align:center;font-size:.85rem;flex-shrink:0}
.power-item span{opacity:0;transition:opacity .2s;font-size:.72rem}
.power-item.c-primary{color:var(--muted)}.power-item.c-danger{color:var(--muted)}
.sidebar:hover .power-item span{opacity:1}
.main{margin-left:var(--sidebar-c);flex:1;padding:calc(1.5rem + var(--safe-t)) 2rem 2rem;min-height:100vh;min-height:100dvh;
  max-width:calc(100% - var(--sidebar-c));transition:margin-left .3s cubic-bezier(.25,.8,.25,1);
  will-change:margin-left}
.sidebar:hover~.main{margin-left:var(--sidebar-e);max-width:calc(100% - var(--sidebar-e))}
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
.hb-toast{position:fixed;bottom:calc(2rem + var(--safe-b));right:2rem;background:var(--card-solid);
  -webkit-backdrop-filter:blur(24px);backdrop-filter:blur(24px);border:.5px solid var(--border);
  border-radius:var(--radius-md);padding:.9rem 1.25rem;box-shadow:0 12px 40px rgba(0,0,0,.55);
  max-width:360px;z-index:9999;display:none;border-left:4px solid var(--success)}
.hb-toast.error{border-left-color:var(--danger)}
.toast-title{font-weight:700;margin-bottom:.2rem}
.toast-body{color:var(--muted);font-size:.85rem}
.hb-toast.show{display:block;animation:slideUp .3s cubic-bezier(.25,.8,.25,1)}
.modal-backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:999;align-items:center;justify-content:center}
.modal-backdrop.show{display:flex}
.modal-box{background:var(--card-solid);border:1px solid var(--separator);border-radius:14px;padding:1.5rem;max-width:340px;width:90%;text-align:center}
.modal-box h3{margin:0 0 .4rem;font-size:1rem;color:var(--text)}
.modal-box p{margin:0 0 1.2rem;font-size:.85rem;color:var(--muted)}
.modal-btns{display:flex;gap:.6rem;justify-content:center}
.modal-btns .btn-hb{flex:1;max-width:140px}
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
.chart-tab{padding:.35rem .75rem;border-radius:980px;font-size:.75rem;font-weight:600;cursor:pointer;border:.5px solid var(--border);background:transparent;color:var(--muted);transition:all .15s}
.chart-tab.active{background:var(--primary);color:#fff;border-color:var(--primary)}
.chart-tab:hover:not(.active){color:var(--text);border-color:rgba(255,255,255,.2)}
.chart-wrap{position:relative;height:220px;width:100%}
@media(max-width:768px){.chart-wrap{height:180px}}
.device-controls{display:flex;gap:.5rem;align-items:center}
.device-controls .btn-hb{padding:.4rem .9rem;font-size:.75rem}
@media(max-width:768px){
  .mobile-only{display:block}
  body{display:block;overflow-x:hidden}
  .sidebar{top:auto;bottom:0;left:0;width:100%;height:auto;
    padding:.35rem 0 calc(.35rem + var(--safe-b));
    flex-direction:row;align-items:stretch;justify-content:space-around;
    border-right:none;border-top:.5px solid var(--separator);
    background:rgba(20,20,22,.82);-webkit-backdrop-filter:saturate(180%) blur(28px);backdrop-filter:saturate(180%) blur(28px)}
  .sidebar:hover{width:100%}
  .sidebar-brand,.sidebar-footer{display:none}
  .sidebar-menu{display:flex;flex-direction:row;justify-content:space-around;align-items:stretch;flex:1;padding:0;overflow:visible}
  .menu-item{flex-direction:column;justify-content:center;align-items:center;gap:.15rem;padding:.3rem .4rem;
    margin:0;border-radius:var(--radius-sm);flex:1;min-width:0;background:none!important}
  .menu-item.active{background:none!important}
  .menu-item i{font-size:1.4rem;width:auto}
  .menu-item span:not(.badge-hb){opacity:1;font-size:.66rem;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
  .menu-item .badge-hb{opacity:1;position:absolute;margin-left:0;transform:translate(10px,-14px);padding:.05rem .4rem;font-size:.55rem}
  .menu-item{position:relative}
  .main,.sidebar:hover~.main{margin-left:0;max-width:100%;padding:calc(1rem + var(--safe-t)) 1rem calc(var(--tabbar-h) + var(--safe-b) + 1.5rem)}
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
  .sidebar{width:210px;padding-top:calc(.5rem + var(--safe-t));padding-left:var(--safe-l)}
  .sidebar:hover{width:210px}
  .sidebar-brand .brand-main,.sidebar-brand .brand-version{opacity:1}
  .menu-item span:not(.badge-hb){opacity:1}
  .menu-item .badge-hb{opacity:1}
  .power-item span{opacity:1}
  .main,.sidebar:hover~.main{margin-left:210px;max-width:calc(100% - 210px);padding:calc(1.25rem + var(--safe-t)) 1.5rem 1.5rem}
  .device-grid{grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}
  .rule-row .rule-field{min-width:160px}
}
@media (hover:none) and (pointer:coarse) and (min-width:1080px){
  .device-grid{grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
}
</style>
</head>
<body>
<aside class="sidebar">
<div class="sidebar-brand"><i class="bi bi-lightning-charge-fill"></i><span class="brand-main">Energy</span><span class="brand-version">v1.0</span></div>
<ul class="sidebar-menu">
<li class="menu-item active" data-tab="status"><i class="bi bi-speedometer2"></i><span>Status</span></li>
<li class="menu-item" data-tab="devices"><i class="bi bi-cpu"></i><span>Devices</span><span class="badge-hb purple" id="sidebar-device-count">0</span></li>
<li class="menu-item" data-tab="automations"><i class="bi bi-diagram-3"></i><span>Automations</span><span class="badge-hb purple" id="sidebar-scene-count">0</span></li>
<li class="menu-item" data-tab="settings"><i class="bi bi-gear"></i><span>Settings</span></li>
</ul>
<div class="sidebar-footer">
<div class="power-item" onclick="location.reload()"><i class="bi bi-arrow-clockwise"></i><span>Restart UI</span></div>
<div class="power-item c-primary" onclick="restartApp()"><i class="bi bi-arrow-repeat"></i><span>Restart App</span></div>
<div class="power-item c-danger" onclick="logout()"><i class="bi bi-box-arrow-right"></i><span>Log Out</span></div>
</div>
</aside>
<main class="main">
<div class="tab-pane active" id="tab-status">
<div id="pull-indicator"><i class="bi bi-arrow-down"></i></div>
<div class="page-header"><h1>Status</h1><div style="display:flex;gap:.4rem"><button class="btn-hb btn-hb-outline btn-hb-sm" onclick="loadStatus();loadLogs()" id="refreshBtn"><i class="bi bi-arrow-clockwise"></i></button><button class="btn-hb btn-hb-outline btn-hb-sm" onclick="toggleTileEditor()" id="editTilesBtn"><i class="bi bi-pencil-square"></i></button></div></div>
<div class="tile-edit-panel" id="tileEditPanel">
<div class="tile-edit-grid" id="tileEditGrid"></div>
</div>
<div class="tiles-container" id="tilesContainer">
<div class="tile" id="tile-grid"><span class="icon"><i class="bi bi-plug"></i></span><div class="label">City Grid</div><div class="value" id="grid-status">--</div><div class="sub" id="grid-voltage"></div></div>
<div class="tile" id="tile-battery"><span class="icon"><i class="bi bi-battery-half"></i></span><div class="label">Battery</div><div class="value" id="battery-status">--%</div><div class="sub" id="battery-power"></div></div>
<div class="tile" id="tile-pv"><span class="icon"><i class="bi bi-sun"></i></span><div class="label">Solar PV</div><div class="value" id="pv-status">--</div><div class="sub" id="pv-detail"></div></div>
<div class="tile" id="tile-load"><span class="icon"><i class="bi bi-laptop"></i></span><div class="label">Load</div><div class="value" id="load-status">--</div><div class="sub" id="clock-tile">consumption</div></div>
<div class="tile" id="tile-day-pv"><span class="icon"><i class="bi bi-sun"></i></span><div class="label">Solar Today</div><div class="value" id="day-pv-status">-- kWh</div><div class="sub" id="day-pv-sub"></div></div>
<div class="tile" id="tile-day-import"><span class="icon"><i class="bi bi-box-arrow-in-down"></i></span><div class="label">Grid Import</div><div class="value" id="day-import-status">-- kWh</div><div class="sub" id="day-import-sub">today</div></div>
<div class="tile" id="tile-day-export"><span class="icon"><i class="bi bi-box-arrow-up"></i></span><div class="label">Grid Export</div><div class="value" id="day-export-status">-- kWh</div><div class="sub" id="day-export-sub">today</div></div>
<div class="tile" id="tile-day-load"><span class="icon"><i class="bi bi-lightning"></i></span><div class="label">Load Today</div><div class="value" id="day-load-status">-- kWh</div><div class="sub" id="day-load-sub">consumed</div></div>
<div class="tile" id="tile-day-batcharge"><span class="icon"><i class="bi bi-battery-charging"></i></span><div class="label">Bat Charge</div><div class="value" id="day-batcharge-status">-- kWh</div><div class="sub" id="day-batcharge-sub">today</div></div>
<div class="tile" id="tile-day-batdischarge"><span class="icon"><i class="bi bi-battery"></i></span><div class="label">Bat Discharge</div><div class="value" id="day-batdischarge-status">-- kWh</div><div class="sub" id="day-batdischarge-sub">today</div></div>
<div class="tile" id="tile-battemp"><span class="icon"><i class="bi bi-thermometer-half"></i></span><div class="label">Battery Temp</div><div class="value" id="bat-temp-status">-- °C</div><div class="sub" id="bat-temp-sub"></div></div>
<div class="tile" id="tile-envtemp"><span class="icon"><i class="bi bi-thermometer"></i></span><div class="label">Environment</div><div class="value" id="env-temp-status">-- °C</div><div class="sub" id="env-temp-sub">temperature</div></div>
</div>
<div class="hb-card chart-section collapsed" style="margin-bottom:.75rem">
<div class="hb-card-header" style="cursor:pointer" onclick="this.parentElement.classList.toggle('collapsed')"><div class="hb-card-title"><i class="bi bi-cpu" style="margin-right:.5rem"></i>Inverter Debug</div><div style="font-size:.8rem;color:var(--muted)">tap to toggle <i class="bi bi-chevron-down toggle-arrow" style="font-size:.7rem;margin-left:.2rem"></i></div></div>
<div id="debug-grid" style="padding:.5rem .75rem;font-size:.78rem;font-family:monospace;color:var(--text);display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:.25rem .75rem"></div>
</div>
<div class="hb-card chart-section">
<div class="hb-card-header"><div class="hb-card-title"><i class="bi bi-graph-up" style="margin-right:.5rem"></i>Power History</div><div class="chart-tabs" id="chartTabs"><div class="chart-tab active" data-period="day">Day</div><div class="chart-tab" data-period="week">Week</div><div class="chart-tab" data-period="month">Month</div><div class="chart-tab" data-period="year">Year</div></div></div>
<div class="chart-current" id="historyCurrent"></div>
<div class="hb-card-body" style="padding:.5rem .75rem"><div class="chart-wrap"><canvas id="historyChart"></canvas></div></div>
</div>
<div class="hb-card chart-section">
<div class="hb-card-header"><div class="hb-card-title"><i class="bi bi-plug" style="margin-right:.5rem"></i>Socket Power History</div><div class="chart-tabs" id="socketChartTabs"><div class="chart-tab active" data-period="day">Day</div><div class="chart-tab" data-period="week">Week</div><div class="chart-tab" data-period="month">Month</div><div class="chart-tab" data-period="year">Year</div></div></div>
<div class="chart-current" id="socketCurrent"></div>
<div class="hb-card-body" style="padding:.5rem .75rem"><div class="chart-wrap"><canvas id="socketChart"></canvas></div></div>
</div>
<div class="hb-card chart-section">
<div class="hb-card-header"><div class="hb-card-title"><i class="bi bi-lightning" style="margin-right:.5rem"></i>Other Load</div><div class="chart-tabs" id="otherChartTabs"><div class="chart-tab active" data-period="day">Day</div><div class="chart-tab" data-period="week">Week</div><div class="chart-tab" data-period="month">Month</div><div class="chart-tab" data-period="year">Year</div></div></div>
<div class="chart-current" id="otherCurrent"></div>
<div class="hb-card-body" style="padding:.5rem .75rem"><div class="chart-wrap"><canvas id="otherChart"></canvas></div></div>
</div>
<div class="hb-card">
<div class="hb-card-header"><div class="hb-card-title">Logs</div><button class="btn-hb btn-hb-outline btn-hb-sm" onclick="loadLogs()"><i class="bi bi-arrow-repeat"></i> Refresh</button></div>
<div class="hb-card-body" style="padding:.5rem"><div class="terminal" id="log-container">Loading logs...</div></div>
</div>
</div>
<div class="tab-pane" id="tab-devices">
<div class="page-header"><h1>Devices</h1></div>
<div class="hb-card">
<div class="hb-card-header"><div class="hb-card-title">Sync with Tuya</div><button class="btn-hb btn-hb-primary btn-hb-sm" id="syncBtn" onclick="syncTuya()"><i class="bi bi-arrow-repeat"></i> Sync Devices</button></div>
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
<div class="hb-card-header" onclick="toggleNewAutomation()"><div class="hb-card-title"><i class="bi bi-plus-circle" style="margin-right:.5rem"></i>New Automation</div><span><i class="bi bi-chevron-down toggle-arrow" style="font-size:.85rem;color:var(--muted)"></i><button class="btn-hb btn-hb-primary btn-hb-sm save-btn-h" onclick="event.stopPropagation();saveScene()" style="margin-left:.5rem"><i class="bi bi-save"></i> Save</button></span></div>
<div class="hb-card-body">
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Name</label><input type="text" id="scene-name" class="form-hb" placeholder="e.g. Battery Saver" /></div>
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">IF (all must be true)</label><div id="if-conditions"></div><button class="btn-hb btn-hb-outline btn-hb-sm mt-2" onclick="addCondition()"><i class="bi bi-plus"></i> Add Condition</button></div>
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">THEN (actions)</label><div id="then-actions"></div><button class="btn-hb btn-hb-outline btn-hb-sm mt-2" onclick="addAction()"><i class="bi bi-plus"></i> Add Action</button></div>
</div>
</div>
<div class="hb-card" style="margin-top:1rem">
<div class="hb-card-header"><div class="hb-card-title">Saved Automations</div><span class="badge-hb purple" id="scene-count-badge2">0</span></div>
<div class="hb-card-body" id="scenes-list"><div class="empty-state"><i class="bi bi-diagram-3"></i><p>No automations yet.</p></div></div>
</div>
</div>
<div class="tab-pane" id="tab-settings">
<div class="page-header"><h1>Settings</h1><button class="btn-hb btn-hb-outline btn-hb-sm" onclick="loadPluginConfig()"><i class="bi bi-arrow-clockwise"></i> Refresh</button></div>
<div class="hb-card">
<div class="hb-card-header"><div class="hb-card-title"><i class="bi bi-plug" style="margin-right:.5rem"></i>Inverter</div><button class="btn-hb btn-hb-primary btn-hb-sm" onclick="savePluginConfig()"><i class="bi bi-save"></i> Save</button></div>
<div class="hb-card-body">
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Inverter IP</label><input type="text" id="cfg-inverter-ip" class="form-hb" placeholder="192.168.0.116" /></div>
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Serial Number</label><input type="text" id="cfg-inverter-serial" class="form-hb" placeholder="2317564280" /></div>
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Modbus Port</label><input type="number" id="cfg-inverter-port" class="form-hb" value="8899" /></div>
</div>
</div>
<div class="hb-card" style="margin-top:1rem">
<div class="hb-card-header"><div class="hb-card-title"><i class="bi bi-cloud" style="margin-right:.5rem"></i>Tuya Cloud</div><button class="btn-hb btn-hb-primary btn-hb-sm" onclick="savePluginConfig()"><i class="bi bi-save"></i> Save</button></div>
<div class="hb-card-body">
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Access ID</label><input type="text" id="cfg-tuya-accessId" class="form-hb" placeholder="Enter Tuya Access ID" /></div>
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Access Key</label><input type="password" id="cfg-tuya-accessKey" class="form-hb" placeholder="Enter Tuya Access Key" /></div>
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Country Code</label><input type="number" id="cfg-tuya-countryCode" class="form-hb" value="48" /></div>
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Username / Email</label><input type="text" id="cfg-tuya-username" class="form-hb" placeholder="user@example.com" /></div>
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Password</label><input type="password" id="cfg-tuya-password" class="form-hb" placeholder="&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;" /></div>
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">App Schema</label><select id="cfg-tuya-appSchema" class="form-hb"><option value="tuyaSmart">Tuya Smart</option><option value="smartlife">Smart Life</option></select></div>
</div>
</div>
<div class="hb-card" style="margin-top:1rem">
<div class="hb-card-header"><div class="hb-card-title"><i class="bi bi-globe" style="margin-right:.5rem"></i>Web UI</div><button class="btn-hb btn-hb-primary btn-hb-sm" onclick="savePluginConfig()"><i class="bi bi-save"></i> Save</button></div>
<div class="hb-card-body">
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Web Port</label><input type="number" id="cfg-webPort" class="form-hb" value="8583" /></div>
</div>
</div>
<div class="hb-card" style="margin-top:1rem">
<div class="hb-card-header"><div class="hb-card-title"><i class="bi bi-shield-lock" style="margin-right:.5rem"></i>Security</div><button class="btn-hb btn-hb-primary btn-hb-sm" onclick="changePassword()"><i class="bi bi-key"></i> Update</button></div>
<div class="hb-card-body">
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Current password</label><input type="password" id="cp-current" class="form-hb" autocomplete="current-password" /></div>
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">New password (min. 6 characters)</label><input type="password" id="cp-new" class="form-hb" autocomplete="new-password" /></div>
<div class="mb-3"><label class="text-muted-hb" style="font-size:.8rem">Confirm new password</label><input type="password" id="cp-confirm" class="form-hb" autocomplete="new-password" /></div>
</div>
</div>
<div class="hb-card" style="margin-top:1rem">
<div class="hb-card-header"><div class="hb-card-title"><i class="bi bi-cloud-download" style="margin-right:.5rem"></i>Application Update</div></div>
<div class="hb-card-body">
<div id="update-info" style="font-size:.85rem;color:var(--text-secondary);margin-bottom:.75rem">Loading...</div>
<div style="display:flex;gap:.5rem;flex-wrap:wrap">
<button class="btn-hb btn-hb-outline btn-hb-sm" id="btn-check-update" onclick="checkForUpdates()"><i class="bi bi-arrow-clockwise"></i> Check for Updates</button>
<button class="btn-hb btn-hb-primary btn-hb-sm" id="btn-apply-update" onclick="applyUpdate()" style="display:none"><i class="bi bi-download"></i> Update & Restart</button>
</div>
<div id="update-status" style="margin-top:.75rem;font-size:.8rem;display:none"></div>
</div>
</div>
<div class="hb-card mobile-only" style="margin-top:1rem">
<div class="hb-card-header"><div class="hb-card-title"><i class="bi bi-phone" style="margin-right:.5rem"></i>Session</div></div>
<div class="hb-card-body">
<div style="display:flex;flex-direction:column;gap:.6rem">
<button class="btn-hb btn-hb-outline w-100" onclick="location.reload()"><i class="bi bi-arrow-clockwise"></i> Restart UI</button>
<button class="btn-hb btn-hb-outline w-100" onclick="restartApp()" style="color:var(--primary)"><i class="bi bi-arrow-repeat"></i> Restart App</button>
<button class="btn-hb btn-hb-danger w-100" onclick="logout()"><i class="bi bi-box-arrow-right"></i> Log Out</button>
</div>
</div>
</div>

</div>
<div class="hb-toast" id="toast"><div class="toast-title" id="toastTitle">Success</div><div class="toast-body" id="toastBody">Done.</div></div>
<div class="modal-backdrop" id="restartModal"><div class="modal-box"><h3>Restart now?</h3><p>Settings saved. Restart to apply changes now or later.</p><div class="modal-btns"><button class="btn-hb btn-hb-primary" onclick="restartApp()"><i class="bi bi-arrow-repeat"></i> Restart</button><button class="btn-hb btn-hb-outline" onclick="document.getElementById('restartModal').classList.remove('show')">Cancel</button></div></div></div>
</main>
<script>
let tuyaDevices=[];
document.querySelectorAll('.menu-item').forEach(item=>{
item.addEventListener('click',function(){
const tab=this.dataset.tab;
document.querySelectorAll('.menu-item').forEach(m=>m.classList.remove('active'));
this.classList.add('active');
document.querySelectorAll('.tab-pane').forEach(p=>p.classList.remove('active'));
const pane=document.getElementById('tab-'+tab);
if(pane)pane.classList.add('active');
const titles={status:'Status',devices:'Devices',automations:'Automations',settings:'Settings'};
const h1=pane.querySelector('.page-header h1');
if(h1)h1.textContent=titles[tab]||tab;
if(tab==='status'){loadStatus();loadLogs();loadHistory();loadSocketHistory();loadOtherHistory();}
if(tab==='devices')loadTuyaDevices();
if(tab==='automations'){loadScenes();populateDeviceSelects();}
if(tab==='settings'){loadPluginConfig();loadAppVersion();}
});
});
function showToast(t,b,e){const el=document.getElementById('toast');document.getElementById('toastTitle').textContent=t;document.getElementById('toastBody').textContent=b;el.className='hb-toast show'+(e?' error':'');clearTimeout(el._hide);el._hide=setTimeout(()=>el.classList.remove('show'),4000);}
function handleAuthStatus(r){if(r.status===401){window.location.href='/login';throw new Error('Unauthorized');}return r;}
async function apiGet(p){const r=handleAuthStatus(await fetch(p));if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}
async function apiPost(p,b){const r=handleAuthStatus(await fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}));if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}
async function apiDelete(p){const r=handleAuthStatus(await fetch(p,{method:'DELETE'}));if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}
async function apiPatch(p,b){const r=handleAuthStatus(await fetch(p,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}));if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}
async function loadStatus(){
try{
const d=await apiGet('/api/status');
const on=d.gridPower===true;
document.getElementById('grid-status').textContent=on?'ON':'OFF';
const tg=document.getElementById('tile-grid');
tg.classList.toggle('on',on);tg.classList.toggle('off',!on);
document.getElementById('grid-voltage').textContent=(on&&d.gridVoltage>0)?d.gridVoltage.toFixed(1)+'V':'\\u2014';
document.getElementById('battery-status').textContent=(d.batterySOC||0)+'%';
const bp=d.batteryPower||0;
document.getElementById('battery-power').textContent=(bp>0?'+'+bp+'W (charging)':bp<0?bp+'W (discharging)':'0W');
const pv1=d.pvPower||0;const pv2=d.pvPower2||0;
document.getElementById('pv-status').textContent=(pv1+pv2)?(pv1+pv2)+'W':'0W';
document.getElementById('pv-detail').textContent=pv2>0?'PV1='+pv1+'W PV2='+pv2+'W':'PV='+pv1+'W';
document.getElementById('load-status').textContent=d.loadPower?d.loadPower+'W':'0W';
document.getElementById('clock-tile').textContent=new Date().toLocaleTimeString();
document.getElementById('day-pv-status').textContent=(d.dayPV||0).toFixed(1)+' kWh';
document.getElementById('day-import-status').textContent=(d.dayGridImport||0).toFixed(1)+' kWh';
document.getElementById('day-export-status').textContent=(d.dayGridExport||0).toFixed(1)+' kWh';
document.getElementById('day-load-status').textContent=(d.dayLoadEnergy||0).toFixed(1)+' kWh';
document.getElementById('day-batcharge-status').textContent=(d.dayBatCharge||0).toFixed(1)+' kWh';
document.getElementById('day-batdischarge-status').textContent=(d.dayBatDischarge||0).toFixed(1)+' kWh';
document.getElementById('bat-temp-status').textContent=(d.batteryTemp||0).toFixed(1)+' °C';
document.getElementById('env-temp-status').textContent=(d.envTemp||0).toFixed(1)+' °C';
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
if(r.success)showToast('Success','Device '+(value?'ON':'OFF'));
else{showToast('Error',r.message||'Control failed',true);if(iconEl)iconEl.className=prevClass;}
}catch(e){showToast('Error',e.message,true);if(iconEl)iconEl.className=prevClass;}
finally{if(iconEl)setTimeout(()=>iconEl.classList.remove('pulse'),600);}
}
async function syncTuya(){
const btn=document.getElementById('syncBtn');
btn.disabled=true;btn.innerHTML='<span class="spinner-hb"></span> Syncing...';
try{const d=await apiPost('/api/sync-tuya',{});if(d.success){showToast('Synced',d.count+' devices loaded.');await loadTuyaDevices();}else showToast('Sync error',d.message||'Unknown error',true);}
catch(e){showToast('Sync error',e.message,true);}
finally{btn.disabled=false;btn.innerHTML='<i class="bi bi-arrow-repeat"></i> Sync Devices';}
}
async function loadScenes(){
try{
const scenes=await apiGet('/api/scenes');
document.getElementById('scene-count-badge2').textContent=scenes.length;
document.getElementById('sidebar-scene-count').textContent=scenes.length;
const list=document.getElementById('scenes-list');
if(scenes.length===0){list.innerHTML='<div class="empty-state"><i class="bi bi-diagram-3"></i><p>No automations yet.</p></div>';return;}
list.innerHTML='<div class="automation-grid">'+scenes.map(s=>{
const ifT=(s.if&&s.if.conditions)?s.if.conditions.map(c=>{
if(c.type==='grid')return 'Grid '+(c.value?'ON':'OFF');
if(c.type==='battery')return 'Battery '+(c.operator||'=')+' '+c.value+'%';
return '';
}).join(' AND '):'\\u2014';
const thenT=(s.then&&s.then.actions)?s.then.actions.map(a=>{
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
return '<div class="entity-card automation-card'+(en?' is-active':'')+'">'
+'<div class="automation-card-top"><span class="automation-dot '+(en?'on':'off')+'"></span><span class="automation-name">'+escHtml(s.name)+'</span><span class="badge-hb '+(en?'active':'inactive')+'">'+(en?'Active':'Paused')+'</span></div>'
+'<div class="automation-rule"><b>IF</b> '+escHtml(ifT)+' <b>\\u2192 THEN</b> '+escHtml(thenT)+'</div>'
+'<div class="automation-footer">'+toggleBtn+'<button class="btn-hb btn-hb-danger btn-hb-sm btn-hb-icon" onclick="deleteScene(\\''+escHtml(s.name)+'\\')"><i class="bi bi-trash"></i></button></div>'
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
try{const r=await apiPatch('/api/scenes/'+encodeURIComponent(name),{enabled});if(r.success)showToast(enabled?'Resumed':'Paused','Automation "'+name+'" '+(enabled?'resumed':'paused')+'.');else showToast('Error',r.message||'Toggle failed',true);loadScenes();}
catch(e){showToast('Error',e.message,true);loadScenes();}
}
async function deleteScene(n){
if(!confirm('Delete automation "'+n+'"?'))return;
try{await apiDelete('/api/scenes/'+encodeURIComponent(n));showToast('Deleted','Automation removed.');loadScenes();}
catch(e){showToast('Error',e.message,true);}
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
const c=document.getElementById('if-conditions');
const r=document.createElement('div');r.className='rule-row';
r.innerHTML='<select class="form-hb rule-field condition-type" onchange="updateConditionOptions(this)"><option value="">\\u2014 Source \\u2014</option><option value="grid">City Grid</option><option value="battery">Battery Level</option></select><div class="rule-field condition-operator-col" style="display:none"><select class="form-hb condition-operator"><option value="<">< Less</option><option value=">">> Greater</option><option value="=">= Equal</option></select></div><div class="rule-field condition-value-col" style="display:none"><input type="number" class="form-hb condition-value" placeholder="Value" /></div><div class="rule-remove"><button class="btn-hb btn-hb-danger btn-hb-sm btn-hb-icon" onclick="this.closest(\\'.rule-row\\').remove()"><i class="bi bi-x"></i></button></div>';
c.appendChild(r);
}
function updateConditionOptions(sel){
const r=sel.closest('.rule-row');
const op=r.querySelector('.condition-operator-col');
const vc=r.querySelector('.condition-value-col');
const vi=r.querySelector('.condition-value');
if(sel.value==='grid'){op.style.display='none';vc.style.display='block';vi.outerHTML='<select class="form-hb condition-value"><option value="true">ON</option><option value="false">OFF</option></select>';}
else if(sel.value==='battery'){op.style.display='block';vc.style.display='block';vi.outerHTML='<input type="number" class="form-hb condition-value" placeholder="%" min="0" max="100" />';}
else{op.style.display='none';vc.style.display='none';}
}
function addAction(){
expandNewAutomation();
const c=document.getElementById('then-actions');
const r=document.createElement('div');r.className='rule-row';
const opts=tuyaDevices.map(d=>'<option value="'+escHtml(d.id)+'">'+escHtml(d.name)+'</option>').join('');
r.innerHTML='<select class="form-hb rule-field action-device"><option value="">\\u2014 Device \\u2014</option>'+opts+'</select><select class="form-hb rule-field-sm action-value"><option value="true">ON</option><option value="false">OFF</option></select><input type="number" class="form-hb rule-field-sm action-duration" placeholder="Dur. min" min="0" /><input type="number" class="form-hb rule-field-sm action-interval" placeholder="Int. min" min="0" /><div class="rule-remove"><button class="btn-hb btn-hb-danger btn-hb-sm btn-hb-icon" onclick="this.closest(\\'.rule-row\\').remove()"><i class="bi bi-x"></i></button></div>';
c.appendChild(r);
}
function populateDeviceSelects(){
const sels=document.querySelectorAll('.action-device');
const opts=tuyaDevices.map(d=>'<option value="'+escHtml(d.id)+'">'+escHtml(d.name)+'</option>').join('');
sels.forEach(s=>{const cur=s.value;s.innerHTML='<option value="">\\u2014 Device \\u2014</option>'+opts;if(cur)s.value=cur;});
}
async function saveScene(){
const name=document.getElementById('scene-name').value.trim();
if(!name){showToast('Error','Enter automation name.',true);return;}
const conds=[];
document.querySelectorAll('#if-conditions > .rule-row').forEach(r=>{
const t=r.querySelector('.condition-type').value;
const v=r.querySelector('.condition-value');
const o=r.querySelector('.condition-operator');
if(!t)return;
let val=v?v.value:'';
if(t==='grid')val=val==='true';
else if(t==='battery')val=parseInt(val)||0;
const c={type:t,value:val};
if(o&&o.value)c.operator=o.value;
conds.push(c);
});
if(conds.length===0){showToast('Error','Add at least one condition.',true);return;}
const acts=[];
document.querySelectorAll('#then-actions > .rule-row').forEach(r=>{
const d=r.querySelector('.action-device').value;
const v=r.querySelector('.action-value').value==='true';
const dur=parseInt(r.querySelector('.action-duration').value)||0;
const int=parseInt(r.querySelector('.action-interval').value)||0;
if(d)acts.push({type:'tuya',device:d,value:v,duration:dur,interval:int});
});
if(acts.length===0){showToast('Error','Add at least one action.',true);return;}
try{
await apiPost('/api/scenes',{name,if:{conditions:conds},then:{actions:acts}});
showToast('Saved','Automation "'+name+'" created.');
document.getElementById('scene-name').value='';
document.getElementById('if-conditions').innerHTML='';
document.getElementById('then-actions').innerHTML='';
loadScenes();
}catch(e){showToast('Error',e.message,true);}
}
function escHtml(s){if(!s)return '';const d=document.createElement('div');d.textContent=s;return d.innerHTML;}
async function logout(){try{await apiPost('/api/logout',{});}catch(e){}window.location.href='/login';}
async function restartApp(){try{await apiPost('/api/restart',{});showToast('Restarting','App will restart in a few seconds...');setTimeout(()=>{window.location.reload();},5000);}catch(e){showToast('Error',e.message);}}

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
const labels=d.points.map(p=>{const dt=new Date(p.ts);if(currentPeriod==='day')return dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});if(currentPeriod==='week')return dt.toLocaleDateString([],{weekday:'short',hour:'2-digit',minute:'2-digit'});if(currentPeriod==='month')return dt.toLocaleDateString([],{day:'numeric',hour:'2-digit'});return dt.toLocaleDateString([],{month:'short',day:'numeric'});});
const loadData=d.points.map(p=>p.load);
const batData=d.points.map(p=>p.bat);
const gridData=d.points.map(p=>p.grid);
const ctx=document.getElementById('historyChart');
if(!ctx)return;
if(historyChart)historyChart.destroy();
historyChart=new Chart(ctx,{type:'line',plugins:[lineLabelsPlugin],data:{labels,datasets:[
{label:'Load (W)',data:loadData,_lineLabel:'Load',borderColor:'#3b82f6',backgroundColor:'rgba(59,130,246,0.06)',fill:true,tension:0.3,pointRadius:0,borderWidth:2,order:1,segment:{borderColor:ctx2=>{const gi=gridData[ctx2.p0DataIndex];return gi?'#3b82f6':'#333333';}}},
{label:'Battery (W)',data:batData,_lineLabel:'Battery',borderColor:'#22c55e',fill:false,tension:0.3,pointRadius:0,borderWidth:2,order:2,segment:{borderColor:ctx2=>{const v=batData[ctx2.p0DataIndex];return v>=0?'#22c55e':'#ef4444';}}}
]},options:{responsive:true,maintainAspectRatio:false,animation:{duration:300},interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(28,28,30,0.95)',titleColor:'#f5f5f7',bodyColor:'#f5f5f7',borderColor:'rgba(255,255,255,0.09)',borderWidth:0.5,cornerRadius:10,padding:10,displayColors:true,callbacks:{label:function(ctx2){if(ctx2.dataset.label==='Load (W)')return 'Load: '+ctx2.raw+'W';if(ctx2.dataset.label==='Battery (W)')return 'Battery: '+(ctx2.raw>=0?'+':'')+ctx2.raw+'W';return ctx2.dataset.label+': '+ctx2.raw;},title:function(items){if(!items.length)return '';const idx=items[0].dataIndex;const pt=d.points[idx];const gridTxt=pt?'Grid: '+(pt.grid?'ON':'OFF'):'';return items[0].label+(gridTxt?' | '+gridTxt:'');}}}},scales:{x:{ticks:{color:'#98989f',font:{size:10},maxTicksLimit:currentPeriod==='day'?12:currentPeriod==='week'?14:currentPeriod==='month'?12:12,maxRotation:0},grid:{color:'rgba(255,255,255,0.04)'}},y:{ticks:{color:'#98989f',font:{size:10},callback:v=>v+'W'},grid:{color:'rgba(255,255,255,0.04)'}}}}});
const lp=d.points[d.points.length-1];
renderCurrentValues('historyCurrent',[
{label:'Load',value:lp.load+'W',color:'#3b82f6'},
{label:'Battery',value:(lp.bat>=0?'+':'')+lp.bat+'W',color:lp.bat>=0?'#22c55e':'#ef4444'},
{label:'Grid',value:lp.grid?'ON':'OFF',color:lp.grid?'#22c55e':'#ef4444'},
{label:'PV',value:lp.pv+'W',color:'#f59e0b'}
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
const labels=d.points.map(p=>{const dt=new Date(p.ts);if(socketPeriod==='day')return dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});if(socketPeriod==='week')return dt.toLocaleDateString([],{weekday:'short',hour:'2-digit',minute:'2-digit'});if(socketPeriod==='month')return dt.toLocaleDateString([],{day:'numeric',hour:'2-digit'});return dt.toLocaleDateString([],{month:'short',day:'numeric'});});
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
socketChart=new Chart(ctx,{type:'line',plugins:[lineLabelsPlugin],data:{labels,datasets},options:{responsive:true,maintainAspectRatio:false,animation:{duration:300},interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(28,28,30,0.95)',titleColor:'#f5f5f7',bodyColor:'#f5f5f7',borderColor:'rgba(255,255,255,0.09)',borderWidth:0.5,cornerRadius:10,padding:10,displayColors:true,callbacks:{label:function(ctx2){return ctx2.dataset.label+': '+ctx2.raw+'W';}}}},scales:{x:{ticks:{color:'#98989f',font:{size:10},maxTicksLimit:socketPeriod==='day'?12:socketPeriod==='week'?14:12,maxRotation:0},grid:{color:'rgba(255,255,255,0.04)'}},y:{ticks:{color:'#98989f',font:{size:10},callback:v=>v+'W'},grid:{color:'rgba(255,255,255,0.04)'}}}}});
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
const labels=d.points.map(p=>{const dt=new Date(p.ts);if(otherPeriod==='day')return dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});if(otherPeriod==='week')return dt.toLocaleDateString([],{weekday:'short',hour:'2-digit',minute:'2-digit'});if(otherPeriod==='month')return dt.toLocaleDateString([],{day:'numeric',hour:'2-digit'});return dt.toLocaleDateString([],{month:'short',day:'numeric'});});
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
]},options:{responsive:true,maintainAspectRatio:false,animation:{duration:300},interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(28,28,30,0.95)',titleColor:'#f5f5f7',bodyColor:'#f5f5f7',borderColor:'rgba(255,255,255,0.09)',borderWidth:0.5,cornerRadius:10,padding:10,displayColors:true,callbacks:{label:function(ctx2){return ctx2.dataset.label.split(' (')[0]+': '+ctx2.raw+'W';}}}},scales:{x:{ticks:{color:'#98989f',font:{size:10},maxTicksLimit:otherPeriod==='day'?12:otherPeriod==='week'?14:12,maxRotation:0},grid:{color:'rgba(255,255,255,0.04)'}},y:{ticks:{color:'#98989f',font:{size:10},callback:v=>v+'W'},grid:{color:'rgba(255,255,255,0.04)'}}}}});
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
try{const r=await fetch('/api/change-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword:cur,newPassword:nw})});const d=await r.json();if(d.success){showToast('Success','Password updated.');document.getElementById('cp-current').value='';document.getElementById('cp-new').value='';document.getElementById('cp-confirm').value='';}else showToast('Error',d.message||'Failed.',true);}
catch(e){showToast('Error',e.message,true);}
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
}catch(e){}
}
async function savePluginConfig(){
try{
const cfg={
inverter:{ip:document.getElementById('cfg-inverter-ip').value.trim(),serial:document.getElementById('cfg-inverter-serial').value.trim(),port:parseInt(document.getElementById('cfg-inverter-port').value)||8899},
tuya:{accessId:document.getElementById('cfg-tuya-accessId').value.trim(),accessKey:document.getElementById('cfg-tuya-accessKey').value,countryCode:parseInt(document.getElementById('cfg-tuya-countryCode').value)||48,username:document.getElementById('cfg-tuya-username').value.trim(),password:document.getElementById('cfg-tuya-password').value,appSchema:document.getElementById('cfg-tuya-appSchema').value},
webPort:parseInt(document.getElementById('cfg-webPort').value)||8583
};
const r=await apiPost('/api/plugin-config',{config:cfg});
if(r.success){document.getElementById('restartModal').classList.add('show');}else showToast('Error',r.message||'Save failed',true);
}catch(e){showToast('Error',e.message,true);}
}
// Tile editor
const ALL_TILES=['tile-grid','tile-battery','tile-pv','tile-load','tile-day-pv','tile-day-import','tile-day-export','tile-day-load','tile-day-batcharge','tile-day-batdischarge','tile-battemp','tile-envtemp'];
const TILE_LABELS={};
document.querySelectorAll('.tile[id]').forEach(t=>{const l=t.querySelector('.label');if(l)TILE_LABELS[t.id]=l.textContent;});
function loadTilePrefs(){try{return JSON.parse(localStorage.getItem('tileVis')||'null')||{}}catch{return{}}}
function saveTilePrefs(p){localStorage.setItem('tileVis',JSON.stringify(p));}
function loadTileOrder(){try{const o=JSON.parse(localStorage.getItem('tileOrder')||'null');if(Array.isArray(o)){const ids=ALL_TILES.filter(id=>o.includes(id));ALL_TILES.forEach(id=>{if(!ids.includes(id))ids.push(id);});return ids;}}catch{}return[...ALL_TILES];}
function saveTileOrder(o){localStorage.setItem('tileOrder',JSON.stringify(o));}
function applyTileVisibility(){const p=loadTilePrefs();ALL_TILES.forEach(id=>{const el=document.getElementById(id);if(el)el.style.display=p[id]===false?'none':'';});}
function applyTileOrder(){const order=loadTileOrder();const c=document.getElementById('tilesContainer');order.forEach(id=>{const el=document.getElementById(id);if(el)c.appendChild(el);});}
function moveTile(id,dir){const order=loadTileOrder();const idx=order.indexOf(id);if(idx<0)return;const ni=idx+dir;if(ni<0||ni>=order.length)return;[order[idx],order[ni]]=[order[ni],order[idx]];saveTileOrder(order);applyTileOrder();}
function buildTileEditor(){const p=loadTilePrefs();const order=loadTileOrder();const g=document.getElementById('tileEditGrid');g.innerHTML='';order.forEach(id=>{const lbl=TILE_LABELS[id]||id;const vis=p[id]!==false;const d=document.createElement('label');d.className='tile-edit-item'+(vis?'':' hidden-tile');d.dataset.tile=id;d.innerHTML='<input type="checkbox" '+(vis?'checked':'')+' data-tile="'+id+'">'+lbl+'<div class="tile-edit-arrows"><button type="button" title="Move up" class="tile-arrow-btn" data-dir="-1">▲</button><button type="button" title="Move down" class="tile-arrow-btn" data-dir="1">▼</button></div>';d.querySelector('input').addEventListener('change',function(){const pp=loadTilePrefs();pp[this.dataset.tile]=this.checked;saveTilePrefs(pp);d.classList.toggle('hidden-tile',!this.checked);applyTileVisibility();});d.querySelectorAll('.tile-arrow-btn').forEach(btn=>{btn.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();moveTile(id,parseInt(this.dataset.dir));buildTileEditor();});});g.appendChild(d);});}
// Pull-to-refresh
let _pullStart=0,_pulling=false;
const _pullEl=document.getElementById('pull-indicator');
const _pullIcon=_pullEl?_pullEl.querySelector('i'):null;
const mainEl=document.querySelector('.main');
if(mainEl){mainEl.addEventListener('touchstart',function(e){if(mainEl.scrollTop<=0){_pullStart=e.touches[0].clientY;_pulling=true;}},{passive:true});mainEl.addEventListener('touchmove',function(e){if(!_pulling)return;const dy=e.touches[0].clientY-_pullStart;if(dy>0&&mainEl.scrollTop<=0){const pct=Math.min(dy/100,1);_pullEl.classList.add('show');_pullIcon.style.transform='rotate('+pct*180+'deg)';if(pct>=1){_pullEl.classList.add('pulling');}}},{passive:true});mainEl.addEventListener('touchend',function(){if(!_pulling)return;_pulling=false;if(_pullEl.classList.contains('pulling')){_pullEl.classList.remove('pulling');_pullEl.classList.add('refreshing');_pullIcon.className='bi bi-arrow-clockwise';loadStatus();loadLogs();loadHistory();loadSocketHistory();loadOtherHistory();setTimeout(()=>{_pullEl.classList.remove('show','refreshing');_pullIcon.className='bi bi-arrow-down';},800);}else{_pullEl.classList.remove('show','pulling');}},{passive:true});}

async function loadAppVersion(){try{const r=await fetch('/api/app-version');const d=await r.json();if(d.success){const el=document.getElementById('update-info');if(el){el.innerHTML=d.isGit?'Version <strong>'+d.version+'</strong> ('+d.gitHash+') · Branch: '+d.gitBranch:'Version <strong>'+d.version+'</strong> (not a git repo)';if(!d.isGit)document.getElementById('btn-check-update').style.display='none';}}}catch(e){}}
async function checkForUpdates(){const btn=document.getElementById('btn-check-update');const st=document.getElementById('update-status');btn.disabled=true;btn.innerHTML='<i class="bi bi-hourglass-split"></i> Checking...';try{const r=await fetch('/api/update-check',{method:'POST'});const d=await r.json();if(!d.isGit){st.style.display='block';st.style.color='var(--text-secondary)';st.textContent='Not a git repository. Install via git clone to enable updates.';}else if(d.isUpToDate){st.style.display='block';st.style.color='#22c55e';st.innerHTML='<i class="bi bi-check-circle"></i> Up to date ('+d.local+')';document.getElementById('btn-apply-update').style.display='none';}else{st.style.display='block';st.style.color='#f59e0b';st.innerHTML='<i class="bi bi-arrow-down-circle"></i> '+d.commits.length+' new commit(s):<br>'+d.commits.map(c=>'&nbsp;&nbsp;'+c).join('<br>');document.getElementById('btn-apply-update').style.display='';}}catch(e){st.style.display='block';st.style.color='#ef4444';st.textContent='Error: '+e.message;}btn.disabled=false;btn.innerHTML='<i class="bi bi-arrow-clockwise"></i> Check for Updates';}
async function applyUpdate(){const btn=document.getElementById('btn-apply-update');const st=document.getElementById('update-status');if(!confirm('Update app and restart?'))return;btn.disabled=true;btn.innerHTML='<i class="bi bi-hourglass-split"></i> Updating...';st.style.display='block';st.style.color='#3b82f6';st.textContent='Pulling changes...';try{await fetch('/api/update-apply',{method:'POST'});st.textContent='Updated! Reconnecting...';setTimeout(()=>{let tries=0;const iv=setInterval(async()=>{tries++;try{const r=await fetch('/');if(r.ok){clearInterval(iv);location.reload();}}catch{}if(tries>30){clearInterval(iv);st.textContent='Restart timed out. Refresh the page manually.';}},1500);},3000);}catch(e){st.style.color='#ef4444';st.textContent='Update failed: '+e.message;btn.disabled=false;btn.innerHTML='<i class="bi bi-download"></i> Update & Restart';}}
loadAppVersion();

loadStatus();loadTuyaDevices();loadScenes();loadLogs();loadHistory('day');loadSocketHistory('day');loadOtherHistory('day');
applyTileOrder();buildTileEditor();applyTileVisibility();
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
// MAIN — STARTUP
// ============================================================
async function main() {
  log.info('Energy Controller starting...');

  // Initialize
  await ensureAuth();
  await loadScenes();
  const cfg = await loadConfig();
  const port = cfg.webPort || WEB_PORT_DEFAULT;

  // Start HTTP server
  server.listen(port, '0.0.0.0', () => {
    log.info('Web UI at http://0.0.0.0:' + port);
  });

  // Connect to inverter
  const connected = await connectToInverter();
  if (connected) {
    pollInverter();
    setInterval(() => {
      if (_inverterConsecutiveFails >= 5) {
        // After 5 consecutive failures, reconnect and wait longer
        if (_pollingInverter) return;
        log.info('Inverter: too many failures, reconnecting...');
        connectToInverter().then(() => pollInverter());
      } else {
        pollInverter();
      }
    }, 10000);
    setInterval(saveHistoryPoint, 60000);
  }

  // Initialize Tuya
  await initTuya();
  await saveSocketPoint();

  // Periodic Tuya status polling + socket history
  setInterval(async () => {
    await fetchDeviceStatuses();
    await saveSocketPoint();
  }, 60000);

  // Scene check loop
  setInterval(checkScenes, 10000);

  // Session cleanup
  setInterval(() => {
    const now = Date.now();
    for (const token of Object.keys(sessions)) {
      if (sessions[token] < now) delete sessions[token];
    }
  }, 60 * 60 * 1000);

  log.info('Energy Controller started');
}

main().catch(err => {
  log.error('Fatal: ' + err.message);
  process.exit(1);
});

// Graceful shutdown
const shutdown = async (signal) => {
  log.info(signal + ' received, shutting down...');
  server.close();
  if (inverter) try { await inverter.disconnect(); } catch {}
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
