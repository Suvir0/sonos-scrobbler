/**
 * Crypto primitives, all on WebCrypto so nothing here depends on a Node shim.
 *
 * Four jobs, deliberately kept apart:
 *  - `encryptSecret`/`decryptSecret` protect OAuth credentials at rest in D1.
 *  - `sonosEventSignature` reproduces the signature Sonos puts on every webhook.
 *  - `hmacHex` derives dedupe and session keys that must not be reversible.
 *  - `randomToken` mints OAuth state and session cookies.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/* ------------------------------------------------------------------ encoding */

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Base64url without padding, which is what the Sonos event signature uses. */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/* ------------------------------------------------------------------ random */

export function randomToken(byteLength = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/* ------------------------------------------------------------------ digests */

export async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await sha256(value));
}

async function hmacKey(secretBase64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    fromBase64(secretBase64) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

/**
 * Keyed hash. Used for the scrobble dedupe key and for session cookie lookup, both of
 * which need "same input, same output" without "output reveals input" — an unkeyed
 * digest of `artist\0track\0timestamp` would be trivially brute-forced from a known
 * catalogue, which would defeat the point of not storing the plaintext.
 */
export async function hmacHex(secretBase64: string, message: string): Promise<string> {
  const key = await hmacKey(secretBase64);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return toHex(new Uint8Array(signature));
}

/* ------------------------------------------------------------ sonos signature */

/**
 * The signature Sonos sends on every event, per the eventing docs: SHA-256 over the
 * concatenation of five headers plus the client credentials, base64url encoded with
 * no padding.
 *
 * Note what this does *not* cover: the request body. It proves the sender holds the
 * client secret; it does not bind the payload to the signature. Callers must also
 * enforce a monotonically increasing sequence id per subscription — see
 * `verifySonosEvent` in ../sonos/events.ts.
 */
export async function sonosEventSignature(parts: {
  seqId: string;
  namespace: string;
  type: string;
  targetType: string;
  targetValue: string;
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  const signable =
    parts.seqId +
    parts.namespace +
    parts.type +
    parts.targetType +
    parts.targetValue +
    parts.clientId +
    parts.clientSecret;
  return toBase64Url(await sha256(signable));
}

/** Constant-time comparison, so a wrong signature leaks nothing through timing. */
export function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return mismatch === 0;
}

/* ------------------------------------------------------------ secret storage */

const IV_BYTES = 12;

async function aesKey(keyBase64: string): Promise<CryptoKey> {
  const raw = fromBase64(keyBase64);
  if (raw.length !== 32) {
    throw new Error(`TOKEN_ENCRYPTION_KEY must decode to 32 bytes, got ${raw.length}`);
  }
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt'
  ]);
}

/**
 * AES-GCM with a fresh random IV per call, stored as base64(iv ‖ ciphertext‖tag).
 *
 * A fresh IV per call matters more than usual here: the same refresh token is
 * re-encrypted on every rotation, and GCM catastrophically loses confidentiality if
 * an IV is ever reused under the same key.
 */
export async function encryptSecret(plaintext: string, keyBase64: string): Promise<string> {
  const key = await aesKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext))
  );
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv);
  packed.set(ciphertext, iv.length);
  return toBase64(packed);
}

export async function decryptSecret(packed: string, keyBase64: string): Promise<string> {
  const key = await aesKey(keyBase64);
  const bytes = fromBase64(packed);
  if (bytes.length <= IV_BYTES) throw new Error('ciphertext too short');
  const iv = bytes.subarray(0, IV_BYTES);
  const ciphertext = bytes.subarray(IV_BYTES);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ciphertext as BufferSource
  );
  return decoder.decode(plaintext);
}
