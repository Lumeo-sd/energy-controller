export function createServerState(ctx) {
  const {
    log, path, fs, exec, __dirname,
    CERT_FILE, KEY_FILE,
    parseCookies, isSessionValid, getSessionCsrf, sendJson,
    matchRoute, parseBody, rateLimit, getClientIp,
  } = ctx;

  function authMiddleware(req, res) {
    if (req.url === '/api/login') return true;
    if (req.url.startsWith('/healthz')) return true;
    if (req.url.startsWith('/api/metrics')) return true;

    const cookies = parseCookies(req);
    const token = cookies['ecm_session'];
    if (token && isSessionValid(token)) {
      if (['POST', 'PATCH', 'DELETE'].includes(req.method) && req.url.startsWith('/api/')) {
        const csrf = getSessionCsrf(token);
        const header = req.headers['x-csrf-token'];
        if (!header || header !== csrf) {
          sendJson(res, 403, { success: false, message: 'CSRF token invalid' });
          return false;
        }
      }
      return true;
    }

    sendJson(res, 401, { success: false, message: 'Unauthorized' });
    return false;
  }

  function createRequestHandler() {
    return async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const urlPath = url.pathname;

        if (!authMiddleware(req, res)) return;

        if (urlPath.startsWith('/api/')) {
          const ip = getClientIp(req);
          if (!rateLimit(ip)) {
            sendJson(res, 429, { success: false, message: 'Rate limit exceeded. Please slow down.' });
            return;
          }
        }

        const matched = matchRoute(req.method, urlPath);
        if (matched) {
          req.params = matched.params;
          req.body = {};
          if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
            req.body = await parseBody(req);
          }
          await matched.handler(req, res);
          return;
        }

        sendJson(res, 404, { error: 'Not found' });
      } catch (err) {
        log.error('Request error: ' + err.message);
        sendJson(res, 500, { error: err.message });
      }
    };
  }

  async function ensureCertificates() {
    try {
      if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
        return {
          cert: await fs.promises.readFile(CERT_FILE),
          key: await fs.promises.readFile(KEY_FILE),
        };
      }
      const cmd = `openssl req -x509 -newkey rsa:2048 -keyout "${KEY_FILE}" -out "${CERT_FILE}" -days 3650 -nodes -subj "/CN=Energy Controller" 2>/dev/null`;
      await new Promise((resolve, reject) => {
        exec(cmd, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      await fs.promises.chmod(KEY_FILE, 0o600);
      await fs.promises.chmod(CERT_FILE, 0o600);
      log.info('Self-signed TLS certificate generated');
      return {
        cert: await fs.promises.readFile(CERT_FILE),
        key: await fs.promises.readFile(KEY_FILE),
      };
    } catch (err) {
      log.error('Failed to generate TLS certificate: ' + err.message);
      return null;
    }
  }

  return { authMiddleware, createRequestHandler, ensureCertificates };
}

