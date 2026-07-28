import crypto from "node:crypto";
import net from "node:net";
import { log } from "./logger.js";

const PREFIX_6699 = Buffer.from([0x00, 0x00, 0x66, 0x99]);
const SUFFIX_6699 = Buffer.from([0x00, 0x00, 0x99, 0x66]);
const PROTOCOL_35_HEADER = Buffer.concat([Buffer.from("3.5"), Buffer.alloc(12)]);
const PORT = 6668;
const TIMEOUT_MS = 4000;
const QUERY_RETRIES = 3;
const QUERY_RETRY_DELAY_MS = 1000;
const CONTROL_RETRIES = 3;
const VERIFY_RETRIES = 2;

const CMD = {
  SESS_START: 0x03,
  SESS_RESP: 0x04,
  SESS_FINISH: 0x05,
  HEARTBEAT: 0x09,
  DP_QUERY_NEW: 0x10,
  CONTROL: 0x07,
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

  const cipher = crypto.createCipheriv("aes-128-gcm", key, iv);
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

  const decipher = crypto.createDecipheriv("aes-128-gcm", key, iv);
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
      sock.removeListener("data", onData);
      sock.removeListener("error", onErr);
      sock.removeListener("close", onClose);
      sock.removeListener("end", onEnd);
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
    const onClose = () => { cleanup(); reject(new Error("Connection closed")); };
    const onEnd = () => { cleanup(); reject(new Error("Connection ended")); };
    sock.on("data", onData);
    sock.on("error", onErr);
    sock.on("close", onClose);
    sock.on("end", onEnd);
    if (timeoutMs > 0) {
      timer = setTimeout(() => { cleanup(); reject(new Error("Receive timeout")); }, timeoutMs);
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
  const t0 = Date.now();
  const clientNonce = crypto.randomBytes(16);

  const frame1 = buildFrame(1, CMD.SESS_START, clientNonce, localKey);
  sock.write(frame1);

  const resp = await recvFrame(sock, localKey);
  if (resp.cmd !== CMD.SESS_RESP) {
    throw new Error("Expected SESS_RESP, got cmd=0x" + resp.cmd.toString(16));
  }

  const deviceNonce = resp.payload.subarray(0, 16);
  const receivedHmac = resp.payload.subarray(16, 48);

  const expectedHmac = crypto.createHmac("sha256", localKey).update(clientNonce).digest();
  if (!receivedHmac.equals(expectedHmac)) {
    throw new Error("HMAC verification failed in handshake step 2");
  }

  const sendHmac = crypto.createHmac("sha256", localKey).update(deviceNonce).digest();
  const frame3 = buildFrame(2, CMD.SESS_FINISH, sendHmac, localKey);
  sock.write(frame3);

  const tmp = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) tmp[i] = deviceNonce[i] ^ clientNonce[i];

  const cipher = crypto.createCipheriv("aes-128-gcm", localKey, clientNonce.subarray(0, 12));
  const ct = cipher.update(tmp);
  cipher.final();
  const tag = cipher.getAuthTag();

  const sessionKey = Buffer.from(ct);

  log.debug(`Handshake OK (${Date.now() - t0}ms)`);
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
  let connected = false;
  let _connecting = null;
  let _cmdChain = Promise.resolve();

  function nextSeq() { return ++seqno; }

  function disconnect(reason) {
    if (sock) {
      log.debug(`disconnect ${device.id}${reason ? " (" + reason + ")" : ""}`);
      try { sock.destroy(); } catch {}
    }
    sock = null;
    sessionKey = null;
    connected = false;
  }

  async function connect() {
    if (connected && sock) return;
    if (_connecting) return _connecting;
    disconnect();
    _connecting = doConnect().finally(() => { _connecting = null; });
    return _connecting;
  }

  function doConnect() {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      log.debug(`connect ${device.id} (${device.ip}):${PORT}...`);
      const s = net.createConnection({ host: device.ip, port: PORT }, async () => {
        sock = s;
        connected = true;
        try {
          const t1 = Date.now();
          sessionKey = await handshake(s, keyBuffer);
          log.event({ type: "tuya_connect", deviceId: device.id, deviceName: device.name, ip: device.ip, event: "connected", tcpMs: t1 - t0, handshakeMs: Date.now() - t1, success: true });
          seqno = 2;
          s.setTimeout(0);
          resolve();
        } catch (err) {
          s.destroy();
          sock = null;
          connected = false;
          log.event({ type: "tuya_connect", deviceId: device.id, deviceName: device.name, ip: device.ip, event: "handshake_fail", tcpMs: Date.now() - t0, error: err.message, success: false });
          reject(err);
        }
      });
      s.setTimeout(TIMEOUT_MS);
      s.on("timeout", () => {
        s.destroy(); sock = null; connected = false;
        log.event({ type: "tuya_connect", deviceId: device.id, deviceName: device.name, ip: device.ip, event: "timeout", elapsedMs: Date.now() - t0, success: false });
        reject(new Error("TCP connect timeout"));
      });
      s.on("error", (err) => {
        sock = null; connected = false;
        log.event({ type: "tuya_connect", deviceId: device.id, deviceName: device.name, ip: device.ip, event: "error", elapsedMs: Date.now() - t0, error: err.message, success: false });
        reject(err);
      });
    });
  }

  async function sendCommand(cmd, payload, prependHeader = false) {
    await connect();
    let plaintext = payload;
    if (prependHeader) {
      plaintext = Buffer.concat([PROTOCOL_35_HEADER, payload]);
    }
    const t0_ = Date.now();
    const frame = buildFrame(nextSeq(), cmd, plaintext, sessionKey);
    sock.write(frame);
    try {
      const resp = await recvFrame(sock, sessionKey, TIMEOUT_MS);
      log.debug(`sendCommand cmd=0x${cmd.toString(16)} retcode=${resp.retcode} latency=${Date.now() - t0_}ms`);
      return resp;
    } catch (err) {
      disconnect("send_error: " + err.message);
      throw err;
    }
  }

  function enqueue(fn) {
    const p = _cmdChain.then(() => fn(), () => fn());
    _cmdChain = p.catch(() => {});
    return p;
  }

  function parseQueryPayload(resp) {
    if (resp.retcode !== 0) throw new Error("Query failed retcode=" + resp.retcode);
    let p = resp.payload;
    if (p.length > 15 && p.subarray(0, 3).toString() === "3.5") p = p.subarray(15);
    const s = p.toString("utf8").replace(/\x00+$/, "");
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first === -1 || last === -1) throw new Error("Invalid JSON in response");
    return JSON.parse(s.slice(first, last + 1));
  }

  async function executeQuery() {
    await connect();
    const resp = await sendCommand(CMD.DP_QUERY_NEW, Buffer.from("{}"));
    return parseQueryPayload(resp);
  }

  const instance = {
    async queryAll() {
      return enqueue(async () => {
        let lastErr;
        for (let attempt = 1; attempt <= QUERY_RETRIES; attempt++) {
          try {
            const result = await executeQuery();
            if (attempt > 1) {
              log.debug(`queryAll ${device.id}: succeeded on attempt ${attempt}`);
            }
            return result;
          } catch (err) {
            lastErr = err;
            disconnect("query_retry_" + attempt);
            log.debug(`queryAll ${device.id}: attempt ${attempt}/${QUERY_RETRIES} failed: ${err.message}`);
            if (attempt < QUERY_RETRIES) {
              await new Promise(r => setTimeout(r, QUERY_RETRY_DELAY_MS));
            }
          }
        }
        log.warn(`Local query failed for ${device.name} after ${QUERY_RETRIES} attempts: ${lastErr.message}`);
        throw lastErr;
      });
    },

    async setDP(dpId, value) {
      return enqueue(async () => {
        const body = JSON.stringify({
          protocol: 5,
          t: Math.floor(Date.now() / 1000),
          data: { dps: { [dpId]: value } },
        });

        const triedControl = await tryControl(CMD.CONTROL_NEW, Buffer.from(body), dpId, value);
        if (triedControl) {
          log.debug(`setDP ${device.id}: CONTROL_NEW ok (verified by QUERY)`);
          return true;
        }

        disconnect("control_failed");
        throw new Error("CONTROL_NEW failed");
      });
    },

    disconnect,
    isConnected: () => connected,
  };

  async function tryControl(cmd, payload, dpId, expectedValue) {
    for (let attempt = 1; attempt <= CONTROL_RETRIES; attempt++) {
      try {
        await connect();
        const plaintext = Buffer.concat([PROTOCOL_35_HEADER, payload]);
        const frame = buildFrame(nextSeq(), cmd, plaintext, sessionKey);
        await new Promise((resolve, reject) => {
          sock.write(frame, (err) => { if (err) reject(err); else resolve(); });
        });
        disconnect("control_sent");

        await new Promise(r => setTimeout(r, 300));

        let verifyErr;
        for (let v = 1; v <= VERIFY_RETRIES; v++) {
          try {
            const result = await executeQuery();
            if (result.dps && result.dps[dpId] === expectedValue) {
              return true;
            }
            if (result.dps && result.dps[dpId] !== undefined) {
              log.debug(`tryControl ${device.id}: state after control = ${result.dps[dpId]}, expected = ${expectedValue}`);
            }
            throw new Error(`state mismatch: got ${result.dps?.[dpId]}, expected ${expectedValue}`);
          } catch (err) {
            verifyErr = err;
            disconnect("verify_retry_" + v);
            log.debug(`tryControl ${device.id}: verify attempt ${v}/${VERIFY_RETRIES} failed: ${err.message}`);
            if (v < VERIFY_RETRIES) {
              await new Promise(r => setTimeout(r, QUERY_RETRY_DELAY_MS));
            }
          }
        }
        log.debug(`tryControl ${device.id}: attempt ${attempt}/${CONTROL_RETRIES} verify failed: ${verifyErr?.message || "state mismatch"}`);
      } catch (err) {
        log.debug(`tryControl ${device.id}: attempt ${attempt}/${CONTROL_RETRIES} failed: ${err.message}`);
      }
      disconnect("control_retry_" + attempt);
      if (attempt < CONTROL_RETRIES) {
        await new Promise(r => setTimeout(r, QUERY_RETRY_DELAY_MS));
      }
    }
    return false;
  }

  deviceInstances.set(device.id, instance);
  return instance;
}

export function removeLocalDevice(deviceId) {
  const inst = deviceInstances.get(deviceId);
  if (inst) { inst.disconnect("removed"); deviceInstances.delete(deviceId); }
}

