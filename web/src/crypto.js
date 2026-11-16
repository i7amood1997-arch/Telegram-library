// Decryption of library.enc. Shared by the browser app and the Node round-trip test, so it
// is plain JavaScript using only Web Crypto + DecompressionStream (available in both).
// Format: see pipeline/crypto.py.

const encoder = new TextEncoder();

/** @param {string} s */
export function b64decode(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** @param {Uint8Array} bytes */
export function b64encode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(out);
}

/**
 * @param {string} text
 * @returns {{iter: number, salt: Uint8Array, saltB64: string, iv: Uint8Array, ct: Uint8Array}}
 */
export function parseEnvelope(text) {
  const env = JSON.parse(text);
  if (env.v !== 1 || env.kdf !== 'pbkdf2-sha256') throw new Error('Unsupported data format');
  return {
    iter: env.iter,
    salt: b64decode(env.salt),
    saltB64: env.salt,
    iv: b64decode(env.iv),
    ct: b64decode(env.ct),
  };
}

/**
 * Derive the raw 256-bit AES key from the password.
 * @param {string} password @param {Uint8Array} salt @param {number} iterations
 */
export async function deriveKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Decrypt an envelope with a raw key. Throws on a wrong key (GCM authentication failure).
 * @param {ReturnType<typeof parseEnvelope>} env @param {Uint8Array} rawKey
 */
export async function decryptWithKey(env, rawKey) {
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: env.iv }, key, env.ct);
  const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}
