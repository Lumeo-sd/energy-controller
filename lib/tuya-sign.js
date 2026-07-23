import crypto from 'node:crypto';
import https from 'node:https';

function tuyaSign(method, path, bodyStr, token, accessId, accessKey) {
  const t = Date.now().toString();
  const nonce = 'req_' + t;
  const contentSHA256 = crypto.createHash('sha256').update(bodyStr || '').digest('hex');
  const headers = 'client_id:' + accessId + '\n';
  const stringToSign = [method, contentSHA256, headers, path].join('\n');
  const signString = [accessId, token || '', t, nonce, stringToSign].join('');
  const sign = crypto.createHmac('sha256', accessKey).update(signString).digest('hex').toUpperCase();
  return { sign, t, nonce, contentSHA256 };
}

function tuyaRequest(method, urlPath, body, token, cfg) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const { sign, t, nonce } = tuyaSign(method, urlPath, bodyStr, token, cfg.accessId, cfg.accessKey);
    const headers = {
      'client_id': cfg.accessId,
      'sign': sign,
      'sign_method': 'HMAC-SHA256',
      't': t,
      'nonce': nonce,
      'Signature-Headers': 'client_id',
    };
    if (token) headers['access_token'] = token;
    if (bodyStr) headers['Content-Type'] = 'application/json';

    const tuyaApiBase = (cfg.tuya && cfg.tuya.apiBase) || 'https://openapi.tuyaeu.com';
    const url = new URL(tuyaApiBase + urlPath);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: method,
      headers: headers,
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON from Tuya: ' + data.substring(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Tuya request timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

export { tuyaSign, tuyaRequest };
