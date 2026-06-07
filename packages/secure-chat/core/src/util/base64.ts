// Base64 ⇄ Uint8Array at the wire boundary.
//
// The `SecureChatCrypto` seam works in `Uint8Array`; the server contract is base64. These helpers
// are the only place that conversion happens. Pure (no Buffer / atob / btoa) so the same code runs
// on web, React Native, and Node without a polyfill.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const LOOKUP: number[] = (() => {
  const table = new Array<number>(256).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  table["=".charCodeAt(0)] = 0;
  return table;
})();

/** Encode bytes to a standard (padded) base64 string. */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + "==";
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + "=";
  }
  return out;
}

/** Decode a standard base64 string to bytes. Ignores ASCII whitespace; throws on bad chars. */
export function fromBase64(b64: string): Uint8Array {
  const clean = b64.replace(/[\r\n\t ]/g, "");
  const padless = clean.replace(/=+$/, "");
  const outLen = (padless.length * 3) >> 2;
  const out = new Uint8Array(outLen);
  let o = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < padless.length; i++) {
    const v = LOOKUP[padless.charCodeAt(i)];
    if (v === -1) throw new Error("invalid base64 character");
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}

/** UTF-8 text → bytes (for encrypting message plaintext). */
export function utf8ToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Bytes → UTF-8 text (for decrypted message plaintext). */
export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
