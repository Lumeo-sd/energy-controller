import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { log } from './logger.js';

const BROADCAST_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();
const PORT = 6667;
const MAX_PAYLOAD = 512;
const SUFFIX_6699 = '00009966';

function decrypt6699(buf) {
  if (buf.length < 34) return null;

  const payloadLen = buf.readUInt32BE(14);
  if (payloadLen > MAX_PAYLOAD) return null;

  const expectedTotal = 18 + payloadLen + 4;
  if (buf.length < expectedTotal) return null;
  if (buf.slice(expectedTotal - 4, expectedTotal).toString('hex') !== SUFFIX_6699)
    return null;

  const iv = buf.slice(18, 30);
  const aad = buf.slice(4, 18);
  const tagStart = expectedTotal - 4 - 16;
  const ciphertext = buf.slice(30, tagStart);
  const tag = buf.slice(tagStart, tagStart + 16);

  const decipher = crypto.createDecipheriv('aes-128-gcm', BROADCAST_KEY, iv);
  decipher.setAuthTag(tag);
  decipher.setAAD(aad);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const str = plaintext.toString('utf8')
    .replace(/^\x00+\s*/, '')
    .replace(/\x00+$/, '');
  const first = str.indexOf('{');
  const last = str.lastIndexOf('}');
  if (first === -1 || last === -1) return null;
  return JSON.parse(str.slice(first, last + 1));
}

function parsePacket(buf) {
  try {
    if (buf.length < 4) return null;
    const prefix = buf.readUInt32BE(0);
    if (prefix === 0x00006699) {
      return decrypt6699(buf);
    }
    return null;
  } catch {
    return null;
  }
}

function extractInfo(json) {
  if (!json || !json.gwId) return null;
  return {
    gwId: json.gwId,
    ip: json.ip || '',
    active: json.active ?? true,
    version: json.version || '',
    productKey: json.productKey || '',
  };
}

export function startDiscovery(tuyaDevices, onIpChange) {
  const deviceMap = new Map();
  for (const d of tuyaDevices) deviceMap.set(d.id, d);

  function handlePacket(buf, rinfo) {
    try {
      const json = parsePacket(buf);
      const parsed = extractInfo(json);
      if (!parsed || !parsed.gwId) return;

      const dev = deviceMap.get(parsed.gwId);
      if (!dev) return;

      let changed = false;
      if (parsed.ip && parsed.ip !== dev.ip) {
        dev.ip = parsed.ip;
        changed = true;
      }
      if (parsed.version && parsed.version !== dev.protocolVersion) {
        dev.protocolVersion = parsed.version;
        changed = true;
      }
      if (changed) {
        log.info('Discovery: ' + dev.name + ' ip=' + dev.ip + ' ver=' + (dev.protocolVersion || '?'));
        if (onIpChange) onIpChange(parsed.gwId, dev.ip);
      }
    } catch (err) {
      log.warn('Discovery packet error: ' + err.message);
    }
  }

  const sockets = [];

  try {
    const s6667 = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s6667.on('message', (buf, rinfo) => handlePacket(buf, rinfo));
    s6667.on('error', (err) => log.warn('Discovery 6667 error: ' + err.message));
    s6667.bind(PORT, '0.0.0.0', () => {
      try { s6667.setBroadcast(true); } catch {}
      log.info('Discovery listening on UDP:' + PORT);
    });
    sockets.push(s6667);
  } catch (err) {
    log.warn('Failed to bind UDP:' + PORT + ': ' + err.message);
  }

  return {
    stop() { for (const s of sockets) try { s.close(); } catch {} },
    updateDevices(devs) {
      deviceMap.clear();
      for (const d of devs) deviceMap.set(d.id, d);
    },
  };
}

