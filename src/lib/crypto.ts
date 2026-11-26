const DEFAULT_ITERATIONS = 100000;

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Fallback(data: Uint8Array): Uint8Array {
  const bitLen = data.length * 8;
  const paddedLen = Math.ceil((data.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 =
        ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^
        ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^
        (w[i - 15] >>> 3);
      const s1 =
        ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^
        ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^
        (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);
  return out;
}

function hmacSha256Fallback(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const blockKey = new Uint8Array(64);
  if (key.length > 64) {
    blockKey.set(sha256Fallback(key));
  } else {
    blockKey.set(key);
  }
  const inner = new Uint8Array(64 + msg.length);
  for (let i = 0; i < 64; i++) inner[i] = blockKey[i] ^ 0x36;
  inner.set(msg, 64);
  const innerHash = sha256Fallback(inner);

  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) outer[i] = blockKey[i] ^ 0x5c;
  outer.set(innerHash, 64);
  return sha256Fallback(outer);
}

function pbkdf2Sha256Fallback(
  passwordBytes: Uint8Array,
  saltBytes: Uint8Array,
  iterations: number
): Uint8Array {
  const input = new Uint8Array(saltBytes.length + 4);
  input.set(saltBytes);
  input[saltBytes.length + 3] = 1; // block index 1 (32 bytes = 256 bits)

  let u = hmacSha256Fallback(passwordBytes, input);
  const t = new Uint8Array(u);
  for (let i = 1; i < iterations; i++) {
    u = hmacSha256Fallback(passwordBytes, u);
    for (let j = 0; j < 32; j++) {
      t[j] ^= u[j];
    }
  }
  return t;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

export function generateSalt(): string {
  const arr = new Uint8Array(16);
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < arr.length; i++) {
      arr[i] = Math.floor(Math.random() * 256);
    }
  }
  return bytesToHex(arr);
}

export async function sha256Hex(payload: string): Promise<string> {
  const encoded = new TextEncoder().encode(payload);
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) {
    try {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', encoded);
      return bytesToHex(new Uint8Array(digest));
    } catch {
      // Fallback for non-secure contexts
    }
  }
  return bytesToHex(sha256Fallback(encoded));
}

export async function hashPassword(
  password: string,
  saltHex: string,
  iterations = DEFAULT_ITERATIONS
): Promise<string> {
  const enc = new TextEncoder();
  const passBytes = enc.encode(password);
  const saltBytes = hexToBytes(saltHex);

  if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) {
    try {
      const keyMaterial = await globalThis.crypto.subtle.importKey(
        'raw',
        passBytes,
        { name: 'PBKDF2' },
        false,
        ['deriveBits']
      );

      const derivedBits = await globalThis.crypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          salt: saltBytes.buffer as ArrayBuffer,
          iterations,
          hash: 'SHA-256',
        },
        keyMaterial,
        256
      );

      return bytesToHex(new Uint8Array(derivedBits));
    } catch {
      // Fall through to pure-JS PBKDF2 when subtle fails in non-HTTPS contexts
    }
  }

  return bytesToHex(pbkdf2Sha256Fallback(passBytes, saltBytes, iterations));
}

export async function verifyPassword(
  password: string,
  saltHex: string,
  expectedHashHex: string,
  iterations = DEFAULT_ITERATIONS
): Promise<boolean> {
  const computed = await hashPassword(password, saltHex, iterations);
  if (computed.length !== expectedHashHex.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ expectedHashHex.charCodeAt(i);
  }
  return diff === 0;
}
