// Tier-2 MimiContent builders — the six surfaced operations (post/reply/edit/delete/react/un-react).
//
// Each mints a fresh CSPRNG salt (crypto.getRandomValues — never Math.random; CLAUDE.md §1) so equal
// bodies still hash distinctly (unlinkability). The structural details of draft-08 MimiContent
// (bare-MessageId references, disposition/language on the NestedPart wrapper, NullPart tombstones) stay
// here so the hook deals only in builders. References (inReplyTo/replaces) are 32-byte content-hashes
// computed by the caller via contentHash(...).

import {
  Cardinality, Disposition, type MimiContent, type SinglePart, type NullPart,
} from "./mimi-content.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

/** 16 bytes of CSPRNG salt. WebCrypto `getRandomValues` is present on web, React Native, and Node ≥ 19. */
function freshSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

/** A SinglePart text body with the given disposition + MIME type. */
function singleText(body: string, disposition: Disposition, contentType: string): SinglePart {
  return { cardinality: Cardinality.Single, disposition, language: "", contentType, content: utf8(body) };
}

/** A NullPart tombstone (delete / un-react). The wrapper still carries disposition + language. */
function nullPart(): NullPart {
  return { cardinality: Cardinality.Null, disposition: Disposition.Render, language: "" };
}

/** The fields shared by every built message (fresh salt; no topic/expiry/extensions). */
function base(): Pick<MimiContent, "salt" | "topicId" | "expires" | "extensions"> {
  return { salt: freshSalt(), topicId: new Uint8Array(), expires: null, extensions: new Map() };
}

/**
 * A plain text post.
 * @param body - The markdown message body.
 * @returns A {@link MimiContent} with a SinglePart `text/markdown` Render body and a fresh salt.
 */
export function buildPost(body: string): MimiContent {
  return { ...base(), replaces: null, inReplyTo: null, nestedPart: singleText(body, Disposition.Render, "text/markdown") };
}

/**
 * A reply to another message.
 * @param body - The reply body.
 * @param targetHash - The replied-to message's 32-byte content-hash (MessageId).
 * @returns A text {@link MimiContent} with `inReplyTo` set to `targetHash`.
 */
export function buildReply(body: string, targetHash: Uint8Array): MimiContent {
  return { ...base(), replaces: null, inReplyTo: targetHash, nestedPart: singleText(body, Disposition.Render, "text/markdown") };
}

/**
 * An edit of an existing message.
 * @param targetHash - The edited message's 32-byte content-hash.
 * @param body - The new body.
 * @returns A text {@link MimiContent} with `replaces` set to `targetHash`.
 */
export function buildEdit(targetHash: Uint8Array, body: string): MimiContent {
  return { ...base(), replaces: targetHash, inReplyTo: null, nestedPart: singleText(body, Disposition.Render, "text/markdown") };
}

/**
 * A delete (tombstone) of an existing message.
 * @param targetHash - The deleted message's 32-byte content-hash.
 * @returns A {@link MimiContent} with `replaces` set and a NullPart body.
 */
export function buildDelete(targetHash: Uint8Array): MimiContent {
  return { ...base(), replaces: targetHash, inReplyTo: null, nestedPart: nullPart() };
}

/**
 * A reaction to a message.
 * @param targetHash - The reacted-to message's 32-byte content-hash.
 * @param token - The reaction token (e.g. an emoji).
 * @returns A {@link MimiContent} with `inReplyTo` set and a Reaction-disposition `text/plain` body.
 */
export function buildReaction(targetHash: Uint8Array, token: string): MimiContent {
  return { ...base(), replaces: null, inReplyTo: targetHash, nestedPart: singleText(token, Disposition.Reaction, "text/plain") };
}

/**
 * An un-react: withdraws one of your own reactions.
 * @param reactionHash - The 32-byte content-hash of YOUR reaction message being withdrawn.
 * @returns A {@link MimiContent} with `replaces` set and a NullPart body.
 */
export function buildUnreact(reactionHash: Uint8Array): MimiContent {
  return { ...base(), replaces: reactionHash, inReplyTo: null, nestedPart: nullPart() };
}
