// tuya-diag.js
//
// ОДНОРАЗОВИЙ діагностичний скрипт. НЕ частина сервісу, нікуди не інтегрується.
// Мета: дізнатись category/model/local_key для кожного Tuya-пристрою,
// щоб спланувати Tuya Local (Фаза 0 плану).
//
// Запуск з кореня репозиторію (там, де лежить data/config.json):
//   node scripts/tuya-diag.js
//
// Нічого не пише в config.json/devices.json, тільки читає й друкує.
// ВАЖЛИВО: вивід містить local_key — це секрет, що дає прямий доступ
// до пристрою по LAN. Не комітити вивід, не постити нікуди публічно.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCryptoHelpers } from '../lib/crypto.js';
import { tuyaRequest } from '../lib/tuya-sign.js';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function loadConfigRaw() {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error('Не знайдено ' + CONFIG_FILE + ' — запускай скрипт з кореня репозиторію на Pi');
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

async function getTuyaToken(tc) {
  const endpoints = [
    { path: '/v1.0/iot-03/users/login', body: { username: tc.username, password: crypto.createHash('sha256').update(tc.password || '').digest('hex') } },
    { path: '/v1.0/iot-01/associated-users/actions/authorized-login', body: { country_code: tc.countryCode || 48, username: tc.username, password: crypto.createHash('md5').update(tc.password || '').digest('hex'), schema: tc.appSchema || 'tuyaSmart' } },
  ];
  for (const ep of endpoints) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt));
        const result = await tuyaRequest('POST', ep.path, ep.body, null, tc);
        if (result.success) {
          console.log('[ok] Токен отримано через ' + ep.path);
          return { token: result.result.access_token, uid: result.result.uid };
        }
        if (result.code !== 501) {
          console.error('[fail] ' + ep.path + ': ' + result.msg + ' (code ' + result.code + ')');
          break;
        }
        console.warn('[retry] 501 на ' + ep.path + ', спроба ' + (attempt + 1));
      } catch (err) {
        console.error('[error] ' + ep.path + ': ' + err.message);
        break;
      }
    }
  }
  throw new Error('Не вдалось отримати Tuya токен жодним з ендпоінтів');
}

function guessProtocol(detail) {
  if (!detail.local_key) return 'н/д (немає local_key)';
  return '3.3 (типово для cz/pc; потребує локальної перевірки)';
}

async function main() {
  const cfg = loadConfigRaw();
  const crypto_ = getCryptoHelpers(DATA_DIR);
  const tc = { ...cfg.tuya };
  if (tc.password && tc.password.includes(':')) {
    tc.password = crypto_.decryptSecret(tc.password);
  }
  if (!tc.accessId || !tc.accessKey || !tc.username) {
    throw new Error('tuya.accessId / accessKey / username не заповнені в config.json');
  }

  const { token, uid } = await getTuyaToken(tc);

  console.log('[..] Отримую список пристроїв для uid=' + uid);
  const listResult = await tuyaRequest('GET', '/v1.0/users/' + uid + '/devices', null, token, tc);
  if (!listResult.success || !Array.isArray(listResult.result)) {
    throw new Error('Не вдалось отримати список пристроїв: ' + (listResult.msg || JSON.stringify(listResult)));
  }
  const devices = listResult.result;
  console.log('[ok] Знайдено пристроїв: ' + devices.length);

  const rows = [];
  for (const dev of devices) {
    try {
      const detailResult = await tuyaRequest('GET', '/v1.0/devices/' + dev.id, null, token, tc);
      if (!detailResult.success) {
        rows.push({ id: dev.id, name: dev.name, model: 'ERROR', category: 'ERROR', local_key: '-', uuid: '-', product_name: detailResult.msg || 'запит не вдався', protocol: '-' });
        continue;
      }
      const d = detailResult.result;
      rows.push({
        id: d.id,
        name: d.name || dev.name || '',
        model: d.model || '',
        category: d.category || '',
        local_key: d.local_key || '',
        uuid: d.uuid || '',
        product_name: d.product_name || '',
        protocol: guessProtocol(d),
      });
    } catch (err) {
      rows.push({ id: dev.id, name: dev.name, model: 'ERROR', category: 'ERROR', local_key: '-', uuid: '-', product_name: err.message, protocol: '-' });
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('');
  console.table(rows.map(r => ({
    id: r.id,
    name: r.name,
    model: r.model,
    category: r.category,
    local_key: r.local_key ? r.local_key.slice(0, 6) + '…' + r.local_key.slice(-4) : '-',
    protocol: r.protocol,
  })));

  console.log('\n[!] Повні local_key (для наступного кроку, тримай в секреті):');
  for (const r of rows) {
    console.log('  ' + r.id + ' -> ' + r.local_key);
  }
}

main().catch((err) => {
  console.error('[FATAL] ' + err.message);
  process.exit(1);
});
