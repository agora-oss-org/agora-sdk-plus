// Maps the wire contract's numeric MLS ciphersuite id (RFC 9420 / IANA) to ts-mls's string name and
// back, owns the suite-1 default, and loads a usable CiphersuiteImpl. One place so adding a suite is a
// one-line change and an unknown id fails closed rather than silently picking a wrong suite.
import {
  ciphersuites,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  type CiphersuiteName,
  type CiphersuiteImpl,
} from "ts-mls";

/** RFC 9420 mandatory-to-implement baseline; our default. */
export const DEFAULT_CIPHERSUITE_ID = 1 as const;

// Invert ts-mls's name→id constant once.
const ID_TO_NAME = new Map<number, CiphersuiteName>(
  (Object.entries(ciphersuites) as [CiphersuiteName, number][]).map(([name, id]) => [id, name])
);

/**
 * Resolve a ts-mls suite name from a numeric contract id.
 *
 * @param id - The numeric MLS ciphersuite id (RFC 9420).
 * @returns The ts-mls suite name.
 * @throws {Error} When the id is not a supported ciphersuite.
 */
export function ciphersuiteNameFromId(id: number): CiphersuiteName {
  const name = ID_TO_NAME.get(id);
  if (!name) throw new Error(`secure-chat: unsupported MLS ciphersuite id ${id}`);
  return name;
}

/**
 * Resolve the numeric contract id from a ts-mls suite name.
 *
 * @param name - The ts-mls suite name.
 * @returns The numeric MLS ciphersuite id.
 */
export function ciphersuiteIdFromName(name: CiphersuiteName): number {
  return ciphersuites[name];
}

/**
 * Load a ready {@link CiphersuiteImpl} (the crypto primitives) for a numeric ciphersuite id.
 *
 * @param id - The numeric MLS ciphersuite id (RFC 9420).
 * @returns The ciphersuite implementation (hash/signature/hpke/kdf/rng).
 * @throws {Error} When the id is not a supported ciphersuite.
 */
export function loadCiphersuite(id: number): Promise<CiphersuiteImpl> {
  return getCiphersuiteImpl(getCiphersuiteFromName(ciphersuiteNameFromId(id)));
}
