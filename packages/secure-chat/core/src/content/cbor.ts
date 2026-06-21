// Deterministic CBOR (RFC 8949) over a constrained subset — the wire form for MimiContent.
//
// Where it sits: this is pure byte-shuffling ABOVE the SecureChatCrypto seam and INSIDE the padding
// frame. It encodes message content to canonical CBOR so the SHA-256 contentHash is stable across
// runtimes (web/native), and decodes UNTRUSTED peer bytes strictly and within bounds (CLAUDE.md §1:
// validate-then-decode, fail closed). The subset is exactly what MimiContent needs — unsigned/negative
// integers, byte/text strings, arrays, maps, tags, and the simple values false/true/null — and
// deliberately EXCLUDES CBOR's hard, ambiguous parts: floats, indefinite-length items, and bignums.
//
// "Canonical" = RFC 8949 §4.2 core deterministic rules for this subset: shortest-form integers and
// lengths, definite lengths, map keys sorted by their encoded bytes, no duplicate keys.

/** A value in the supported CBOR subset. Integers in safe-int range are `number`; larger are `bigint`. */
export type CborValue =
  | number
  | bigint
  | Uint8Array
  | string
  | CborValue[]
  | CborMap
  | CborTag
  | boolean
  | null;

/** A CBOR map (major type 5). Keys are encoded and sorted deterministically on encode. */
export type CborMap = Map<CborValue, CborValue>;

/** A CBOR tagged value (major type 6): a `tag` number wrapping one nested value. */
export class CborTag {
  constructor(
    /** The CBOR tag number (major type 6 argument). */
    public readonly tag: number | bigint,
    /** The single nested value wrapped by this tag. */
    public readonly value: CborValue
  ) {}
}

/** Strict-decode bounds. Defaults: 1 MiB total, depth 32, 4096 items per array/map. */
export interface CborLimits {
  /** Reject inputs longer than this many bytes (DoS guard). Default 1 << 20. */
  maxBytes?: number;
  /** Reject nesting deeper than this. Default 32. */
  maxDepth?: number;
  /** Reject any array/map with more than this many items. Default 4096. */
  maxItems?: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Compare two byte arrays lexicographically (the canonical map-key order). */
function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** Emit a CBOR head: the major type (0..7) and its argument, in shortest form. */
function head(major: number, arg: number | bigint): Uint8Array {
  const m = major << 5;
  const n = typeof arg === "bigint" ? arg : BigInt(arg);
  if (n < 0n) throw new Error("cbor: negative head argument");
  if (n < 24n) return Uint8Array.of(m | Number(n));
  if (n < 0x100n) return Uint8Array.of(m | 24, Number(n));
  if (n < 0x10000n) return Uint8Array.of(m | 25, Number(n >> 8n) & 0xff, Number(n & 0xffn));
  if (n < 0x100000000n)
    return Uint8Array.of(
      m | 26,
      Number((n >> 24n) & 0xffn),
      Number((n >> 16n) & 0xffn),
      Number((n >> 8n) & 0xffn),
      Number(n & 0xffn)
    );
  if (n < 0x10000000000000000n) {
    const out = new Uint8Array(9);
    out[0] = m | 27;
    let v = n;
    for (let i = 8; i >= 1; i--) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return out;
  }
  throw new Error("cbor: integer exceeds u64 (no bignum support)");
}

function encodeInto(v: CborValue, parts: Uint8Array[]): void {
  if (v === null) return void parts.push(Uint8Array.of(0xf6));
  if (v === false) return void parts.push(Uint8Array.of(0xf4));
  if (v === true) return void parts.push(Uint8Array.of(0xf5));
  const t = typeof v;
  if (t === "number" || t === "bigint") {
    if (t === "number" && !Number.isInteger(v as number))
      throw new Error("cbor: non-integer number (no float support)");
    const n = typeof v === "bigint" ? v : BigInt(v as number);
    if (n >= 0n) parts.push(head(0, n));
    else parts.push(head(1, -1n - n));
    return;
  }
  if (v instanceof Uint8Array) {
    parts.push(head(2, v.length));
    parts.push(v);
    return;
  }
  if (t === "string") {
    const b = enc.encode(v as string);
    parts.push(head(3, b.length));
    parts.push(b);
    return;
  }
  if (Array.isArray(v)) {
    parts.push(head(4, v.length));
    for (const e of v) encodeInto(e, parts);
    return;
  }
  if (v instanceof CborTag) {
    parts.push(head(6, v.tag));
    encodeInto(v.value, parts);
    return;
  }
  if (v instanceof Map) {
    const entries = [...(v as CborMap).entries()].map(
      ([k, val]) => [encode(k), val] as const
    );
    entries.sort((a, b) => cmpBytes(a[0], b[0]));
    for (let i = 1; i < entries.length; i++)
      if (cmpBytes(entries[i - 1][0], entries[i][0]) === 0)
        throw new Error("cbor: duplicate map key");
    parts.push(head(5, entries.length));
    for (const [kb, val] of entries) {
      parts.push(kb);
      encodeInto(val, parts);
    }
    return;
  }
  throw new Error("cbor: unsupported value");
}

/**
 * Encode a {@link CborValue} to canonical CBOR bytes (RFC 8949 §4.2 core deterministic rules).
 *
 * @param value - A value in the supported subset.
 * @returns The canonical CBOR byte encoding.
 * @throws {Error} On a non-integer number, an integer above u64, or an unsupported value type.
 * @example
 * ```ts
 * encode(new Map([[1, "a"]])); // → a2 01 61 61 …  (keys sorted by encoded bytes)
 * ```
 */
export function encode(value: CborValue): Uint8Array {
  const parts: Uint8Array[] = [];
  encodeInto(value, parts);
  return concat(parts);
}

class Reader {
  pos = 0;
  constructor(
    readonly buf: Uint8Array,
    readonly limits: Required<CborLimits>
  ) {}

  private byte(): number {
    if (this.pos >= this.buf.length) throw new Error("cbor: unexpected end of input");
    return this.buf[this.pos++];
  }

  /** Read the argument for additional-info `ai`, enforcing shortest-form (canonical). */
  private arg(ai: number): bigint {
    if (ai < 24) return BigInt(ai);
    if (ai === 24) {
      const n = BigInt(this.byte());
      if (n < 24n) throw new Error("cbor: non-canonical (shortest-form) integer");
      return n;
    }
    if (ai === 25) {
      const n = (BigInt(this.byte()) << 8n) | BigInt(this.byte());
      if (n < 0x100n) throw new Error("cbor: non-canonical (shortest-form) integer");
      return n;
    }
    if (ai === 26) {
      let n = 0n;
      for (let i = 0; i < 4; i++) n = (n << 8n) | BigInt(this.byte());
      if (n < 0x10000n) throw new Error("cbor: non-canonical (shortest-form) integer");
      return n;
    }
    if (ai === 27) {
      let n = 0n;
      for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(this.byte());
      if (n < 0x100000000n) throw new Error("cbor: non-canonical (shortest-form) integer");
      return n;
    }
    throw new Error("cbor: reserved/indefinite additional info (outside subset)");
  }

  private take(n: bigint): Uint8Array {
    if (n > BigInt(this.limits.maxBytes)) throw new Error("cbor: length exceeds bounds");
    const len = Number(n);
    if (this.pos + len > this.buf.length) throw new Error("cbor: unexpected end of input");
    const slice = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return slice;
  }

  /** Integers small enough stay `number`; larger become `bigint`. */
  private intVal(n: bigint, negative: boolean): number | bigint {
    const v = negative ? -1n - n : n;
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(v)
      : v;
  }

  value(depth: number): CborValue {
    if (depth > this.limits.maxDepth) throw new Error("cbor: nesting depth exceeds bounds");
    const ib = this.byte();
    const major = ib >> 5;
    const ai = ib & 0x1f;
    switch (major) {
      case 0:
        return this.intVal(this.arg(ai), false);
      case 1:
        return this.intVal(this.arg(ai), true);
      case 2:
        return this.take(this.arg(ai)).slice(); // copy out of the backing buffer
      case 3:
        return dec.decode(this.take(this.arg(ai)));
      case 4: {
        const len = this.arg(ai);
        if (len > BigInt(this.limits.maxItems)) throw new Error("cbor: array length exceeds bounds");
        const out: CborValue[] = [];
        for (let i = 0n; i < len; i++) out.push(this.value(depth + 1));
        return out;
      }
      case 5: {
        const len = this.arg(ai);
        if (len > BigInt(this.limits.maxItems)) throw new Error("cbor: map length exceeds bounds");
        const out: CborMap = new Map();
        let prevKey: Uint8Array | null = null;
        for (let i = 0n; i < len; i++) {
          const k = this.value(depth + 1);
          const kb = encode(k); // canonical key bytes — enforce strictly-increasing order
          if (prevKey) {
            const c = cmpBytes(prevKey, kb);
            if (c === 0) throw new Error("cbor: duplicate map key");
            if (c > 0) throw new Error("cbor: map keys not sorted (non-canonical)");
          }
          prevKey = kb;
          out.set(k, this.value(depth + 1));
        }
        return out;
      }
      case 6: {
        // Normalize the tag the same way as integers (safe-int → number, larger → bigint) so a tag
        // round-trips to the same JS type a caller would naturally pass to `new CborTag(...)`.
        const tag = this.intVal(this.arg(ai), false);
        return new CborTag(tag, this.value(depth + 1));
      }
      case 7:
        if (ai === 20) return false;
        if (ai === 21) return true;
        if (ai === 22) return null;
        throw new Error("cbor: float/simple value outside subset");
      default:
        throw new Error("cbor: unknown major type");
    }
  }
}

/**
 * Strict-decode canonical CBOR bytes from the supported subset. Rejects non-canonical encodings,
 * out-of-subset major/simple values, trailing bytes, and anything exceeding {@link CborLimits}.
 *
 * @param bytes - The CBOR input (untrusted peer data — decoded fail-closed).
 * @param limits - Optional {@link CborLimits} bounds.
 * @returns The decoded {@link CborValue}.
 * @throws {Error} On any non-canonical encoding, out-of-subset value, truncation, trailing bytes, or
 *   a bound (size/depth/item-count) being exceeded.
 */
export function decode(bytes: Uint8Array, limits: CborLimits = {}): CborValue {
  const resolved: Required<CborLimits> = {
    maxBytes: limits.maxBytes ?? 1 << 20,
    maxDepth: limits.maxDepth ?? 32,
    maxItems: limits.maxItems ?? 4096,
  };
  if (bytes.length > resolved.maxBytes) throw new Error("cbor: input too large (bounds)");
  const r = new Reader(bytes, resolved);
  const v = r.value(0);
  if (r.pos !== bytes.length) throw new Error("cbor: trailing bytes after top-level value");
  return v;
}
