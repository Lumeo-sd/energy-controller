// tuya-disc-test.js
//
// Standalone test: listen for Tuya UDP broadcasts for 60 seconds,
// report any packets caught on ports 6666 and 6667.
//
// Run on RPi: cd /opt/energy-controller && /opt/node22/bin/node scripts/tuya-disc-test.js

import dgram from 'node:dgram';
import crypto from 'node:crypto';

const KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();
const PREFIX_LEN = 16;
const packets = { 6666: 0, 6667: 0 };
const devices = new Map();

function decrypt(buf) {
  const d = crypto.createDecipheriv('aes-128-ecb', KEY, null);
  d.setAutoPadding(false);
  return Buffer.concat([d.update(buf.slice(PREFIX_LEN)), d.final()]);
}

function parse(buf, port) {
  try {
    let raw;
    if (port === 6667) raw = decrypt(buf);
    else raw = buf;
    const str = raw.toString('utf8').replace(/\0+$/, '');
    return JSON.parse(str);
  } catch { return null; }
}

function handle(buf, rinfo) {
  packets[rinfo.port] = (packets[rinfo.port] || 0) + 1;
  const json = parse(buf, rinfo.port);
  if (!json || !json.gwId) return;
  const key = json.gwId;
  if (!devices.has(key)) {
    devices.set(key, { gwId: json.gwId, ip: json.ip, active: json.active, port: rinfo.port, raw: json });
    console.log('[HIT] gwId=' + json.gwId + ' ip=' + json.ip + ' port=' + rinfo.port);
  }
}

const sockets = [];

for (const port of [6666, 6667]) {
  const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  s.on('message', (buf, rinfo) => handle(buf, rinfo));
  s.on('error', (e) => console.error('UDP ' + port + ' error: ' + e.message));
  s.bind(port, () => {
    try { s.addMembership('224.0.0.1'); } catch {}
    console.log('Listening on UDP:' + port);
  });
  sockets.push(s);
}

console.log('\nListening for 60 seconds...\n');

setTimeout(() => {
  console.log('\n=== RESULTS ===');
  console.log('Packets: 6666=' + packets[6666] + ' 6667=' + packets[6667]);
  console.log('Devices found: ' + devices.size);
  for (const [id, info] of devices) {
    console.log('  ' + id + ' -> ' + info.ip + ' (port ' + info.port + ', active=' + info.active + ')');
  }
  if (devices.size === 0) {
    console.log('  (none — devices may not be on same LAN, or broadcasts are filtered)');
  }
  for (const s of sockets) try { s.close(); } catch {}
  process.exit(0);
}, 60000);
