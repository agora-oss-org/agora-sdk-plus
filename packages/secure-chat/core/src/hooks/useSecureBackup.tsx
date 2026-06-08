// useSecureBackup — passphrase backup + restore of all local key material.
//
// Backup: crypto.exportBackup(passphrase) seals the device identity + every group's state under a
// real argon2id KDF + AEAD; we base64 the blob/nonce at the wire boundary and PUT it to the blind
// server, which stores the ciphertext verbatim (it never sees the passphrase or plaintext).
//
// Restore (fresh browser): GET the blob → crypto.importBackup re-derives the identity + groups in
// memory → re-assert the device server-side (idempotent) to recover its row → persist the device →
// rebind each conversation's group state by conversationId from the server's conversation list (the
// server is the source of truth for membership; the backup itself is conversationId-agnostic). The
// handshake cursor is intentionally left unset so useSecureHandshakes re-pulls from since=0 and
// dedupes — no cursor needs to live in the backup.

import { useCallback, useEffect, useRef, useState } from "react";
import { toBase64, fromBase64 } from "../util/base64.js";
import { useSecureChat } from "../context/secure-chat-context.js";
import {
  estimatePassphraseStrength,
  type PassphraseStrength,
} from "../backup/passphrase-strength.js";

/** State + actions returned by {@link useSecureBackup}. */
export interface UseSecureBackupValues {
  /**
   * Seal all local key material under `passphrase` and upload it to the blind server.
   * @throws {Error} If export or upload fails.
   */
  backup: (passphrase: string) => Promise<void>;
  /**
   * Restore local key material on a fresh client from the server's backup, rehydrating the device and
   * every conversation's group state.
   * @throws {Error} If no backup exists, the passphrase is wrong, or the backup is corrupt.
   */
  restore: (passphrase: string) => Promise<void>;
  /** True while {@link UseSecureBackupValues.backup} is in flight. */
  backingUp: boolean;
  /** True while {@link UseSecureBackupValues.restore} is in flight. */
  restoring: boolean;
  /** The last error thrown by backup or restore, or `null`. */
  error: unknown;
  /** Server `updatedAt` of the most recent successful upload this session, or `null`. */
  lastBackupAt: string | null;
  /** True once a group has advanced since the last backup (membership/epoch change) — prompt a re-backup. */
  needsBackup: boolean;
  /** Coarse client-side passphrase-strength estimate for a meter (see {@link estimatePassphraseStrength}). */
  estimateStrength: (passphrase: string) => PassphraseStrength;
}

/**
 * Manage passphrase backup + restore of the client's secure-chat key material.
 *
 * Backups are explicit (call {@link UseSecureBackupValues.backup}); `needsBackup` flips true when a
 * group advances so the app can prompt. Restore is the fresh-browser recovery path.
 *
 * @returns Backup/restore actions, in-flight + error state, a stale-backup signal, and a passphrase-strength helper.
 * @throws {Error} When used outside a `<SecureChatProvider>`.
 *
 * @example
 * ```tsx
 * const { backup, restore, needsBackup, estimateStrength } = useSecureBackup();
 * await backup(passphrase);            // after registering a device / starting a chat
 * await restore(passphrase);           // on a new browser, before rendering the chat
 * ```
 */
export function useSecureBackup(): UseSecureBackupValues {
  const { crypto, rest, repo, rememberGroup, subscribeGroupChange } = useSecureChat();

  const [backingUp, setBackingUp] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);
  const [needsBackup, setNeedsBackup] = useState(false);

  // A group advancing (a join or a processed Commit) means the on-server backup is now stale.
  // Guard the very first synchronous fire so mount doesn't immediately flag a backup as needed.
  const armed = useRef(false);
  useEffect(() => {
    armed.current = true;
    return subscribeGroupChange(() => {
      if (armed.current) setNeedsBackup(true);
    });
  }, [subscribeGroupChange]);

  const backup = useCallback(
    async (passphrase: string): Promise<void> => {
      setBackingUp(true);
      setError(null);
      try {
        const b = await crypto.exportBackup(passphrase);
        const { updatedAt } = await rest.uploadKeyBackup({
          // base64 at the wire boundary; KDF params (incl. the hex salt) are non-secret metadata.
          blob: toBase64(b.blob),
          nonce: toBase64(b.nonce),
          kdf: b.kdf as "argon2id" | "pbkdf2",
          kdfParams: b.kdfParams,
          cipher: b.cipher as "xchacha20poly1305" | "aes-256-gcm",
          version: b.version,
        });
        setLastBackupAt(updatedAt);
        setNeedsBackup(false);
      } catch (err) {
        setError(err);
        throw err;
      } finally {
        setBackingUp(false);
      }
    },
    [crypto, rest]
  );

  const restore = useCallback(
    async (passphrase: string): Promise<void> => {
      setRestoring(true);
      setError(null);
      try {
        const model = await rest.getKeyBackup();
        if (!model) throw new Error("No key backup found on the server to restore.");

        // Decrypt + repopulate crypto memory (identity + groups). Returns the restored identity.
        const id = await crypto.importBackup(passphrase, {
          blob: fromBase64(model.blob),
          nonce: fromBase64(model.nonce),
          kdf: model.kdf,
          kdfParams: model.kdfParams,
          cipher: model.cipher,
          version: model.version,
        });

        // Re-assert the (already-registered) device to recover its server row — idempotent on
        // (userId, deviceId). The row's id is the senderDeviceId messages need.
        const device = await rest.registerDevice({
          deviceId: id.deviceId,
          signaturePublicKey: toBase64(id.signaturePublicKey),
          credential: toBase64(id.credential),
          ciphersuite: id.ciphersuite,
        });
        await repo.saveDevice({
          deviceId: id.deviceId,
          deviceState: await crypto.exportDeviceState(),
          device,
        });

        // Rebind conversationId → restored group state from the server's conversation list.
        let cursor: string | undefined;
        for (;;) {
          const page = await rest.listConversations(cursor ? { cursor } : undefined);
          for (const c of page.conversations) {
            try {
              await rememberGroup(c.id, {
                mlsGroupId: fromBase64(c.mlsGroupId),
                epoch: BigInt(c.currentEpoch),
              });
            } catch {
              // The group isn't in this backup (created after it, or we're not a member) — skip it.
            }
          }
          if (!page.hasMore || page.conversations.length === 0) break;
          const last = page.conversations[page.conversations.length - 1]!;
          cursor = last.lastMessageAt ?? last.createdAt;
        }

        setNeedsBackup(false);
      } catch (err) {
        setError(err);
        throw err;
      } finally {
        setRestoring(false);
      }
    },
    [crypto, rest, repo, rememberGroup]
  );

  return {
    backup,
    restore,
    backingUp,
    restoring,
    error,
    lastBackupAt,
    needsBackup,
    estimateStrength: estimatePassphraseStrength,
  };
}
