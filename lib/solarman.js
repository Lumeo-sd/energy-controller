import net from 'node:net';
import { addCrc, getCrc, verifyCrc } from './crc16.js';

const V5_START = 0xa5;
const V5_END = 0x15;

class SolarmanV5 {
  constructor(address, serial, options = {}) {
    this.address = address;
    this.serial = serial;
    this.port = options.port || 8899;
    this.mbSlaveId = options.mbSlaveId || 1;
    this.socketTimeout = (options.socketTimeout || 8) * 1000;
    this.autoReconnect = options.autoReconnect ?? false;
    this.socket = null;
    this.connected = false;
    this.sequenceNumber = null;
    this.lastFrame = Buffer.alloc(0);
    this.dataResolve = null;
    this.dataReject = null;
    this.dataWanted = false;
    this.v5Serial = Buffer.alloc(4);
    this.v5Serial.writeUInt32LE(this.serial, 0);
  }

  getNextSequenceNumber() {
    if (this.sequenceNumber === null) {
      this.sequenceNumber = Math.floor(Math.random() * 254) + 1;
    } else {
      this.sequenceNumber = (this.sequenceNumber + 1) & 0xff;
    }
    return this.sequenceNumber;
  }

  static calculateChecksum(data) {
    let checksum = 0;
    for (let i = 0; i < data.length; i++) checksum = (checksum + (data[i] & 0xff)) & 0xff;
    return checksum;
  }

  v5Header(length, control, seq) {
    const header = Buffer.alloc(11);
    header[0] = V5_START;
    header.writeUInt16LE(length, 1);
    header[3] = 0x10;
    header[4] = control;
    seq.copy(header, 5, 0, 2);
    this.v5Serial.copy(header, 7);
    return header;
  }

  v5Trailer(data) {
    const trailer = Buffer.alloc(2);
    trailer[0] = SolarmanV5.calculateChecksum(data.subarray(1));
    trailer[1] = V5_END;
    return trailer;
  }

  v5FrameEncoder(modbusFrame) {
    const length = 15 + modbusFrame.length;
    const seqNum = this.getNextSequenceNumber();
    const seq = Buffer.alloc(2);
    seq.writeUInt16LE(seqNum, 0);
    const header = this.v5Header(length, 0x45, seq);
    const payload = Buffer.concat([
      Buffer.from([0x02]),
      Buffer.from([0x00, 0x00]),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      modbusFrame,
    ]);
    const frame = Buffer.concat([header, payload]);
    return Buffer.concat([frame, this.v5Trailer(frame)]);
  }

  v5FrameDecoder(v5Frame) {
    if (v5Frame[0] !== V5_START || v5Frame[v5Frame.length - 1] !== V5_END) {
      throw new Error('V5 frame: invalid start/end');
    }
    const expectedChecksum = SolarmanV5.calculateChecksum(v5Frame.subarray(1, v5Frame.length - 2));
    if (v5Frame[v5Frame.length - 2] !== expectedChecksum) {
      throw new Error('V5 frame: invalid checksum');
    }
    if (v5Frame[5] !== this.sequenceNumber) {
      throw new Error('V5 frame: sequence number mismatch');
    }
    return v5Frame.subarray(25, v5Frame.length - 2);
  }

  v5TimeResponseFrame(frame) {
    const responseCode = frame[4] - 0x30;
    const seq = frame.subarray(5, 7);
    const header = this.v5Header(10, responseCode, seq);
    const payload = Buffer.alloc(10);
    payload.writeUInt16LE(0x0100, 0);
    payload.writeUInt32LE(Math.floor(Date.now() / 1000), 2);
    payload.writeUInt32LE(0, 6);
    const responseFrame = Buffer.concat([header, payload]);
    responseFrame[5] = (responseFrame[5] + 1) & 0xff;
    return Buffer.concat([responseFrame, this.v5Trailer(responseFrame)]);
  }

  receivedFrameIsValid(frame) {
    return frame[0] === V5_START && frame[5] === this.sequenceNumber;
  }

  handleProtocolFrame(frame) {
    const knownProtocolCodes = new Set([0x41, 0x42, 0x43, 0x47, 0x48]);
    if (frame[4] !== 0x45 && knownProtocolCodes.has(frame[4])) {
      const responseFrame = this.v5TimeResponseFrame(frame);
      if (this.socket && !this.socket.destroyed) this.socket.write(responseFrame);
      return false;
    }
    return true;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      socket.setTimeout(this.socketTimeout);
      const onError = (err) => { cleanup(); reject(err); };
      const onConnect = () => {
        cleanup();
        this.socket = socket;
        this.connected = true;
        this._setupListeners();
        resolve();
      };
      const cleanup = () => {
        socket.removeListener('error', onError);
        socket.removeListener('connect', onConnect);
      };
      socket.once('error', onError);
      socket.once('connect', onConnect);
      socket.connect(this.port, this.address);
    });
  }

  _setupListeners() {
    if (!this.socket) return;
    this.socket.on('data', (data) => {
      if (!this.receivedFrameIsValid(data)) return;
      if (!this.handleProtocolFrame(data)) return;
      if (this.dataWanted && this.dataResolve) {
        this.dataWanted = false;
        this.dataResolve(data);
        this.dataResolve = null;
        this.dataReject = null;
      }
    });
    this.socket.on('close', () => {
      this.connected = false;
      if (this.dataWanted && this.dataReject) {
        if (this.autoReconnect) {
          this.reconnect().then(() => {
            if (this.socket && this.lastFrame.length > 0) this.socket.write(this.lastFrame);
          }).catch((err) => {
            if (this.dataReject) { this.dataReject(err); this.dataResolve = null; this.dataReject = null; }
          });
        } else {
          this.dataReject(new Error('Connection closed'));
          this.dataResolve = null;
          this.dataReject = null;
        }
      }
    });
    this.socket.on('error', (err) => {
      if (this.dataWanted && this.dataReject) {
        this.dataReject(err);
        this.dataResolve = null;
        this.dataReject = null;
        this.dataWanted = false;
      }
    });
    this.socket.on('timeout', () => { this.socket?.destroy(); });
  }

  async reconnect() {
    try {
      if (this.socket) { this.socket.removeAllListeners(); this.socket.destroy(); this.socket = null; }
    } catch {}
    await this.connect();
  }

  async disconnect() {
    this.dataWanted = false;
    return new Promise((resolve) => {
      if (!this.socket) { resolve(); return; }
      this.socket.removeAllListeners();
      const onClose = () => { this.socket = null; this.connected = false; resolve(); };
      this.socket.once('close', onClose);
      try {
        this.socket.end();
        setTimeout(() => { if (this.socket) { this.socket.destroy(); this.socket = null; this.connected = false; } resolve(); }, 500);
      } catch { this.socket = null; this.connected = false; resolve(); }
    });
  }

  async sendReceiveFrame(frame) {
    if (!this.socket || this.socket.destroyed) throw new Error('Not connected');
    this.lastFrame = frame;
    this.dataWanted = true;
    return new Promise((resolve, reject) => {
      this.dataResolve = resolve;
      this.dataReject = reject;
      const timeout = setTimeout(() => {
        this.dataWanted = false;
        this.dataResolve = null;
        this.dataReject = null;
        reject(new Error('Timeout waiting for response'));
      }, this.socketTimeout);
      const origResolve = this.dataResolve;
      const origReject = this.dataReject;
      this.dataResolve = (data) => { clearTimeout(timeout); origResolve(data); };
      this.dataReject = (err) => { clearTimeout(timeout); origReject(err); };
      this.socket.write(frame);
    });
  }

  async readHoldingRegisters(registerAddr, quantity) {
    const mbRequest = Buffer.alloc(6);
    mbRequest[0] = this.mbSlaveId;
    mbRequest[1] = 0x03;
    mbRequest.writeUInt16BE(registerAddr, 2);
    mbRequest.writeUInt16BE(quantity, 4);
    const fullMbRequest = addCrc(mbRequest);

    const v5Request = this.v5FrameEncoder(fullMbRequest);
    const v5Response = await this.sendReceiveFrame(v5Request);
    const mbResponse = this.v5FrameDecoder(v5Response);

    let finalResponse = mbResponse;
    if (mbResponse.length >= 4) {
      const lastTwo = mbResponse.subarray(mbResponse.length - 2);
      if (lastTwo[0] === 0x00 && lastTwo[1] === 0x00) {
        const stripped = mbResponse.subarray(0, mbResponse.length - 2);
        const strippedPayload = stripped.subarray(0, stripped.length - 2);
        const computedCrc = getCrc(strippedPayload);
        const strippedCrc = stripped.subarray(stripped.length - 2);
        if (computedCrc[0] === strippedCrc[0] && computedCrc[1] === strippedCrc[1]) {
          finalResponse = stripped;
        }
      }
    }

    if (finalResponse[1] === 0x03 + 0x80) {
      throw new Error('Modbus exception: ' + finalResponse[2]);
    }
    if (!verifyCrc(finalResponse)) {
      throw new Error('Modbus CRC verification failed');
    }
    const byteCount = finalResponse[2];
    const values = [];
    for (let i = 0; i < byteCount / 2; i++) {
      values.push(finalResponse.readUInt16BE(3 + i * 2));
    }
    return values;
  }
}

export { SolarmanV5 };
