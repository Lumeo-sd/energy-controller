import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.js';

export function createRrd(DATA_DIR) {
  const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
  const SOCKETS_FILE = path.join(DATA_DIR, 'sockets.json');

  const RRD_POWER = { '1m': [], '15m': [], '1h': [] };
  const RRD_SOCKET = { '1m': [], '15m': [], '1h': [] };
  const RRD_PENDING = [];
  const RRD_SOCKET_PENDING = [];
  const RRD_SIZE = { '1m': 1440, '15m': 672, '1h': 8760 };
  const RRD_INTERVAL = { '1m': 60000, '15m': 900000, '1h': 3600000 };
  let lastRrdFlush = 0;
  const RRD_FLUSH_MS = 300000;

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
      const interval = newestTs - oldestTs < 2 * maxSize * 60000 ? 1 : 0;
      const slot = interval > 0 ? Math.floor((entry.ts - oldestTs) / 60000) : -1;
      if (slot >= 0 && slot < maxSize && entry.ts - buf[slot].ts < 120000) {
        buf[slot] = entry;
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

  async function rrdInit() {
    let migrated = false;
    for (const level of ['1m', '15m', '1h']) {
      try { RRD_POWER[level] = JSON.parse(await fs.promises.readFile(DATA_DIR + '/history_' + level + '.json', 'utf8')); } catch { RRD_POWER[level] = []; }
      try { RRD_SOCKET[level] = JSON.parse(await fs.promises.readFile(DATA_DIR + '/sockets_' + level + '.json', 'utf8')); } catch { RRD_SOCKET[level] = []; }
    }
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
    if (migrated) {
      for (const level of ['1m', '15m', '1h']) {
        await fs.promises.writeFile(DATA_DIR + '/history_' + level + '.json', JSON.stringify(RRD_POWER[level]), { mode: 0o600 });
        await fs.promises.writeFile(DATA_DIR + '/sockets_' + level + '.json', JSON.stringify(RRD_SOCKET[level]), { mode: 0o600 });
      }
    }
    if (RRD_SOCKET['1m'].length > 0 && RRD_SOCKET['15m'].length === 0) {
      rrdSocketMergeM15();
      rrdSocketMergeM1h();
      for (const level of ['15m', '1h']) {
        await fs.promises.writeFile(DATA_DIR + '/sockets_' + level + '.json', JSON.stringify(RRD_SOCKET[level]), { mode: 0o600 });
      }
    }
  }

  async function rrdFlush() {
    const now = Date.now();
    if (now - lastRrdFlush < RRD_FLUSH_MS) return;
    lastRrdFlush = now;
    try {
      const m1Merged = rrdMerge1m(RRD_PENDING);
      for (const p of m1Merged) rrdPush(RRD_POWER['1m'], p, RRD_SIZE['1m']);
      RRD_PENDING.length = 0;

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

      rrdMergeM15();
      rrdMergeM1h();
      rrdSocketMergeM15();
      rrdSocketMergeM1h();

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
    return '1m';
  }

  return {
    RRD_POWER, RRD_SOCKET, RRD_PENDING, RRD_SOCKET_PENDING,
    RRD_FLUSH_MS, RRD_INTERVAL, RRD_SIZE,
    rrdInit, rrdFlush, rrdGetPower, rrdGetSocket, rrdPickLevel,
    rrdMergeM15, rrdMergeM1h,
  };
}
