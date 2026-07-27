import dgram from 'node:dgram';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DEVICES_FILE = path.join(REPO_ROOT, 'data', 'devices.json');

const LISTEN_SECONDS = parseInt(process.argv[2], 10) || 30;
const PORT = 6667;

const BROADCAST_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();

const PREFIX_MAGIC = Buffer.from([0x00, 0x00, 0x55, 0xaa]);
const SUFFIX_MAGIC = Buffer.from([0x00, 0x00, 0xaa, 0x55]);

function loadKnownDeviceIds() {
  try {
    if (!fs.existsSync(DEVICES_FILE)) {
      console.warn('[warn] ' + DEVICES_FILE + ' not found');
      return [];
    }
    const data = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
    if (!Array.isArray(data)) return [];
    return data.map(d => d.id).filter(Boolean);
  } catch (err) {
    console.warn('[warn] Failed to read devices.json: ' + err.message);
    return [];
  }
}

function tryDecrypt(payloadBuf) {
  for (const autoPad of [true, false]) {
    try {
      const decipher = crypto.createDecipheriv('aes-128-ecb', BROADCAST_KEY, null);
      decipher.setAutoPadding(autoPad);
      let out = Buffer.concat([decipher.update(payloadBuf), decipher.final()]);
      let str = out.toString('utf8');
      const lastBrace = str.lastIndexOf('}');
      if (lastBrace !== -1) str = str.slice(0, lastBrace + 1);
      const firstBrace = str.indexOf('{');
      if (firstBrace > 0) str = str.slice(firstBrace);
      const parsed = JSON.parse(str);
      return { ok: true, parsed, autoPad };
    } catch {}
  }
  return { ok: false };
}

function handlePacket(buf, rinfo) {
  const hex = buf.toString('hex');
  console.log('\n--- Packet from ' + rinfo.address + ':' + rinfo.port + ' (' + buf.length + ' bytes) ---');
  console.log('raw hex (first 64 bytes): ' + hex.slice(0, 128));

  const prefixIdx = buf.indexOf(PREFIX_MAGIC);
  const suffixIdx = buf.lastIndexOf(SUFFIX_MAGIC);

  if (prefixIdx === -1 || suffixIdx === -1 || suffixIdx <= prefixIdx) {
    console.log('[!] Magic bytes 000055AA/0000AA55 NOT found');
    return;
  }
  if (prefixIdx !== 0) {
    console.log('[!] Prefix 000055AA found with offset ' + prefixIdx + ' bytes (expected 0)');
  } else {
    console.log('[ok] Prefix 000055AA at offset 0');
  }

  const header = buf.slice(prefixIdx, prefixIdx + 16);
  const seq = header.readUInt32BE(4);
  const cmd = header.readUInt32BE(8);
  const declaredLen = header.readUInt32BE(12);
  console.log('header: seq=' + seq + ' cmd=0x' + cmd.toString(16) + ' declaredLen=' + declaredLen);

  const payloadStart = prefixIdx + 16;
  const payloadEnd = suffixIdx - 4;
  if (payloadEnd <= payloadStart) {
    console.log('[!] Empty payload');
    return;
  }
  const payload = buf.slice(payloadStart, payloadEnd);

  const result = tryDecrypt(payload);
  if (!result.ok) {
    console.log('[!] Failed to decrypt');
    console.log('    payload hex: ' + payload.toString('hex'));
    return;
  }

  const p = result.parsed;
  console.log('[ok] Decrypted (autoPadding=' + result.autoPad + '): ' + JSON.stringify(p));

  const knownIds = handlePacket._knownIds || [];
  const matched = knownIds.includes(p.gwId);
  console.log('gwId=' + p.gwId + ' ip=' + p.ip + ' version=' + p.version + ' active=' + p.active +
    ' -> ' + (matched ? 'MATCH in devices.json' : 'NOT in devices.json'));
}

function main() {
  const knownIds = loadKnownDeviceIds();
  handlePacket._knownIds = knownIds;
  console.log('[..] Known device_ids (' + knownIds.length + '): ' + knownIds.join(', '));
  console.log('[..] Listening UDP 0.0.0.0:' + PORT + ' for ' + LISTEN_SECONDS + 's...\n');

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const seen = [];

  socket.on('error', (err) => {
    console.error('[FATAL] Socket error: ' + err.message);
    process.exit(1);
  });

  socket.on('message', (buf, rinfo) => {
    seen.push({ ip: rinfo.address, len: buf.length });
    handlePacket(buf, rinfo);
  });

  socket.bind(PORT, '0.0.0.0', () => {
    console.log('[ok] Bound to 0.0.0.0:' + PORT);
  });

  setTimeout(() => {
    socket.close();
    console.log('\n=== SUMMARY ===');
    console.log('Total packets: ' + seen.length);
    const byIp = {};
    for (const s of seen) byIp[s.ip] = (byIp[s.ip] || 0) + 1;
    console.table(Object.entries(byIp).map(([ip, count]) => ({ ip, count })));
    process.exit(0);
  }, LISTEN_SECONDS * 1000);
}

main();
