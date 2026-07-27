import crypto from 'node:crypto';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = '/opt/energy-controller/data';
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const SECRET_KEY = fs.readFileSync(path.join(DATA_DIR, 'secret.key'), 'utf8').trim();

function decryptSecret(ct) {
  if (!ct || !ct.includes(':')) return ct;
  const [ivH, ctH, tagH] = ct.split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(SECRET_KEY, 'hex'), Buffer.from(ivH, 'hex'));
  d.setAuthTag(Buffer.from(tagH, 'hex'));
  return Buffer.concat([d.update(Buffer.from(ctH, 'hex')), d.final()]).toString('utf8');
}

function tuyaSign(method, urlPath, bodyStr, token, accessId, accessKey) {
  const t = Date.now().toString();
  const nonce = 'req_' + t;
  const contentSHA256 = crypto.createHash('sha256').update(bodyStr || '').digest('hex');
  const headers = 'client_id:' + accessId + '\n';
  const stringToSign = [method, contentSHA256, headers, urlPath].join('\n');
  const signString = [accessId, token || '', t, nonce, stringToSign].join('');
  const sign = crypto.createHmac('sha256', accessKey).update(signString).digest('hex').toUpperCase();
  return { sign, t, nonce };
}

function tuyaRequest(method, urlPath, body, token, cfg) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const { sign, t, nonce } = tuyaSign(method, urlPath, bodyStr, token, cfg.accessId, cfg.accessKey);
    const headers = { 'client_id': cfg.accessId, 'sign': sign, 'sign_method': 'HMAC-SHA256', 't': t, 'nonce': nonce, 'Signature-Headers': 'client_id' };
    if (token) headers['access_token'] = token;
    if (bodyStr) headers['Content-Type'] = 'application/json';
    const apiBase = cfg.apiBase || 'https://openapi.tuyaeu.com';
    const url = new URL(apiBase + urlPath);
    const req = https.request({ hostname: url.hostname, port: 443, path: url.pathname, method, headers, timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Bad JSON: ' + data.slice(0, 300))); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).tuya;
  const password = decryptSecret(cfg.password || '');

  console.log('=== Getting token ===');
  const result = await tuyaRequest('POST', '/v1.0/iot-01/associated-users/actions/authorized-login',
    { country_code: cfg.countryCode || 48, username: cfg.username, password: crypto.createHash('md5').update(password).digest('hex'), schema: cfg.appSchema || 'tuyaSmart' }, null, cfg);
  if (!result.success) { console.error('Token failed:', result); return; }
  const token = result.result.access_token;
  console.log('Token: ' + token.slice(0, 20) + '...');

  console.log('\n=== Trying multiple endpoints ===');

  // 1. List devices
  console.log('\n1. GET /v1.0/devices (list)');
  const r1 = await tuyaRequest('GET', '/v1.0/devices?device_ids=bf683bcbbe0e6d52787fqx,bfb89556605acd43efklvb,bf36c7deaafdb99125apic,bfcf02093e786591a3gwdk', null, token, cfg);
  console.log('   success=' + r1.success + ' code=' + r1.code + ' msg=' + (r1.msg || ''));
  if (r1.result) console.log('   result: ' + JSON.stringify(r1.result).slice(0, 500));

  // 2. Try device debug info
  console.log('\n2. GET /v1.0/devices/bf683bcbbe0e6d52787fqx (detail)');
  const r2 = await tuyaRequest('GET', '/v1.0/devices/bf683bcbbe0e6d52787fqx', null, token, cfg);
  console.log('   success=' + r2.success + ' code=' + r2.code + ' msg=' + (r2.msg || ''));
  if (r2.result) console.log('   local_key=' + (r2.result.local_key || 'N/A') + ' model=' + r2.result.model);

  // 3. Try device status
  console.log('\n3. GET /v1.0/devices/bf683bcbbe0e6d52787fqx/status');
  const r3 = await tuyaRequest('GET', '/v1.0/devices/bf683bcbbe0e6d52787fqx/status', null, token, cfg);
  console.log('   success=' + r3.success + ' code=' + r3.code + ' msg=' + (r3.msg || ''));
  if (r3.result) console.log('   status: ' + JSON.stringify(r3.result).slice(0, 300));

  // 4. Try sending a command to test
  console.log('\n4. POST command test (switch_1 = false)');
  const r4 = await tuyaRequest('POST', '/v1.0/devices/bf683bcbbe0e6d52787fqx/commands', { commands: [{ code: 'switch_1', value: false }] }, token, cfg);
  console.log('   success=' + r4.success + ' code=' + r4.code + ' msg=' + (r4.msg || ''));
}

main().catch(e => console.error('FATAL:', e.message));

