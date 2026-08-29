import { describe, expect, it } from 'vitest';
import { md5 } from './md5.js';

describe('md5', () => {
  // RFC 1321, appendix A.5.
  it.each([
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['a', '0cc175b9c0f1b6a831c399e269772661'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
    ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
    [
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
      'd174ab98d277d9f5a5611c2c9f419d9f'
    ],
    [
      '12345678901234567890123456789012345678901234567890123456789012345678901234567890',
      '57edf4a22be3c955ac49da2e2107b67a'
    ]
  ])('hashes %j', (input, expected) => {
    expect(md5(input)).toBe(expected);
  });

  it('hashes across a block boundary', () => {
    // 55 bytes fits the length field in one block; 56 forces a second.
    expect(md5('a'.repeat(55))).toBe('ef1772b6dff9a122358552954ad0df65');
    expect(md5('a'.repeat(56))).toBe('3b0c8ac703f828b04c6c197006d17218');
  });

  // Last.fm signs artist and track names verbatim, so multi-byte input must hash as
  // UTF-8 bytes rather than UTF-16 code units. Values cross-checked against node:crypto.
  it.each([
    ['Björk', '7dab4f23a40857b30fdd81370c211680'],
    ['é', '66ddcd97cfdeabb2f6fb8a999b4bc76f'],
    ['日本語', '00110af8b4393ef3f72c50be5b332bec'],
    ['AC/DC — Back in Black', 'b78e634106b44fd257da69d84b6fc13a']
  ])('hashes %j as UTF-8 bytes', (input, expected) => {
    expect(md5(input)).toBe(expected);
  });

  it('hashes a multi-block message', () => {
    expect(md5('a'.repeat(64))).toBe('014842d480b571495a4a0363793f7367');
    expect(md5('a'.repeat(200))).toBe('887f30b43b2867f4a9accceee7d16e6c');
  });
});
