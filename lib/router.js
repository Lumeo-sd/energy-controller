function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    const MAX = 1024 * 1024;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX) {
        req.destroy();
        return reject(new Error('Request body too large'));
      }
      body += chunk;
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const str = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(str),
    'Cache-Control': 'no-store',
  });
  res.end(str);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
  res.end(html);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function setCookie(res, name, value, maxAge, req) {
  const existing = res.getHeader('Set-Cookie') || [];
  const cookies = Array.isArray(existing) ? existing : [existing];
  const secure = req && (req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https');
  cookies.push(`${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
  res.setHeader('Set-Cookie', cookies);
}

function clearCookie(res, name, req) {
  setCookie(res, name, '', 0, req);
}

// Route table
const routes = [];

function route(method, path, handler) {
  routes.push({ method, path, handler });
}

function matchRoute(method, urlPath) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const routeParts = r.path.split('/');
    const urlParts = urlPath.split('/');
    if (routeParts.length !== urlParts.length) continue;
    const params = {};
    let match = true;
    for (let i = 0; i < routeParts.length; i++) {
      if (routeParts[i].startsWith(':')) {
        params[routeParts[i].slice(1)] = decodeURIComponent(urlParts[i]);
      } else if (routeParts[i] !== urlParts[i]) {
        match = false;
        break;
      }
    }
    if (match) return { handler: r.handler, params };
  }
  return null;
}

export { parseBody, sendJson, sendHtml, sendText, setCookie, clearCookie, route, matchRoute, routes };
