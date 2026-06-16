// Message size-bucket padding — a metadata-hardening frame applied to plaintext BEFORE MLS encryption.
//
// Where it sits in the blind-server model: the server (and any DB/network observer) is trusted to relay
// ciphertext but learns *envelope* metadata in the Signal model — including ciphertext SIZE. Raw chat
// text encrypts to a ciphertext whose length tracks the message length, leaking traffic shape. We wrap
// the plaintext in a self-describing frame and zero-pad it up to a fixed bucket ladder, so short
// messages collapse into a few sizes. MLS then encrypts the frame, so the ciphertext inherits the
// bucketing (modulo a constant MLS framing overhead). This is pure byte-shuffling — NO crypto, no keys
// — and the frame is symmetric: every client pads on send and unpads on receive identically.
//
// Frame layout: [version:1B = 1][contentLen:uint32 BE][content bytes][zero padding → bucket].

/** The smallest bucket; also the floor for an empty message (a 5-byte header → bucket 32). */
const LADDER = [32, 64, 128, 256, 512, 1024, 2048, 4096, 8192] as const;
/** Above the ladder we round up to multiples of this (the largest ladder rung). */
const STEP = 8192;
/** Frame header: 1 version byte + a 4-byte big-endian content length. */
const HEADER = 5;
/** Frame format version, bound as the first byte so the codec can evolve without ambiguity. */
const VERSION = 1;

/**
 * How aggressively to pad outbound message plaintext.
 *
 * - `"ladder"` — round the framed length up to the next size bucket (the default; blunts length
 *   fingerprinting).
 * - `"none"` — still frame the message (so unpadding stays uniform across clients) but add no extra
 *   bytes. Use only when bandwidth matters more than traffic-shape privacy.
 */
export type PaddingPolicy = "ladder" | "none";

/**
 * Round a framed byte length up to the next size bucket: the smallest ladder rung
 * (32, 64, … , 8192) that is ≥ `n`, or — above the ladder — the next multiple of 8192.
 *
 * @param n - The unpadded framed length (header + content) in bytes.
 * @returns The bucket size to pad up to (always ≥ 32, always ≥ `n`).
 */
export function nextBucket(n: number): number {
  for (const b of LADDER) if (n <= b) return b;
  return Math.ceil(n / STEP) * STEP;
}

/**
 * Wrap message content in a size-bucket padding frame for encryption. The output is
 * `[version][contentLen][content][zero pad]`; under `"ladder"` its length is one of the fixed buckets
 * from {@link nextBucket}. Padding bytes are zeros — they ride inside the MLS ciphertext, so they need
 * not be random.
 *
 * @param content - The plaintext bytes to send (e.g. `utf8ToBytes(text)`).
 * @param policy - The {@link PaddingPolicy}; defaults to `"ladder"`.
 * @returns The framed, padded bytes to hand to `crypto.encryptMessage`.
 */
export function padPlaintext(content: Uint8Array, policy: PaddingPolicy = "ladder"): Uint8Array {
  const framed = HEADER + content.length;
  const target = policy === "ladder" ? nextBucket(framed) : framed;
  const out = new Uint8Array(target); // zero-filled → the padding is already in place
  out[0] = VERSION;
  out[1] = (content.length >>> 24) & 0xff;
  out[2] = (content.length >>> 16) & 0xff;
  out[3] = (content.length >>> 8) & 0xff;
  out[4] = content.length & 0xff;
  out.set(content, HEADER);
  return out;
}

/**
 * Recover the original content from a {@link padPlaintext} frame after decryption. Validates the version
 * byte and bounds-checks the declared length, then slices off the header and trailing zero padding.
 *
 * @param frame - The decrypted frame bytes (from `crypto.decryptMessage`).
 * @returns The original content bytes.
 * @throws {Error} On a frame that is too short, carries an unknown version, or declares a length that
 *   overruns the buffer — a successfully-authenticated MLS message with a bad frame is a real
 *   framing/version mismatch, so the caller fails closed rather than rendering raw padded bytes.
 */
export function unpadPlaintext(frame: Uint8Array): Uint8Array {
  if (frame.length < HEADER) throw new Error("secure-chat: padding frame too short");
  if (frame[0] !== VERSION) throw new Error(`secure-chat: unsupported padding frame version ${frame[0]}`);
  const len = (frame[1] << 24) | (frame[2] << 16) | (frame[3] << 8) | frame[4];
  if (len < 0 || HEADER + len > frame.length) throw new Error("secure-chat: padding frame length out of range");
  return frame.slice(HEADER, HEADER + len);
}
