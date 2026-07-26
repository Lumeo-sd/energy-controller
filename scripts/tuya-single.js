import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCryptoHelpers } from '../lib/crypto.js';
import { tuyaRequest } from '../lib/tuya-sign.js';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const cfg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8'));
const crypto_ = getCryptoHelpers(DATA_DIR);
const tc = { ...cfg.tuya };
if (tc.password && tc.password.includes(':')) tc.password = crypto_.decryptSecret(tc.password);

let token, uid;
for (const ep of [
  { path: '/v1.0/iot-01/associated-users/actions/authorized-login', body: { country_code: 48, username: tc.username, password: crypto.createHash('md5').update(tc.password || '').digest('hex'), schema: tc.appSchema || 'tuyaSmart' } },
]) {
  const r = await tuyaRequest('POST', ep.path, ep.body, null, tc);
  if (r.success) { token = r.result.access_token; uid = r.result.uid; }
}
if (!token) { console.error('No token'); process.exit(1); }
console.log('uid=' + uid);

const devices = [
  'bf683bcbbe0e6d52787fqx',
  'bfcf02093e786591a3gwdk',
  'bf36c7deaafdb99125apic',
  'bfb89556605acd43efklvb',
];

for (const id of devices) {
  try {
    const r = await tuyaRequest('GET', '/v1.0/devices/' + id, null, token, tc);
    if (r.success) {
      const d = r.result;
      console.log(JSON.stringify({ id: d.id, name: d.name, model: d.model, category: d.category, local_key: d.local_key || '(empty)', uuid: d.uuid, product_name: d.product_name, ip: d.ip, online: d.online }, null, 2));
    } else {
      console.error(id + ': ' + r.msg + ' (code ' + r.code + ')');
    }
  } catch (e) { console.error(id + ': ' + e.message); }
  await new Promise(r => setTimeout(r, 500));
}
