import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { log } from './logger.js';

export function createAuth(DATA_DIR, config) {
  const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
  const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

  const loginAttempts = {};
  const MAX_LOGIN_ATTEMPTS = 5;
  const LOGIN_WINDOW = 60 * 1000;
  let sessions = {};
  const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;

  async function loadSessions() {
    try {
      const raw = await fs.promises.readFile(SESSIONS_FILE, 'utf8');
      const saved = JSON.parse(raw);
      const now = Date.now();
      for (const [token, s] of Object.entries(saved)) {
        if (s.exp && s.exp > now && s.csrf) sessions[token] = s;
      }
      log.info('Sessions loaded: ' + Object.keys(sessions).length + ' active');
    } catch {}
  }

  let _saveSessionsTimer = null;
  function saveSessions() {
    if (_saveSessionsTimer) return;
    _saveSessionsTimer = setTimeout(async () => {
      _saveSessionsTimer = null;
      try {
        const now = Date.now();
        const active = {};
        for (const [token, s] of Object.entries(sessions)) {
          if (s.exp && s.exp > now) active[token] = s;
        }
        await fs.promises.writeFile(SESSIONS_FILE, JSON.stringify(active, null, 2), { mode: 0o600 });
      } catch {}
    }, 5000);
  }

  function hashPassword(password, salt) {
    salt = salt || crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return { salt, hash };
  }

  function verifyPassword(password, salt, hash) {
    try {
      const testHash = crypto.scryptSync(password, salt, 64).toString('hex');
      return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(testHash, 'hex'));
    } catch { return false; }
  }

  async function ensureAuth() {
    try {
      if (!fs.existsSync(AUTH_FILE)) {
        const password = crypto.randomBytes(9).toString('base64url');
        const { salt, hash } = hashPassword(password);
        await fs.promises.writeFile(AUTH_FILE, JSON.stringify({ username: 'admin', salt, hash, mustChangePassword: true }, null, 2), { mode: 0o600 });
        log.info('Auth file created');
        console.log('');
        console.log('\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
        console.log('\u2551  \ud83d\udd10 Initial admin password: ' + password.padEnd(32) + '\u2551');
        console.log('\u2551  Please change it after first login.         \u2551');
        console.log('\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d');
        console.log('');
      }
    } catch (err) {
      log.error('Failed to initialize auth: ' + err.message);
    }
  }

  async function ensureMetricsToken() {
    try {
      const cfg = await config.loadConfig();
      if (!cfg.metricsToken) {
        cfg.metricsToken = crypto.randomBytes(16).toString('base64url');
        await config.saveConfig(cfg);
        log.info('Metrics token generated (see Settings > Integrations, or GET /api/plugin-config)');
      }
    } catch (err) {
      log.error('Failed to initialize metrics token: ' + err.message);
    }
  }

  async function loadAuthFile() {
    try {
      return JSON.parse(await fs.promises.readFile(AUTH_FILE, 'utf8'));
    } catch {
      return { username: 'admin', salt: '', hash: '' };
    }
  }

  function createSession() {
    const token = crypto.randomBytes(32).toString('hex');
    const csrf = crypto.randomBytes(16).toString('hex');
    sessions[token] = { exp: Date.now() + SESSION_TTL, csrf };
    saveSessions();
    return { token, csrf };
  }

  function getSessionCsrf(token) {
    const s = sessions[token];
    return s ? s.csrf : null;
  }

  function isSessionValid(token) {
    const s = sessions[token];
    if (!s) return false;
    if (Date.now() > s.exp) { delete sessions[token]; return false; }
    s.exp = Date.now() + SESSION_TTL;
    return true;
  }

  function destroySession(token) { delete sessions[token]; saveSessions(); }

  function parseCookies(req) {
    const header = req.headers.cookie;
    const cookies = {};
    if (!header) return cookies;
    header.split(';').forEach(pair => {
      const idx = pair.indexOf('=');
      if (idx < 0) return;
      cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
    });
    return cookies;
  }

  async function performLogin(username, password) {
    const ip = 'login';
    const now = Date.now();
    if (loginAttempts[ip] && loginAttempts[ip].count >= MAX_LOGIN_ATTEMPTS && now - loginAttempts[ip].windowStart < LOGIN_WINDOW) {
      return { success: false, message: 'Too many attempts. Please wait a minute.' };
    }
    const auth0 = await loadAuthFile();
    if (username === auth0.username && verifyPassword(password, auth0.salt, auth0.hash)) {
      loginAttempts[ip] = undefined;
      const { token, csrf } = createSession();
      return { success: true, csrfToken: csrf, mustChangePassword: !!auth0.mustChangePassword, token };
    }
    if (!loginAttempts[ip] || now - loginAttempts[ip].windowStart > LOGIN_WINDOW) {
      loginAttempts[ip] = { count: 1, windowStart: now };
    } else {
      loginAttempts[ip].count++;
    }
    return { success: false, message: 'Invalid login or password' };
  }

  function clearSessions() { sessions = {}; saveSessions(); }

  return {
    loadSessions, saveSessions, hashPassword, verifyPassword, ensureAuth, ensureMetricsToken,
    loadAuthFile, createSession, getSessionCsrf, isSessionValid, destroySession, parseCookies,
    performLogin, loginAttempts, sessions, clearSessions,
  };
}

