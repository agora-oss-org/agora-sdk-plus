import { describe, it, expect } from "vitest";
import { buildPost, buildReply, buildEdit, buildDelete, buildReaction, buildUnreact } from "./builders.js";
import { Cardinality, Disposition, type SinglePart } from "./mimi-content.js";

const text = (c: { nestedPart: unknown }) =>
  new TextDecoder().decode((c.nestedPart as SinglePart).content);

describe("content builders (draft-08 shape)", () => {
  it("buildPost: SinglePart text/markdown, Render disposition, fresh 16-byte salt, no refs", () => {
    const c = buildPost("hi 💜");
    expect(c.salt.length).toBe(16);
    expect(c.replaces).toBeNull();
    expect(c.inReplyTo).toBeNull();
    expect(c.expires).toBeNull();
    expect(c.nestedPart.cardinality).toBe(Cardinality.Single);
    expect((c.nestedPart as SinglePart).disposition).toBe(Disposition.Render);
    expect((c.nestedPart as SinglePart).contentType).toBe("text/markdown");
    expect(text(c)).toBe("hi 💜");
  });
  it("buildPost: two calls have different salts (CSPRNG)", () => {
    expect([...buildPost("x").salt]).not.toEqual([...buildPost("x").salt]);
  });
  it("buildReply: inReplyTo is the bare target hash (Uint8Array), body preserved", () => {
    const c = buildReply("re", new Uint8Array([1, 2]));
    expect([...(c.inReplyTo!)]).toEqual([1, 2]);
    expect(c.replaces).toBeNull();
    expect(text(c)).toBe("re");
  });
  it("buildEdit: replaces set (bare hash), body replaced", () => {
    const c = buildEdit(new Uint8Array([9]), "fixed");
    expect([...(c.replaces!)]).toEqual([9]);
    expect(c.inReplyTo).toBeNull();
    expect(text(c)).toBe("fixed");
  });
  it("buildDelete: replaces set, NullPart tombstone (carries disposition+language)", () => {
    const c = buildDelete(new Uint8Array([9]));
    expect([...(c.replaces!)]).toEqual([9]);
    expect(c.nestedPart.cardinality).toBe(Cardinality.Null);
    expect((c.nestedPart as { disposition: number }).disposition).toBe(Disposition.Render);
    expect((c.nestedPart as { language: string }).language).toBe("");
  });
  it("buildReaction: inReplyTo target, Reaction disposition, text/plain token body", () => {
    const c = buildReaction(new Uint8Array([5]), "👍");
    expect([...(c.inReplyTo!)]).toEqual([5]);
    expect((c.nestedPart as SinglePart).disposition).toBe(Disposition.Reaction);
    expect((c.nestedPart as SinglePart).contentType).toBe("text/plain");
    expect(text(c)).toBe("👍");
  });
  it("buildUnreact: replaces the reaction hash with a NullPart", () => {
    const c = buildUnreact(new Uint8Array([5]));
    expect([...(c.replaces!)]).toEqual([5]);
    expect(c.nestedPart.cardinality).toBe(Cardinality.Null);
  });
});
