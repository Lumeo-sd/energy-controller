import dgram from 'node:dgram';
import crypto from 'node:crypto';

const BROADCAST_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();
const LISTEN_SECONDS = 20;
const PORT = 6667;

function tryDecryptAt(buf, offset, endOffset) {
  const slice = buf.slice(offset, endOffset || undefined);
  // Must be multiple of 16 for AES-ECB
  const len = slice.length - (slice.length % 16);
  if (len < 16) return null;
  const payload = slice.slice(0, len);
  
  for (const autoPad of [true, false]) {
    try {
      const decipher = crypto.createDecipheriv('aes-128-ecb', BROADCAST_KEY, null);
      decipher.setAutoPadding(autoPad);
      let out = Buffer.concat([decipher.update(payload), decipher.final()]);
      let str = out.toString('utf8');
      const lastBrace = str.lastIndexOf('}');
      if (lastBrace !== -1) str = str.slice(0, lastBrace + 1);
      const firstBrace = str.indexOf('{');
      if (firstBrace >= 0) str = str.slice(firstBrace);
      if (str.startsWith('{')) {
        const parsed = JSON.parse(str);
        return { parsed, autoPad, offset, len };
      }
    } catch {}
  }
  return null;
}

const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
let packetCount = 0;

socket.on('message', (buf, rinfo) => {
  packetCount++;
  if (packetCount > 3) return; // Only process first 3 packets in detail
  
  console.log('\n=== Packet #' + packetCount + ' from ' + rinfo.address + ' (' + buf.length + ' bytes) ===');
  console.log('First 32 bytes: ' + buf.slice(0, 32).toString('hex'));
  console.log('Last  32 bytes: ' + buf.slice(-32).toString('hex'));
  
  // Check for 00006699 prefix
  if (buf.slice(0, 4).toString('hex') === '00006699') {
    console.log('Prefix: 00006699 (protocol 3.4+)');
  }
  
  // Check for any known suffix
  const last4 = buf.slice(-4).toString('hex');
  console.log('Last 4 bytes: ' + last4);
  
  // Try decrypting at multiple offsets
  console.log('\nTrying decryption at various offsets:');
  for (let offset = 4; offset <= 28; offset += 4) {
    const result = tryDecryptAt(buf, offset);
    if (result) {
      console.log('  offset=' + offset + ' len=' + result.len + ' autoPad=' + result.autoPad + ' -> ' + JSON.stringify(result.parsed));
    } else {
      console.log('  offset=' + offset + ' -> no valid JSON');
    }
  }
  
  // Also try: whole packet minus first 4 bytes, trimmed to block boundary
  console.log('\nTrying: everything from offset 4 to end (block-aligned):');
  for (let offset = 4; offset <= 20; offset += 4) {
    const result = tryDecryptAt(buf, offset, buf.length - (buf.length % 16 === 0 ? 0 : buf.length % 16));
    if (result) {
      console.log('  offset=' + offset + ' -> ' + JSON.stringify(result.parsed));
    }
  }
  
  // Also try: look for the suffix 0000AA55 somewhere in the middle
  const hex = buf.toString('hex');
  const suffixIdx = hex.indexOf('0000aa55');
  const suffixIdx2 = hex.indexOf('000055aa');
  console.log('\nSuffix search: 0000AA55 at hex offset=' + (suffixIdx === -1 ? 'not found' : suffixIdx/2));
  console.log('Suffix search: 000055AA at hex offset=' + (suffixIdx2 === -1 ? 'not found' : suffixIdx2/2));
  
  // Try looking for the plaintext JSON pattern in decrypted blocks
  console.log('\nTrying brute-force: decrypt every 16-byte-aligned chunk and look for JSON:');
  for (let start = 4; start < buf.length - 16; start += 4) {
    const chunk = buf.slice(start, start + 64);
    if (chunk.length < 16) continue;
    try {
      const decipher = crypto.createDecipheriv('aes-128-ecb', BROADCAST_KEY, null);
      decipher.setAutoPadding(false);
      const out = decipher.update(chunk);
      const str = out.toString('utf8');
      if (str.includes('{') && str.includes('}')) {
        console.log('  Potential JSON at offset=' + start + ': ' + str.replace(/[^\x20-\x7e]/g, '.').slice(0, 80));
      }
    } catch {}
  }
  
  if (packetCount >= 3) {
    setTimeout(() => { socket.close(); process.exit(0); }, 500);
  }
});

socket.bind(PORT, '0.0.0.0', () => {
  console.log('[..] Probing UDP 0.0.0.0:' + PORT + ' for ' + LISTEN_SECONDS + 's...');
});

setTimeout(() => { socket.close(); process.exit(0); }, LISTEN_SECONDS * 1000);
