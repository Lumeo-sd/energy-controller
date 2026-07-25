import crypto from 'node:crypto';
import net from 'node:net';
import { log } from './logger.js';

const PREFIX_6699 = Buffer.from([0x00, 0x00, 0x66, 0x99]);
const SUFFIX_6699 = Buffer.from([0x00, 0x00, 0x99, 0x66]);
const PROTOCOL_35_HEADER = Buffer.concat([Buffer.from('3.5'), Buffer.alloc(12)]);
const PORT = 6668;
const TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 10000;
const MAX_RETRIES = 3;

const CMD = {
  SESS_START: 0x03,
  SESS_RESP: 0x04,
  SESS_FINISH: 0x05,
  HEARTBEAT: 0x09,
  DP_QUERY_NEW: 0x10,
  CONTROL_NEW: 0x0D,
};

function buildFrame(seqno, cmd, plaintext, key) {
  const iv = crypto.randomBytes(12);
  const length = 12 + plaintext.length + 16;

  const header = Buffer.alloc(18);
  header.writeUInt32BE(0x00006699, 0);
  header.writeUInt16BE(0, 4);
  header.writeUInt32BE(seqno, 6);
  header.writeUInt32BE(cmd, 10);
  header.writeUInt32BE(length, 14);

  const aad = header.subarray(4, 18);

  const cipher = crypto.createCipheriv('aes-128-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([header, iv, ciphertext, tag, SUFFIX_6699]);
}

function parseFrame(data, key) {
  if (data.length < 22) return null;
  if (data.subarray(0, 4).compare(PREFIX_6699) !== 0) return null;

  const length = data.readUInt32BE(14);
  const expectedTotal = 18 + length + 4;
  if (data.length < expectedTotal) return null;
  if (data.subarray(expectedTotal - 4, expectedTotal).compare(SUFFIX_6699) !== 0) return null;

  const iv = data.subarray(18, 30);
  const tagStart = expectedTotal - 4 - 16;
  const ciphertext = data.subarray(30, tagStart);
  const tag = data.subarray(tagStart, tagStart + 16);
  const aad = data.subarray(4, 18);

  const decipher = crypto.createDecipheriv('aes-128-gcm', key, iv);
  decipher.setAuthTag(tag);
  decipher.setAAD(aad);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  const seqno = data.readUInt32BE(6);
  const cmd = data.readUInt32BE(10);
  const retcode = plaintext.readUInt32BE(0);

  return { seqno, cmd, retcode, payload: plaintext.subarray(4) };
}

function recvExact(sock, n, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (sock._rxBuf && sock._rxBuf.length >= n) {
      const result = Buffer.alloc(n);
      sock._rxBuf.copy(result, 0, 0, n);
      sock._rxBuf = sock._rxBuf.length > n ? Buffer.from(sock._rxBuf.subarray(n)) : null;
      resolve(result);
      return;
    }

    const buf = Buffer.alloc(n);
    let offset = 0;
    if (sock._rxBuf && sock._rxBuf.length > 0) {
      const toCopy = Math.min(sock._rxBuf.length, n);
      sock._rxBuf.copy(buf, 0, 0, toCopy);
      offset = toCopy;
      sock._rxBuf = sock._rxBuf.length > n ? Buffer.from(sock._rxBuf.subarray(n)) : null;
      if (offset === n) { resolve(buf); return; }
    }

    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.removeListener('error', onErr);
      sock.removeListener('close', onClose);
      sock.removeListener('end', onEnd);
    };
    const onData = (chunk) => {
      const needed = n - offset;
      const toCopy = Math.min(chunk.length, needed);
      chunk.copy(buf, offset, 0, toCopy);
      offset += toCopy;
      if (chunk.length > toCopy) {
        const excess = Buffer.from(chunk.subarray(toCopy));
        sock._rxBuf = sock._rxBuf ? Buffer.concat([sock._rxBuf, excess]) : excess;
      }
      if (offset === n) { cleanup(); resolve(buf); }
    };
    const onErr = (err) => { cleanup(); reject(err); };
    const onClose = () => { cleanup(); reject(new Error('Connection closed')); };
    const onEnd = () => { cleanup(); reject(new Error('Connection ended')); };
    sock.on('data', onData);
    sock.on('error', onErr);
    sock.on('close', onClose);
    sock.on('end', onEnd);
    if (timeoutMs > 0) {
      timer = setTimeout(() => { cleanup(); reject(new Error('Receive timeout')); }, timeoutMs);
    }
  });
}

async function recvFrame(sock, key, timeoutMs = TIMEOUT_MS) {
  const header = await recvExact(sock, 18, timeoutMs);
  const length = header.readUInt32BE(14);
  const bodyLen = length + 4;
  const body = await recvExact(sock, bodyLen, timeoutMs);
  return parseFrame(Buffer.concat([header, body]), key);
}

async function handshake(sock, localKey) {
  const clientNonce = crypto.randomBytes(16);

  const frame1 = buildFrame(1, CMD.SESS_START, clientNonce, localKey);
  sock.write(frame1);

  const resp = await recvFrame(sock, localKey);
  if (resp.cmd !== CMD.SESS_RESP) {
    throw new Error('Expected SESS_RESP, got cmd=0x' + resp.cmd.toString(16));
  }

  const deviceNonce = resp.payload.subarray(0, 16);
  const receivedHmac = resp.payload.subarray(16, 48);

  const expectedHmac = crypto.createHmac('sha256', localKey).update(clientNonce).digest();
  if (!receivedHmac.equals(expectedHmac)) {
    throw new Error('HMAC verification failed in handshake step 2');
  }

  const sendHmac = crypto.createHmac('sha256', localKey).update(deviceNonce).digest();
  const frame3 = buildFrame(2, CMD.SESS_FINISH, sendHmac, localKey);
  sock.write(frame3);

  const tmp = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) tmp[i] = deviceNonce[i] ^ clientNonce[i];

  const cipher = crypto.createCipheriv('aes-128-gcm', localKey, clientNonce.subarray(0, 12));
  const ct = cipher.update(tmp);
  cipher.final();
  const tag = cipher.getAuthTag();

  const sessionKey = Buffer.from(ct);

  if (sessionKey[0] === 0x00) {
    throw new Error('Session key starts with 0x00, retry needed');
  }

  log.info('Handshake OK, session key: ' + sessionKey.toString('hex').slice(0, 16) + '...');
  return sessionKey;
}

const deviceInstances = new Map();

export function getLocalDevice(device) {
  if (!device.ip || !device.localKey) return null;

  const cached = deviceInstances.get(device.id);
  if (cached) return cached;

  const keyBuffer = Buffer.from(device.localKey);
  if (keyBuffer.length !== 16) return null;

  let sock = null;
  let sessionKey = null;
  let seqno = 0;
  let heartbeatTimer = null;
  let connected = false;
  let busy = false;

  function nextSeq() { return ++seqno; }

  function disconnect() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (sock) { try { sock.destroy(); } catch {} }
    sock = null;
    sessionKey = null;
    connected = false;
    busy = false;
  }

  async function connect() {
    if (sock && connected) return;
    disconnect();

    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: device.ip, port: PORT }, async () => {
        sock = s;
        connected = true;
        try {
          sessionKey = await handshake(s, keyBuffer);
          seqno = 2;
          s.setTimeout(0);
          heartbeatTimer = setInterval(() => {
            if (!connected || !sock) return;
            try {
              const hb = buildFrame(nextSeq(), CMD.HEARTBEAT, Buffer.alloc(0), sessionKey);
              sock.write(hb);
            } catch { disconnect(); }
          }, HEARTBEAT_MS);
          resolve();
        } catch (err) {
          s.destroy();
          sock = null;
          connected = false;
          reject(err);
        }
      });
      s.setTimeout(TIMEOUT_MS);
      s.on('timeout', () => { s.destroy(); sock = null; connected = false; reject(new Error('TCP connect timeout')); });
      s.on('error', (err) => { sock = null; connected = false; reject(err); });
    });
  }

  async function sendCommand(cmd, payload, prependHeader = false) {
    if (!connected) await connect();
    let plaintext = payload;
    if (prependHeader) {
      plaintext = Buffer.concat([PROTOCOL_35_HEADER, payload]);
    }
    const frame = buildFrame(nextSeq(), cmd, plaintext, sessionKey);
    sock.write(frame);
    return recvFrame(sock, sessionKey);
  }

  const instance = {
    async queryAll() {
      await connect();
      const resp = await sendCommand(CMD.DP_QUERY_NEW, Buffer.from('{}'));
      if (resp.retcode !== 0) throw new Error('Query failed retcode=' + resp.retcode);
      let p = resp.payload;
      if (p.length > 15 && p.subarray(0, 3).toString() === '3.5') p = p.subarray(15);
      const s = p.toString('utf8').replace(/\x00+$/, '');
      const first = s.indexOf('{');
      const last = s.lastIndexOf('}');
      if (first === -1 || last === -1) throw new Error('Invalid JSON in response');
      return JSON.parse(s.slice(first, last + 1));
    },

    async setDP(dpId, value) {
      await connect();
      const body = JSON.stringify({
        devId: device.id,
        uid: device.id,
        t: Math.floor(Date.now() / 1000),
        dps: { [dpId]: value },
      });
      const resp = await sendCommand(CMD.CONTROL_NEW, Buffer.from(body), true);
      if (resp.retcode !== 0) throw new Error('Set DP failed retcode=' + resp.retcode);
      return true;
    },

    async withLock(fn) {
      while (busy) await new Promise(r => setTimeout(r, 50));
      busy = true;
      try { return await fn(); }
      finally { busy = false; }
    },

    connect,
    disconnect,
    isConnected: () => connected,
  };

  deviceInstances.set(device.id, instance);
  return instance;
}

export function removeLocalDevice(deviceId) {
  const inst = deviceInstances.get(deviceId);
  if (inst) { inst.disconnect(); deviceInstances.delete(deviceId); }
}
