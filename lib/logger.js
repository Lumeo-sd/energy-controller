const LOG_BUFFER_MAX = 200;
const logBuffer = [];

const LOG_LEVEL = (process.env.LOG_LEVEL || "debug").toLowerCase();
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function shouldLog(level) {
  const lvl = LEVELS[level] !== undefined ? LEVELS[level] : 0;
  const cfg = LEVELS[LOG_LEVEL] !== undefined ? LEVELS[LOG_LEVEL] : 1;
  return lvl >= cfg;
}

const log = {
  info: (...a) => {
    if (!shouldLog("info")) return;
    const msg = `[${new Date().toISOString()}] INFO: ${a.join(" ")}`;
    console.log(msg);
    logBuffer.push(msg);
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  },
  warn: (...a) => {
    if (!shouldLog("warn")) return;
    const msg = `[${new Date().toISOString()}] WARN: ${a.join(" ")}`;
    console.log(msg);
    logBuffer.push(msg);
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  },
  error: (...a) => {
    if (!shouldLog("error")) return;
    const msg = `[${new Date().toISOString()}] ERROR: ${a.join(" ")}`;
    console.error(msg);
    logBuffer.push(msg);
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  },
  debug: (...a) => {
    if (!shouldLog("debug")) return;
    const msg = `[${new Date().toISOString()}] DEBUG: ${a.join(" ")}`;
    console.log(msg);
    logBuffer.push(msg);
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  },
  event: (obj) => {
    if (!shouldLog("debug")) return;
    try {
      const line = JSON.stringify(obj, (k, v) => Buffer.isBuffer(v) ? v.toString("hex") : v);
      console.log(line);
      logBuffer.push(line);
      if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ERROR: log.event serialization failed: ${err.message}`);
    }
  },
};

export { log, logBuffer };
