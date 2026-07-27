const LOG_BUFFER_MAX = 200;
const logBuffer = [];

const log = {
  info: (...a) => {
    const msg = `[${new Date().toISOString()}] INFO: ${a.join(' ')}`;
    console.log(msg);
    logBuffer.push(msg);
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  },
  warn: (...a) => {
    const msg = `[${new Date().toISOString()}] WARN: ${a.join(' ')}`;
    console.log(msg);
    logBuffer.push(msg);
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  },
  error: (...a) => {
    const msg = `[${new Date().toISOString()}] ERROR: ${a.join(' ')}`;
    console.error(msg);
    logBuffer.push(msg);
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  },
  debug: (...a) => {},
};

export { log, logBuffer };
