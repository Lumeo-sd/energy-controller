import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { log } from './logger.js';

export function createNotifications(DATA_DIR, loadConfig) {
  const NOTIF_FILE = path.join(DATA_DIR, 'notifications.json');
  let _notifHistory = [];
  try {
    _notifHistory = JSON.parse(fs.readFileSync(NOTIF_FILE, 'utf8'));
  } catch { _notifHistory = []; }
  let _notifId = _notifHistory.reduce((max, n) => Math.max(max, n.id || 0), 0);

  function saveNotifHistory() {
    try {
      if (_notifHistory.length > 200) _notifHistory = _notifHistory.slice(-200);
      fs.writeFileSync(NOTIF_FILE, JSON.stringify(_notifHistory, null, 2), { mode: 0o600 });
    } catch {}
  }

  function pushNotification(title, message, type) {
    const id = ++_notifId;
    _notifHistory.push({ id, title, message, type: type || 'info', time: Date.now(), dismissed: false });
    if (_notifHistory.length > 200) _notifHistory.shift();
    saveNotifHistory();
    _sendExtNotification(title, message, (type || 'info') === 'error').catch(function noop() {});
  }

  async function sendNotification(title, message, critical) {
    pushNotification(title, message, critical ? 'error' : 'info');
  }

  async function _sendExtNotification(title, message, critical) {
    try {
      const cfg = await loadConfig();
      const n = cfg.notifications || {};
      if (n.criticalEnabled === false && critical) return [];
      if (n.notifEnabled === false) return [];
      const results = [];
      if (n.ntfyTopic && n.ntfyEnabled !== false && n.ntfyNotifEnabled !== false) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const body = JSON.stringify({ topic: n.ntfyTopic, title, message, priority: 4 });
            await new Promise((resolve, reject) => {
              const req2 = https.request({ hostname: 'ntfy.sh', port: 443, path: '/', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 25000 }, res2 => { res2.on('data', () => {}); res2.on('end', resolve); });
              req2.on('error', e => reject(new Error('ntfy: ' + (e.code || e.message || typeof e))));
              req2.on('timeout', () => { req2.destroy(); reject(new Error('ntfy timeout')); });
              req2.write(body);
              req2.end();
            });
            results.push('ntfy: OK');
            break;
          } catch (e) {
            if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue; }
            results.push('ntfy: ' + e.message);
          }
        }
      }
      if (n.telegramToken && n.telegramChatId && n.telegramEnabled !== false && n.telegramNotifEnabled !== false) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const body = JSON.stringify({ chat_id: n.telegramChatId, text: '*' + title + '*\n' + message, parse_mode: 'Markdown' });
            await new Promise((resolve, reject) => {
              const url = new URL('https://api.telegram.org/bot' + n.telegramToken + '/sendMessage');
              const req2 = https.request({ hostname: url.hostname, port: 443, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 25000 }, res2 => { res2.on('data', () => {}); res2.on('end', resolve); });
              req2.on('error', e => reject(new Error('tg: ' + (e.code || e.message || typeof e))));
              req2.on('timeout', () => { req2.destroy(); reject(new Error('telegram timeout')); });
              req2.write(body);
              req2.end();
            });
            results.push('telegram: OK');
            break;
          } catch (e) {
            if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue; }
            results.push('telegram: ' + e.message);
          }
        }
      }
      if (results.length) log.info('Notification (' + title + '): ' + results.join(', '));
      return results;
    } catch (e) { return ['error: ' + e.message]; }
  }

  return { pushNotification, sendNotification, _sendExtNotification, _notifHistory, _notifId, saveNotifHistory };
}

