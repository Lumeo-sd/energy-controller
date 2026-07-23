const CRC_TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let j = 0; j < 8; j++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  CRC_TABLE[i] = crc;
}

function crc16(data) {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff];
  return crc;
}

function getCrc(data) {
  const c = crc16(data);
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(c, 0);
  return buf;
}

function addCrc(data) {
  return Buffer.concat([data, getCrc(data)]);
}

function verifyCrc(frame) {
  if (frame.length < 4) return false;
  const payload = frame.subarray(0, frame.length - 2);
  const expected = frame.subarray(frame.length - 2);
  const computed = getCrc(payload);
  return computed[0] === expected[0] && computed[1] === expected[1];
}

export { crc16, getCrc, addCrc, verifyCrc };
