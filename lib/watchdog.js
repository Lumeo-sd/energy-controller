import fs from 'node:fs';
import path from 'node:path';

const WATCHDOG_FILE = path.join(process.cwd(), 'data', 'watchdog.log');
const MAX_LINES = 2000;

let _interval = null;

function _getRssMB() {
  try {
    const raw = fs.readFileSync('/proc/self/status', 'utf8');
    const m = raw.match(/VmRSS:\s+(\d+)/);
    return m ? Math.round(parseInt(m[1]) / 1024) : 0;
  } catch { return 0; }
}

function _append(line) {
  try {
    let lines = [];
    if (fs.existsSync(WATCHDOG_FILE)) {
      lines = fs.readFileSync(WATCHDOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    }
    lines.push(line);
    if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
    fs.writeFileSync(WATCHDOG_FILE, lines.join('\n') + '\n');
  } catch {}
}

export function watchdogStart() {
  _append('START pid=' + process.pid + ' rss=' + _getRssMB() + 'MB');
  _interval = setInterval(() => {
    _append('HEARTBEAT ' + new Date().toISOString() + ' rss=' + _getRssMB() + 'MB');
  }, 5 * 60 * 1000);
}

export function watchdogShutdown(reason) {
  try { if (_interval) clearInterval(_interval); } catch {}
  _append('SHUTDOWN ' + new Date().toISOString() + ' reason=' + reason + ' rss=' + _getRssMB() + 'MB');
}

