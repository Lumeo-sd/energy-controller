import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.js';

export function getCryptoHelpers(DATA_DIR) {
  const SECRET_FILE = path.join(DATA_DIR, 'secret.key');

  function getMasterKey() {
    try {
      if (fs.existsSync(SECRET_FILE)) {
        return fs.readFileSync(SECRET_FILE, 'utf8').trim();
      }
      const key = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(SECRET_FILE, key, { mode: 0o600 });
      log.info('Generated master encryption key');
      return key;
    } catch (err) {
      log.error('Failed to load/generate master key: ' + err.message);
      return crypto.randomBytes(32).toString('hex');
    }
  }

  const MASTER_KEY = getMasterKey();

  function encryptSecret(plaintext) {
    if (!plaintext) return '';
    try {
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(MASTER_KEY, 'hex'), iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const authTag = cipher.getAuthTag();
      return iv.toString('hex') + ':' + ciphertext.toString('hex') + ':' + authTag.toString('hex');
    } catch (err) {
      log.error('Encryption failed: ' + err.message);
      return plaintext;
    }
  }

  function decryptSecret(ciphertext) {
    if (!ciphertext || !ciphertext.includes(':')) return ciphertext;
    try {
      const [ivHex, ctHex, tagHex] = ciphertext.split(':');
      const iv = Buffer.from(ivHex, 'hex');
      const ct = Buffer.from(ctHex, 'hex');
      const tag = Buffer.from(tagHex, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(MASTER_KEY, 'hex'), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch (err) {
      log.error('Decryption failed: ' + err.message);
      return ciphertext;
    }
  }

  return { MASTER_KEY, encryptSecret, decryptSecret };
}
