import dgram from 'node:dgram';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DEVICES_FILE = path.join(REPO_ROOT, 'data', 'devices.json');

const BROADCAST_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();
const PORT = 6667;
const LISTEN_SECONDS = parseInt(process.argv[2], 10) || 30;

function loadKnownDeviceIds() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data', 'devices.json'), 'utf8'));
    return Array.isArray(data) ? data.map(d => d.id).filter(Boolean) : [];
  } catch { return []; }
}

function decrypt6699(buf, rinfo) {
  if (buf.length < 34) return { ok: false, reason: 'too short' };
  if (buf.slice(0, 4).toString('hex') !== '00006699') return { ok: false, reason: 'no 6699 prefix' };

  const unknown = buf.readUInt16BE(4);
  const seqno = buf.readUInt32BE(6);
  const cmd = buf.readUInt32BE(10);
  const payloadLen = buf.readUInt32BE(14);

  const expectedTotal = 18 + payloadLen + 4;
  if (buf.length < expectedTotal) {
    return { ok: false, reason: 'length mismatch: declared=' + expectedTotal + ' actual=' + buf.length };
  }

  const suffix = buf.slice(expectedTotal - 4, expectedTotal);
  if (suffix.toString('hex') !== '00009966') {
    return { ok: false, reason: 'bad suffix: ' + suffix.toString('hex') };
  }

  const iv = buf.slice(18, 30);
  const aad = buf.slice(4, 18);
  const tagStart = expectedTotal - 4 - 16;
  const ciphertext = buf.slice(30, tagStart);
  const tag = buf.slice(tagStart, tagStart + 16);

  try {
    const decipher = crypto.createDecipheriv('aes-128-gcm', BROADCAST_KEY, iv);
    decipher.setAuthTag(tag);
    decipher.setAAD(aad);
    let plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    let str = plaintext.toString('utf8');

    // Strip version header: "3.5" + 12 NUL bytes = 15 bytes, then optional 4-byte retcode
    // Then strip any leading/trailing NUL bytes
    str = str.replace(/^\x00+\s*/, '').replace(/\x00+$/, '');

    // Find JSON boundaries
    const firstBrace = str.indexOf('{');
    const lastBrace = str.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1) {
      return { ok: false, reason: 'no JSON in decrypted: ' + Buffer.from(str).toString('hex').slice(0, 80) };
    }
    str = str.slice(firstBrace, lastBrace + 1);

    const parsed = JSON.parse(str);
    return { ok: true, parsed, cmd, seqno, unknown, rawLen: plaintext.length };
  } catch (err) {
    return { ok: false, reason: 'GCM error: ' + err.message };
  }
}

function main() {
  const knownIds = loadKnownDeviceIds();
  console.log('[..] Known device_ids (' + knownIds.length + '): ' + knownIds.join(', '));
  console.log('[..] Listening UDP 0.0.0.0:' + PORT + ' for ' + LISTEN_SECONDS + 's...\n');

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const results = [];

  socket.on('error', (err) => { console.error('[FATAL] ' + err.message); process.exit(1); });

  socket.on('message', (buf, rinfo) => {
    const result = decrypt6699(buf, rinfo);
    results.push({ ip: rinfo.address, len: buf.length, ...result });

    if (result.ok) {
      const matched = knownIds.includes(result.parsed.gwId);
      console.log('[OK] ' + rinfo.address +
        ' gwId=' + result.parsed.gwId +
        ' ip=' + result.parsed.ip +
        ' ver=' + result.parsed.version +
        ' active=' + result.parsed.active +
        ' cmd=0x' + result.cmd.toString(16) +
        ' -> ' + (matched ? 'MATCH' : 'NEW'));
    } else {
      console.log('[FAIL] ' + rinfo.address + ' (' + buf.length + 'B): ' + result.reason);
    }
  });

  socket.bind(PORT, '0.0.0.0', () => console.log('[ok] Bound'));

  setTimeout(() => {
    socket.close();
    const ok = results.filter(r => r.ok);
    console.log('\n=== SUMMARY ===');
    console.log('Total: ' + results.length + ', OK: ' + ok.length + ', FAIL: ' + (results.length - ok.length));
    if (ok.length > 0) {
      const devs = {};
      for (const r of ok) {
        const id = r.parsed.gwId;
        if (!devs[id]) devs[id] = { gwId: id, ips: [], version: r.parsed.version, productKey: r.parsed.productKey };
        if (!devs[id].ips.includes(r.ip)) devs[id].ips.push(r.ip);
      }
      console.log('\nDiscovered devices:');
      console.table(Object.values(devs));
    }
    process.exit(0);
  }, LISTEN_SECONDS * 1000);
}

main();
