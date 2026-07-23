import fs from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { exec } from 'node:child_process';
import { log } from './logger.js';
import { SolarmanV5 } from './solarman.js';
import { tuyaRequest } from './tuya-sign.js';

export function createAppState(DATA_DIR, loadConfig, saveConfig, decryptSecret, pushNotification) {
  const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
  const DAILY_FILE = path.join(DATA_DIR, 'daily.json');
  const SCENES_FILE = path.join(DATA_DIR, 'scenes.json');

  // ============================================================
  // INVERTER DATA
  // ============================================================
  let inverter = null;
  let _pollingInverter = false;
  let _inverterConsecutiveFails = 0;
  let _lastResolveAttempt = 0;
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
      if (inv.autoResolve && !inv.mac) {
        try {
          const arp = fs.readFileSync("/proc/net/arp", "utf8");
          const lines = arp.split("\n").slice(1);
          for (const l of lines) {
            const parts = l.trim().split(/\s+/);
            if (parts.length >= 4 && parts[0] === inv.ip && normalizeMAC(parts[3]) !== '000000000000') {
              const mac = parts[3];
              const cfg2 = await loadConfig();
              cfg2.inverter = cfg2.inverter || {};
              cfg2.inverter.mac = mac;
              await saveConfig(cfg2);
              log.info("Inverter MAC captured: " + mac);
              break;
            }
          }
        } catch (e) { log.warn("MAC capture failed: " + e.message); }
      }
      log.info('Connected to inverter at ' + inv.ip);
      return true;
    } catch (err) {
      if (err.message && err.message.includes("EHOSTUNREACH") && inv.autoResolve && inv.mac && _inverterConsecutiveFails >= (inv.resolveAfterFails || 10)) {
        const nowish = Date.now();
        if (nowish - _lastResolveAttempt < 60000) {
          log.warn("Inverter unreachable — last resolve was " + ((nowish - _lastResolveAttempt) / 1000).toFixed(0) + "s ago, skipping");
          log.error('Failed to connect to inverter: ' + err.message);
          return false;
        }
        _lastResolveAttempt = nowish;
        pushNotification("Inverter", "Connection lost — scanning network for new IP...", "warn");
        log.info("Inverter unreachable, attempting MAC resolution...");
        const resolved = await resolveInverterIP(inv.mac, inv.ip);
        if (resolved && resolved !== inv.ip) {
          const cfg2 = await loadConfig();
          cfg2.inverter.ip = resolved;
          await saveConfig(cfg2);
          log.info("Inverter IP updated: " + inv.ip + " -> " + resolved);
          pushNotification("Inverter", "IP changed to " + resolved + " — reconnected", "info");
          return await connectToInverter();
        } else if (resolved === inv.ip) {
          log.info("Inverter found at " + resolved + " — waiting for next poll cycle");
        } else {
          pushNotification("Inverter", "Auto-resolve failed — MAC not found on network", "error");
        }
      }
      log.error('Failed to connect to inverter: ' + err.message);
      return false;
    }
  }

  function normalizeMAC(m) {
    if (!m) return '';
    return m.toLowerCase().replace(/[^a-f0-9]/g, '');
  }

  async function resolveInverterIP(mac, fallbackIp) {
    try {
      const arp = fs.readFileSync("/proc/net/arp", "utf8");
      const lines = arp.split("\n").slice(1);
      for (const l of lines) {
        const parts = l.trim().split(/\s+/);
        if (parts.length >= 4 && normalizeMAC(parts[3]) === normalizeMAC(mac)) {
          const candidate = parts[0];
          try {
            const sock = new net.Socket();
            const ok = await new Promise(r => {
              sock.connect(8899, candidate, () => { sock.destroy(); r(true); });
              sock.on('error', () => { sock.destroy(); r(false); });
              setTimeout(() => { sock.destroy(); r(false); }, 2000);
            });
            if (ok) { log.info("Inverter found in ARP: " + candidate); return candidate; }
            log.warn("Inverter ARP stale for " + candidate + " — flushing");
            try { exec("ip neigh del " + candidate + " dev wlan0"); } catch {}
          } catch {}
        }
      }
      const prefix = fallbackIp.substring(0, fallbackIp.lastIndexOf(".") + 1);
      log.info("Scanning subnet " + prefix + "0/24 for " + mac + "...");

      const batchSize = 20;
      const allIps = [];
      for (let i = 1; i <= 254; i += batchSize) {
        const batch = [];
        for (let j = 0; j < batchSize && i + j <= 254; j++) {
          batch.push(prefix + (i + j));
        }
        await Promise.all(batch.map(ip => new Promise(r => {
          const p = exec("ping -c 1 -W 1 " + ip, { timeout: 2000 }, () => r());
          p.on("error", () => r());
          setTimeout(() => r(), 2000);
        })));
      }
      const arp2 = fs.readFileSync("/proc/net/arp", "utf8");
      for (const l of arp2.split("\n").slice(1)) {
        const parts = l.trim().split(/\s+/);
        if (parts.length >= 4 && normalizeMAC(parts[3]) === normalizeMAC(mac)) {
          const candidate = parts[0];
          try {
            const sock = new net.Socket();
            const ok = await new Promise(r => {
              sock.connect(8899, candidate, () => { sock.destroy(); r(true); });
              sock.on('error', () => { sock.destroy(); r(false); });
              setTimeout(() => { sock.destroy(); r(false); }, 2000);
            });
            if (ok) { log.info("Inverter found after scan: " + candidate); return candidate; }
            log.warn("Inverter ARP stale for " + candidate + " after ping sweep");
            try { exec("ip neigh del " + candidate + " dev wlan0"); } catch {}
          } catch {}
        }
      }
      log.warn("Inverter MAC " + mac + " not found on network");
      return null;
    } catch (e) {
      log.error("resolveInverterIP failed: " + e.message);
      return null;
    }
  }

  let costState = { dateKey: '', dayKwh: 0, nightKwh: 0, lastImport: 0 };
  let dailyRecords = [];
  let demoGridImport = 2.0;

  async function loadDailyRecords() {
    try {
      const data = JSON.parse(await fs.promises.readFile(DAILY_FILE, 'utf8'));
      dailyRecords.length = 0;
      dailyRecords.push(...data);
    } catch { dailyRecords.length = 0; }
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
          tuyaDevices.length = 0;
          tuyaDevices.push(...data);
          log.info('Loaded ' + data.length + ' devices from disk');
          return true;
        }
      }
    } catch (err) { log.error('Failed to load devices from disk: ' + err.message); }
    return false;
  }

  async function getTuyaTokenFunc() {
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
    await getTuyaTokenFunc();
    return tuyaToken;
  }

  async function syncDeviceNamesFromCloud() {
    const cfg = await loadConfig();
    const tc = cfg.tuya || {};
    try {
      if (!tuyaToken || !tuyaUid) await getTuyaTokenFunc();
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
      if (!tuyaToken || !tuyaUid) await getTuyaTokenFunc();
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
        const data = JSON.parse(await fs.promises.readFile(SCENES_FILE, 'utf8'));
        scenes.length = 0;
        scenes.push(...data);
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

  function deviceName(id) { const d = tuyaDevices.find(x => x.id === id); return d ? d.name : id; }

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
                  log.info('Scene "' + scene.name + '" reverted ' + deviceName(action.device) + ' after ' + action.duration + 'min');
                  pushNotification('Automation "' + scene.name + '"', deviceName(action.device) + ' = ' + (!action.value ? 'ON' : 'OFF') + ' (timeout ' + action.duration + 'min)', 'info');
                  pushSceneTrace(scene.name, 'revert (timeout)', action.device + '=' + (!action.value ? 'ON' : 'OFF'));
                } catch (err) { log.error('Scene revert failed: ' + err.message); pushNotification('Automation "' + scene.name + '"', 'Revert failed: ' + err.message, 'error'); pushSceneTrace(scene.name, 'revert:error', err.message); }
                state.active = false;
                state.revertedAt = now;
              }
            } else {
              const elapsedSinceRevert = now - state.revertedAt;
              const intervalMs = hasInterval ? action.interval * 60000 : 0;
              if (elapsedSinceRevert >= intervalMs) {
                try {
                  await controlDevice(action.device, action.value);
                  log.info('Scene "' + scene.name + '" applied ' + deviceName(action.device) + ' = ' + (action.value ? 'ON' : 'OFF'));
                  pushNotification('Automation "' + scene.name + '"', deviceName(action.device) + ' = ' + (action.value ? 'ON' : 'OFF'), 'info');
                  pushSceneTrace(scene.name, 'apply', action.device + '=' + (action.value ? 'ON' : 'OFF'));
                } catch (err) { log.error('Scene action failed: ' + err.message); pushNotification('Automation "' + scene.name + '"', 'Failed: ' + err.message, 'error'); pushSceneTrace(scene.name, 'apply:error', err.message); }
                state.active = true;
                state.appliedAt = now;
              }
            }
          } else {
            if (state.active) {
                try {
                  await controlDevice(action.device, !action.value);
                  log.info('Scene "' + scene.name + '" reverted (conditions changed)');
                  pushNotification('Automation "' + scene.name + '"', deviceName(action.device) + ' = ' + (!action.value ? 'ON' : 'OFF') + ' (conditions changed)', 'info');
                  pushSceneTrace(scene.name, 'revert (conditions)', action.device + '=' + (!action.value ? 'ON' : 'OFF'));
                } catch (err) { log.error('Scene revert failed: ' + err.message); pushNotification('Automation "' + scene.name + '"', 'Revert failed: ' + err.message, 'error'); pushSceneTrace(scene.name, 'revert:error', err.message); }
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

  function resetInverterConnection() {
    if (inverter) try { inverter.disconnect(); } catch {}
    inverter = null;
  }

  return {
    inverterData,
    pollInverter,
    connectToInverter,
    injectDemoData,
    loadDailyRecords,
    finalizeDay,
    costState,
    dailyRecords,
    tuyaDevices,
    controlDevice,
    fetchDeviceStatuses,
    syncDeviceNamesFromCloud,
    initTuya,
    loadDevicesFromDisk,
    scenes,
    loadScenes,
    saveScenes,
    checkScenes,
    sceneTraces,
    deviceName,
    resolveInverterIP,
    saveDevices,
    resetInverterConnection,
    _pollingInverter,
    _inverterConsecutiveFails,
    pushSceneTrace,
  };
}

