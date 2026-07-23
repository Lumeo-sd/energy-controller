export function createServerState(ctx) {
  const {
    log, path, fs, exec, __dirname,
    CERT_FILE, KEY_FILE,
    parseCookies, isSessionValid, getSessionCsrf, sendJson,
    matchRoute, parseBody, rateLimit, getClientIp,
  } = ctx;

  function authMiddleware(req, res) {
    if (req.url === '/login' || req.url === '/api/login') return true;
    if (req.method === 'POST' && req.url === '/login') return true;
    if (req.url === '/sw.js' || req.url === '/manifest.json' || req.url === '/healthz') return true;
    if (req.url.startsWith('/icon-')) return true;
    if (req.url.startsWith('/vendor/')) return true;
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

    if (req.url.startsWith('/api/')) {
      sendJson(res, 401, { success: false, message: 'Unauthorized' });
      return false;
    }
    res.writeHead(302, { Location: '/login' });
    res.end();
    return false;
  }

  let _cachedLoginHtml = null;
  function getLoginPage() {
    if (_cachedLoginHtml) return _cachedLoginHtml;
    try { _cachedLoginHtml = fs.readFileSync(path.join(__dirname, 'public', 'login.html'), 'utf8'); } catch { _cachedLoginHtml = '<html><body><h1>Login not found</h1></body></html>'; }
    return _cachedLoginHtml;
  }

  let _cachedWebUI = null;
  function getWebUI() {
    if (_cachedWebUI) return _cachedWebUI;
    try { _cachedWebUI = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8'); } catch { _cachedWebUI = '<html><body><h1>App not found</h1></body></html>'; }
    return _cachedWebUI;
  }

  function createRequestHandler() {
    return async (req, res) => {
      const staticFiles = { '/tokens.css': 'text/css', '/style.css': 'text/css', '/app.js': 'application/javascript', '/login.css': 'text/css', '/login.js': 'application/javascript' };
      if (staticFiles[req.url]) {
        const fpath = path.join(__dirname, 'public', req.url);
        try {
          const data = fs.readFileSync(fpath);
          res.writeHead(200, { 'Content-Type': staticFiles[req.url], 'Cache-Control': 'public, max-age=86400' });
          return res.end(data);
        } catch { /* fall through */ }
      }

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

        if (urlPath.startsWith('/icon-')) {
          const match = urlPath.match(/\/icon-(\d+)\.png/);
          const size = match ? parseInt(match[1]) : 192;
          const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">\n    <rect width="' + size + '" height="' + size + '" rx="' + (size * 0.2) + '" fill="#000"/>\n    <text x="50%" y="55%" text-anchor="middle" dominant-baseline="middle" font-family="system-ui" font-size="' + (size * 0.35) + '" font-weight="bold" fill="#bf5af2">\u26a1</text>\n  </svg>';
          res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
          return res.end(svg);
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

        if (urlPath.startsWith('/vendor/')) {
          const full = path.join(__dirname, 'public', urlPath.slice(1));
          if (full.startsWith(path.join(__dirname, 'public', 'vendor'))) {
            try {
              const data = fs.readFileSync(full);
              const ext = path.extname(full).toLowerCase();
              const mimes = { '.js':'application/javascript','.css':'text/css','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon' };
              res.writeHead(200, { 'Content-Type': mimes[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' });
              res.end(data);
            } catch {
              sendJson(res, 404, { error: 'Not found' });
            }
          } else {
            sendJson(res, 403, { error: 'Forbidden' });
          }
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

  return { authMiddleware, getLoginPage, getWebUI, createRequestHandler, ensureCertificates };
}

