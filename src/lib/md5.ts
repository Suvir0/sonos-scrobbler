/**
 * MD5, because Last.fm's `api_sig` requires it.
 *
 * Written out rather than pulled from `node:crypto` deliberately. The Workers
 * `nodejs_compat` shim's hash algorithm coverage is a moving target, and the failure
 * mode if MD5 is ever absent is silent: every scrobble is rejected with "Invalid
 * method signature" and nothing else looks wrong. Sixty lines of pure arithmetic with
 * RFC 1321 test vectors removes that whole class of surprise, and MD5 here is a
 * protocol requirement, not a security choice.
 */

const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
] as const;

/** K[i] = floor(abs(sin(i + 1)) * 2^32) — the RFC's sine table. */
const K = (() => {
  const table = new Uint32Array(64);
  for (let i = 0; i < 64; i += 1) table[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32);
  return table;
})();

function rotl(value: number, count: number): number {
  return ((value << count) | (value >>> (32 - count))) >>> 0;
}

/** A 32-bit word as little-endian hex, which is the byte order MD5 digests use. */
function hexLE(word: number): string {
  let out = '';
  for (let i = 0; i < 4; i += 1) out += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
  return out;
}

export function md5(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;

  // Pad to a multiple of 64 bytes, leaving 8 bytes for the length.
  const paddedLength = (((bytes.length + 8) >>> 6) + 1) << 6;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 8, bitLength % 2 ** 32, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 2 ** 32), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const block = new Uint32Array(16);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) block[i] = view.getUint32(offset + i * 4, true);

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const rotated = (f + a + K[i]! + block[g]!) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotl(rotated, SHIFTS[i]!)) >>> 0;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  return hexLE(a0) + hexLE(b0) + hexLE(c0) + hexLE(d0);
}
