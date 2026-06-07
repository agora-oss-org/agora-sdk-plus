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
const CURSOR_KEY = "handshake:cursor";

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

  /** Load the persisted handshake delivery cursor (`seq`), or `null`. */
  async loadHandshakeCursor(): Promise<string | null> {
    const bytes = await this.store.get(CURSOR_KEY);
    return bytes ? bytesToUtf8(bytes) : null;
  }

  /** Persist the handshake delivery cursor (`seq`). */
  async saveHandshakeCursor(seq: string): Promise<void> {
    await this.store.set(CURSOR_KEY, utf8ToBytes(seq));
  }

  /** Wipe all persisted secure-chat state (sign-out / device revoke). */
  async clearAll(): Promise<void> {
    const keys = await this.store.list("");
    await Promise.all(keys.map((k) => this.store.delete(k)));
  }
}
