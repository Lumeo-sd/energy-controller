import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { log } from './logger.js';

export function createConfig(DATA_DIR, crypto) {
  const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

  async function loadConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const cfg = JSON.parse(await fs.promises.readFile(CONFIG_FILE, 'utf8'));
        if (cfg.tuya && cfg.tuya.password && cfg.tuya.password.includes(':')) {
          cfg.tuya.password = crypto.decryptSecret(cfg.tuya.password);
        }
        return cfg;
      }
    } catch (err) {
      log.error('Failed to load config: ' + err.message);
    }
    return {
      inverter: { ip: '', serial: '', port: 8899, mac: '', autoResolve: false, resolveAfterFails: 10 },
      tuya: { accessId: '', accessKey: '', countryCode: 48, username: '', password: '', appSchema: 'tuyaSmart' },
      webPort: 8583,
      notifications: { notifEnabled: true, ntfyEnabled: true, ntfyNotifEnabled: true, ntfyTopic: '', telegramEnabled: true, telegramNotifEnabled: true, telegramToken: '', telegramChatId: '', lowSocAlert: 20, connTimeout: 10, gridOutageReport: true },
      metricsToken: '',
      tariff: { currency: 'UAH', type: 'daynight', flatRate: 0, dayRate: 0, nightRate: 0, dayStart: '07:00', nightStart: '23:00' },
    };
  }

  async function saveConfig(cfg) {
    try {
      const toSave = JSON.parse(JSON.stringify(cfg));
      if (toSave.tuya && toSave.tuya.password && !toSave.tuya.password.includes(':')) {
        toSave.tuya.password = crypto.encryptSecret(toSave.tuya.password);
      }
      await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(toSave, null, 2), { mode: 0o600 });
    } catch (err) {
      log.error('Failed to save config: ' + err.message);
    }
  }

  async function netbirdExec(args) {
    return new Promise((resolve) => {
      exec('sudo netbird ' + args.join(' '), { timeout: 15000, maxBuffer: 1024 * 64 }, (err, stdout, stderr) => {
        resolve({ stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), err });
      });
    });
  }

  return { loadConfig, saveConfig, netbirdExec };
}
