import { describe, expect, it, vi } from "vitest";
import {
  CLIPBOARD_SCRUB,
  makeSecretClipboard,
  shouldClearClipboard,
  type ClipboardPort,
} from "./clipboard";

/**
 * Review L2. The vault advertises a 30-second auto-clear, and it applies only
 * to the copy on screen — the copy that leaves the app persists in the OS
 * pasteboard, readable by the next foregrounded app and synced to the
 * operator's other devices.
 *
 * The scrub is best-effort and the UI says so, which makes it exactly the kind
 * of thing that quietly stops working: nobody notices a clear that did not
 * happen. So each rule is a test.
 */

function port(over: Partial<ClipboardPort> = {}) {
  const writes: string[] = [];
  const p: ClipboardPort = {
    writeText: vi.fn(async (t: string) => { writes.push(t); }),
    hasFocus: () => true,
    ...over,
  };
  return { p, writes };
}

describe("shouldClearClipboard", () => {
  it("clears only what we put there", () => {
    // We cannot READ the clipboard to check — that needs a permission prompt
    // this would fail — so the whole design rests on remembering that we wrote
    // a secret. Scrubbing without that flag would delete whatever the operator
    // had copied from somewhere else.
    expect(shouldClearClipboard({ copied: false, focused: true })).toBe(false);
  });

  it("does not attempt a write while the document is unfocused", () => {
    // A background tab's write is refused by the browser, and on some engines
    // the rejection is SILENT — which would leave the flag cleared and the
    // secret still on the pasteboard, while every observable said it worked.
    expect(shouldClearClipboard({ copied: true, focused: false })).toBe(false);
  });

  it("clears when we wrote a secret and can still write", () => {
    expect(shouldClearClipboard({ copied: true, focused: true })).toBe(true);
  });
});

describe("makeSecretClipboard", () => {
  it("overwrites with a space, not an empty string", () => {
    // `writeText("")` is a no-op in several implementations and leaves the
    // previous contents in place — a scrub that reports success and scrubs
    // nothing.
    expect(CLIPBOARD_SCRUB).not.toBe("");
    expect(CLIPBOARD_SCRUB.length).toBeGreaterThan(0);
  });

  it("copies, then clears once", async () => {
    const { p, writes } = port();
    const c = makeSecretClipboard(p);
    await c.copy("4821#");
    expect(c.holdsSecret).toBe(true);
    expect(await c.clear()).toBe(true);
    expect(writes).toEqual(["4821#", CLIPBOARD_SCRUB]);
    expect(c.holdsSecret).toBe(false);

    // A second clear must not fire: by then the operator may have copied
    // something of their own.
    expect(await c.clear()).toBe(false);
    expect(writes).toHaveLength(2);
  });

  it("does not clear a clipboard it never wrote to", async () => {
    const { p, writes } = port();
    expect(await makeSecretClipboard(p).clear()).toBe(false);
    expect(writes).toEqual([]);
  });

  it("skips the clear when the document lost focus, and stays armed", async () => {
    let focused = true;
    const { p, writes } = port({ hasFocus: () => focused });
    const c = makeSecretClipboard(p);
    await c.copy("4821#");
    focused = false;
    expect(await c.clear()).toBe(false);
    expect(writes).toEqual(["4821#"]);
    // Still armed: the operator switching back is the moment it can work.
    expect(c.holdsSecret).toBe(true);
    focused = true;
    expect(await c.clear()).toBe(true);
  });

  it("resolves rather than throwing when the write is refused", async () => {
    // A failed clear must never surface as an error over a door code somebody
    // is reading on a doorstep — there is nothing they could do about it.
    const { p } = port({ writeText: vi.fn(async () => { throw new Error("NotAllowedError"); }) });
    const c = makeSecretClipboard(p);
    await expect(c.copy("x")).rejects.toThrow();
    expect(await c.clear()).toBe(false);
  });

  it("stays armed when the scrub itself fails", async () => {
    // The dangerous version clears the flag in a `finally`: the secret is
    // still on the pasteboard and nothing will ever try again.
    let fail = true;
    const { p } = port({
      writeText: vi.fn(async () => { if (fail) throw new Error("NotAllowedError"); }),
    });
    const c = makeSecretClipboard(p);
    fail = false;
    await c.copy("4821#");
    fail = true;
    expect(await c.clear()).toBe(false);
    expect(c.holdsSecret).toBe(true);
  });
});
