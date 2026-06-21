// Content routing frame — a single discriminator byte INSIDE the padding frame, ABOVE MimiContent.
//
// padPlaintext( frameContent(kind, payload) ) → encrypt. One byte routes user content vs control
// traffic without wrapping the MimiContent CBOR in another struct (keeps the MIMI bytes pure). The
// padding frame (util/padding) is the transport concern and is unchanged.

/** Content-frame discriminator. `Mimi` = MimiContent CBOR; `IucControl` is reserved for the IUC state machine. */
export const ContentKind = { Mimi: 0, IucControl: 1 } as const;
export type ContentKind = (typeof ContentKind)[keyof typeof ContentKind];

/**
 * Prefix `payload` with its routing `kind` byte.
 * @param kind - The discriminator (0..255); use {@link ContentKind}.
 * @param payload - The bytes to route (e.g. MimiContent CBOR).
 * @returns `[kind][payload]`.
 * @throws {Error} If `kind` is not an integer in 0..255.
 */
export function frameContent(kind: number, payload: Uint8Array): Uint8Array {
  if (!Number.isInteger(kind) || kind < 0 || kind > 255) throw new Error("content frame: kind must be a byte (0..255)");
  const out = new Uint8Array(payload.length + 1);
  out[0] = kind;
  out.set(payload, 1);
  return out;
}

/**
 * Split a content frame into its routing `kind` and the remaining `payload`.
 * @param bytes - A `[kind][payload]` frame (after unpadding).
 * @returns `{ kind, payload }`.
 * @throws {Error} If `bytes` is empty (no kind byte).
 */
export function unframe(bytes: Uint8Array): { kind: number; payload: Uint8Array } {
  if (bytes.length < 1) throw new Error("content frame: empty (too short)");
  return { kind: bytes[0], payload: bytes.subarray(1) };
}
