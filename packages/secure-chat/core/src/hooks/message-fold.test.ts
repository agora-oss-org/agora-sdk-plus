// Fold reducer tests — react/edit/delete/un-react fold onto targets; out-of-order (mutation before
// target) buffers then applies; re-fold-on-reload parity. No React, no crypto — pure data in/out.
import { describe, it, expect } from "vitest";
import { MessageFold, type DecodedContentMessage } from "./message-fold.js";
import {
  buildPost, buildReply, buildEdit, buildDelete, buildReaction, buildUnreact,
} from "../content/builders.js";
import { contentHash, type MimiContent } from "../content/mimi-content.js";

let seq = 0;
function msg(mimi: MimiContent, id = "m" + ++seq, createdAt = String(seq).padStart(3, "0")): DecodedContentMessage {
  return { messageId: id, createdAt, senderDeviceId: "dev", contentHash: contentHash(mimi), mimi };
}

describe("MessageFold: base messages", () => {
  it("renders a post and a reply, folds nothing", () => {
    const f = new MessageFold();
    const post = buildPost("hello");
    const r1 = f.apply(msg(post, "m1"));
    expect(r1.renderable).toBe(true);
    expect(f.getContent("m1")?.body).toBe("hello");

    const reply = buildReply("hi back", contentHash(post));
    expect(f.apply(msg(reply, "m2")).renderable).toBe(true);
    expect([...(f.getContent("m2")!.replyTo!)]).toEqual([...contentHash(post)]);
  });
});

describe("MessageFold: mutations fold onto the target (never render standalone)", () => {
  it("an edit rewrites the body and stamps editedAt; the edit msg is not renderable", () => {
    const f = new MessageFold();
    const post = buildPost("typo");
    f.apply(msg(post, "m1", "001"));
    const edit = buildEdit(contentHash(post), "fixed");
    const res = f.apply(msg(edit, "m2", "002"));
    expect(res.renderable).toBe(false);
    expect(f.getContent("m1")?.body).toBe("fixed");
    expect(f.getContent("m1")?.editedAt).toBe("002");
    expect(f.getContent("m2")).toBeNull();
  });
  it("a delete tombstones the target (deleted true, body null)", () => {
    const f = new MessageFold();
    const post = buildPost("oops");
    f.apply(msg(post, "m1"));
    f.apply(msg(buildDelete(contentHash(post)), "m2"));
    expect(f.getContent("m1")?.deleted).toBe(true);
    expect(f.getContent("m1")?.body).toBeNull();
  });
  it("a reaction aggregates onto the target; un-react removes it", () => {
    const f = new MessageFold();
    const post = buildPost("nice");
    f.apply(msg(post, "m1"));
    const react = buildReaction(contentHash(post), "👍");
    f.apply(msg(react, "m2"));
    expect(f.getContent("m1")?.reactions["👍"]).toBe(1);
    f.apply(msg(buildUnreact(contentHash(react)), "m3"));
    expect(f.getContent("m1")?.reactions["👍"]).toBeUndefined();
  });
  it("counts distinct reaction messages with the same token", () => {
    const f = new MessageFold();
    const post = buildPost("nice");
    f.apply(msg(post, "m1"));
    f.apply(msg(buildReaction(contentHash(post), "🔥"), "m2"));
    f.apply(msg(buildReaction(contentHash(post), "🔥"), "m3"));
    expect(f.getContent("m1")?.reactions["🔥"]).toBe(2);
  });
});

describe("MessageFold: out-of-order delivery (buffer, never drop)", () => {
  it("applies a reaction that arrives BEFORE its target", () => {
    const f = new MessageFold();
    const post = buildPost("late");
    const react = buildReaction(contentHash(post), "🎉");
    // reaction first — target unknown → buffered, not rendered, not lost
    expect(f.apply(msg(react, "m2")).renderable).toBe(false);
    // target arrives → reaction folds in
    f.apply(msg(post, "m1"));
    expect(f.getContent("m1")?.reactions["🎉"]).toBe(1);
  });
  it("applies an edit that arrives before its target", () => {
    const f = new MessageFold();
    const post = buildPost("v1");
    const edit = buildEdit(contentHash(post), "v2");
    f.apply(msg(edit, "m2", "002"));
    f.apply(msg(post, "m1", "001"));
    expect(f.getContent("m1")?.body).toBe("v2");
  });
  it("applies an un-react that arrives before the reaction it withdraws", () => {
    const f = new MessageFold();
    const post = buildPost("x");
    const react = buildReaction(contentHash(post), "👀");
    f.apply(msg(post, "m1"));
    f.apply(msg(buildUnreact(contentHash(react)), "m3")); // reaction not seen yet → buffered
    f.apply(msg(react, "m2"));
    expect(f.getContent("m1")?.reactions["👀"]).toBeUndefined(); // net: withdrawn
  });
  it("un-reacts a reaction that was INDEXED-but-buffered (reaction arrived before its post)", () => {
    // Exercises the un-react-before-reaction GUARD: the reaction is indexed (so its hash resolves to a
    // messageId) yet has no reactionReg entry / no rendered row (it is still buffered behind its post).
    // A naive delete path would tombstone nothing and the reaction would survive; the guard must instead
    // buffer the un-react under the reaction's hash so it replays once the reaction folds in.
    const f = new MessageFold();
    const post = buildPost("y");
    const react = buildReaction(contentHash(post), "✨");
    f.apply(msg(react, "m2")); // reaction first: indexed but buffered (post unknown)
    f.apply(msg(buildUnreact(contentHash(react)), "m3")); // un-react: target indexed, no reg yet → guard buffers
    f.apply(msg(post, "m1")); // post lands → reaction folds in → un-react replays → net withdrawn
    expect(f.getContent("m1")?.reactions["✨"]).toBeUndefined();
    expect(f.getContent("m1")?.deleted).toBe(false); // and the post itself was NOT wrongly tombstoned
  });
});

describe("MessageFold: reload parity", () => {
  it("re-applying the same messages in any order yields the same projection", () => {
    const post = buildPost("p");
    const react = buildReaction(contentHash(post), "💜");
    const edit = buildEdit(contentHash(post), "p!");
    const a = new MessageFold();
    [msg(post, "m1", "001"), msg(react, "m2", "002"), msg(edit, "m3", "003")].forEach((m) => a.apply(m));
    const b = new MessageFold();
    [msg(edit, "m3", "003"), msg(react, "m2", "002"), msg(post, "m1", "001")].forEach((m) => b.apply(m));
    expect(a.getContent("m1")).toEqual(b.getContent("m1"));
  });
});
