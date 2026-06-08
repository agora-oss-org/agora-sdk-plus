// Local hex helpers so this package stays free of the core's base64 (the seam works in Uint8Array;
// the network layer base64-encodes at the wire boundary). Used to key in-memory maps and to serialize
// raw key bytes in device-state JSON.

/** Encode bytes as a lowercase hex string. */
export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Decode a lowercase/uppercase hex string back to bytes. */
export function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
