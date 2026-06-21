// SecureChatRepository — typed façade over a SecureChatStore.
//
// The ONLY place in the SDK that knows the persistence key strings and how each record is
// serialized. Binary fields are base64-wrapped inside JSON; opaque crypto blobs (group/device
// state) are stored as-is. Built by SecureChatProvider over the injected store.

import type { SecureDeviceModel } from "../contract/index.js";
import type { SecureChatStore } from "./store.js";
import { toBase64, fromBase64, utf8ToBytes, bytesToUtf8 } from "../util/base64.js";

const DEVICE_KEY = "device";
const GROUP_PREFIX = "group:";
// Scoped by device ROW id (the server UUID, re-minted on every registration) — NOT the stable client
// deviceId. The delivery cursor must die with the device it belongs to: a wiped/revoked+re-registered
// device gets a new row id ⇒ a new key ⇒ a fresh (null) cursor ⇒ it fetches its inbox from the start
// and receives its own Welcome. A global key let a stale cursor outlive its device and mask the
// Welcome whose `seq` it had already passed (the handshakes query is strictly `seq > since`).
const CURSOR_PREFIX = "handshake:cursor:";
// Decrypted content-frame bytes (`[kind][payload]`), keyed `msg:<conversationId>:<messageId>`
// (messageId is a globally-unique server uuid). This is the durable conversation history: MLS
// application keys are single-use (forward secrecy), so a message can be decrypted exactly once —
// we persist these bytes so reload re-decodes + re-folds from the store instead of replaying the
// (consumed) ratchet. Stored LOCAL ONLY; the blind server never sees it. See store.ts for the
// at-rest posture.
const MESSAGE_PREFIX = "msg:";

/** The persisted device record: stable id, opaque crypto device-state, and the server row. */
export interface PersistedDevice {
  /** Stable MLS device id; survives reload. */
  deviceId: string;
  /** Opaque bytes from `crypto.exportDeviceState()`. */
  deviceState: Uint8Array;
  /** The registered server row (rehydrates UI without a refetch), or `null` if not yet registered. */
  device: SecureDeviceModel | null;
}

interface DeviceRecord {
  deviceId: string;
  deviceState: string; // base64
  device: SecureDeviceModel | null;
}

/** Typed persistence for device identity, per-conversation group state, and the handshake cursor. */
export class SecureChatRepository {
  constructor(private readonly store: SecureChatStore) {}

  /** Load the persisted device record, or `null` if none saved (first run / evicted). */
  async loadDevice(): Promise<PersistedDevice | null> {
    const bytes = await this.store.get(DEVICE_KEY);
    if (!bytes) return null;
    const rec = JSON.parse(bytesToUtf8(bytes)) as DeviceRecord;
    return { deviceId: rec.deviceId, deviceState: fromBase64(rec.deviceState), device: rec.device };
  }

  /** Persist (replace) the device record. */
  async saveDevice(d: PersistedDevice): Promise<void> {
    const rec: DeviceRecord = {
      deviceId: d.deviceId,
      deviceState: toBase64(d.deviceState),
      device: d.device,
    };
    await this.store.set(DEVICE_KEY, utf8ToBytes(JSON.stringify(rec)));
  }

  /** Remove the persisted device record. */
  async clearDevice(): Promise<void> {
    await this.store.delete(DEVICE_KEY);
  }

  /** Load opaque MLS group state for a conversation, or `null` if none. */
  async loadGroupState(conversationId: string): Promise<Uint8Array | null> {
    return this.store.get(GROUP_PREFIX + conversationId);
  }

  /** Persist opaque MLS group state for a conversation. */
  async saveGroupState(conversationId: string, state: Uint8Array): Promise<void> {
    await this.store.set(GROUP_PREFIX + conversationId, state);
  }

  /** Remove persisted group state for a conversation. */
  async deleteGroupState(conversationId: string): Promise<void> {
    await this.store.delete(GROUP_PREFIX + conversationId);
  }

  /** List the conversation ids that have persisted group state. */
  async listGroupConversationIds(): Promise<string[]> {
    const keys = await this.store.list(GROUP_PREFIX);
    return keys.map((k) => k.slice(GROUP_PREFIX.length));
  }

  /**
   * Persist the decrypted content-frame bytes of a message (local-only, decrypt-once history).
   *
   * Stores the `[kind][payload]` frame exactly as decrypted (raw bytes — NOT text): MLS application
   * keys are single-use (forward secrecy), so a message decrypts exactly once; this stored copy is what
   * the hook re-decodes + re-folds on every later reload. The blind server never receives this; it lives
   * only in the platform store (web: IndexedDB; tests: MemoryStore).
   *
   * @param conversationId - The conversation the message belongs to.
   * @param messageId - The globally-unique server message id.
   * @param content - The decrypted content-frame bytes (`[kind][payload]`, post-unpadding).
   */
  async saveMessageContent(conversationId: string, messageId: string, content: Uint8Array): Promise<void> {
    await this.store.set(MESSAGE_PREFIX + conversationId + ":" + messageId, content);
  }

  /**
   * Load a message's previously-decrypted content-frame bytes, or `null` if never stored.
   *
   * A non-null result lets the decrypt path short-circuit BEFORE touching the MLS ratchet — re-decrypting
   * would throw `"Desired gen in the past"` (the key is gone after first use).
   *
   * @param conversationId - The conversation the message belongs to.
   * @param messageId - The globally-unique server message id.
   * @returns The stored content-frame bytes, or `null` on a miss.
   */
  async loadMessageContent(conversationId: string, messageId: string): Promise<Uint8Array | null> {
    return this.store.get(MESSAGE_PREFIX + conversationId + ":" + messageId);
  }

  /** Load this device row's persisted handshake delivery cursor (`seq`), or `null`. */
  async loadHandshakeCursor(deviceRowId: string): Promise<string | null> {
    const bytes = await this.store.get(CURSOR_PREFIX + deviceRowId);
    return bytes ? bytesToUtf8(bytes) : null;
  }

  /** Persist this device row's handshake delivery cursor (`seq`). */
  async saveHandshakeCursor(deviceRowId: string, seq: string): Promise<void> {
    await this.store.set(CURSOR_PREFIX + deviceRowId, utf8ToBytes(seq));
  }

  /** Wipe all persisted secure-chat state (sign-out / device revoke). */
  async clearAll(): Promise<void> {
    const keys = await this.store.list("");
    await Promise.all(keys.map((k) => this.store.delete(k)));
  }
}
