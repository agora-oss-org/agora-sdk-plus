// Vitest setup: make jsdom tests share Node's binary realm with Node's WebCrypto.
//
// Why this exists (a test-harness artifact, NOT a product bug):
// Vitest executes each test module inside its own vm realm, whose `ArrayBuffer` / `Uint8Array`
// intrinsics are DISTINCT from Node's main realm — yet `crypto.subtle` is Node's main-realm WebCrypto.
// (jsdom itself shares Node's intrinsics; the split comes from vitest's vm module runner.) Our real-MLS
// tests run under jsdom to drive React hooks, so every `new Uint8Array(...)` / `new ArrayBuffer(...)`
// in ts-mls, @hpke, and @noble is vm-realm. When such a *bare* `ArrayBuffer` reaches
// `crypto.subtle.importKey`, Node 20's WebCrypto brand-checks it with `instanceof` against its own
// `ArrayBuffer` and REJECTS the cross-realm one — "2nd argument is not instance of ArrayBuffer, Buffer,
// TypedArray, or DataView". Node 22 relaxed that to a structural check, which is why it's Node-20-only.
//
// A real browser has a single realm (its `ArrayBuffer`, typed arrays, and `crypto.subtle` all match),
// so this can never happen in production — only the split-realm vitest harness reproduces it.
//
// Fix: restore Node's `ArrayBuffer` and `Uint8Array` as the test globals, so binary values built in the
// test realm and handed to Node's WebCrypto share its realm — matching a real browser's single-realm
// model. (Restoring `Uint8Array` is what matters: a typed array's backing buffer is allocated in the
// typed array's realm, so unifying it also unifies every `.buffer` that flows into importKey.) Under the
// `node` environment the globals are already Node's, so this is a no-op there.
import { Buffer } from "node:buffer";

// `Buffer` is always Node's main realm; its prototype chain yields Node's intrinsic Uint8Array → ArrayBuffer.
const NodeUint8Array = Object.getPrototypeOf(Buffer.prototype).constructor as Uint8ArrayConstructor;
const NodeArrayBuffer = new NodeUint8Array(0).buffer.constructor as ArrayBufferConstructor;

if (globalThis.ArrayBuffer !== NodeArrayBuffer) {
  globalThis.ArrayBuffer = NodeArrayBuffer;
}
if (globalThis.Uint8Array !== NodeUint8Array) {
  globalThis.Uint8Array = NodeUint8Array;
}
