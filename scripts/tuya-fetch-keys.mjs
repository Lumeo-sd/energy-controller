import crypto from 'node:crypto';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = '/opt/energy-controller/data';
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const DEVICES_PATH = path.join(DATA_DIR, 'devices.json');
const SECRET_KEY = fs.readFileSync(path.join(DATA_DIR, 'secret.key'), 'utf8').trim();

function decryptSecret(ciphertext) {
  if (!ciphertext || !ciphertext.includes(':')) return ciphertext;
  const [ivHex, ctHex, tagHex] = ciphertext.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(SECRET_KEY, 'hex'), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
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
    const apiBase = cfg.apiBase || 'https://openapi.tuyaeu.com';
    const url = new URL(apiBase + urlPath);
    const options = { hostname: url.hostname, port: 443, path: url.pathname, method, headers, timeout: 15000 };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Bad JSON: ' + data.slice(0, 200))); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function getToken(cfg) {
  const password = decryptSecret(cfg.password || '');
  const endpoints = [
    { path: '/v1.0/iot-01/associated-users/actions/authorized-login',
      body: { country_code: cfg.countryCode || 48, username: cfg.username, password: crypto.createHash('md5').update(password).digest('hex'), schema: cfg.appSchema || 'tuyaSmart' } },
  ];
  for (const ep of endpoints) {
    const result = await tuyaRequest('POST', ep.path, ep.body, null, cfg);
    if (result.success) {
      console.log('Token obtained via ' + ep.path);
      return result.result.access_token;
    }
    console.log('Failed ' + ep.path + ': ' + result.msg + ' (code: ' + result.code + ')');
  }
  throw new Error('Failed to get token');
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).tuya;
  const devices = JSON.parse(fs.readFileSync(DEVICES_PATH, 'utf8'));

  console.log('Getting token...');
  const token = await getToken(cfg);

  let anyNew = false;
  for (const dev of devices) {
    console.log('\nFetching: ' + dev.name + ' (' + dev.id.slice(-6) + ')...');
    try {
      const result = await tuyaRequest('GET', '/v1.0/devices/' + dev.id, null, token, cfg);
      if (result.success && result.result) {
        const info = result.result;
        console.log('  category=' + info.category + ' model=' + info.model);
        if (info.local_key) {
          dev.localKey = info.local_key;
          anyNew = true;
          console.log('  local_key: ' + info.local_key + '  <<< SAVED');
        } else {
          console.log('  local_key: N/A (not available)');
        }
        if (info.name) dev.name = info.name;
      } else {
        console.log('  ERROR: ' + (result.msg || 'unknown') + ' (code: ' + result.code + ')');
      }
    } catch (err) {
      console.log('  ERROR: ' + err.message);
    }
  }

  if (anyNew) {
    fs.writeFileSync(DEVICES_PATH, JSON.stringify(devices, null, 2));
    console.log('\n=== devices.json updated ===');
  } else {
    console.log('\n=== No new local_keys found ===');
  }
  devices.forEach(d => console.log(d.id.slice(-6) + ' localKey=' + (d.localKey || 'NONE')));
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });

