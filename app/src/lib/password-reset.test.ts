import { describe, expect, it } from "vitest";
import { describeResetOutcome, resetRedirectUrl } from "./password-reset";

const EMAIL = "sam@sanpo.test";

describe("resetRedirectUrl", () => {
  it("builds the return URL from the current origin", () => {
    expect(resetRedirectUrl("https://app.sanpo.example")).toBe(
      "https://app.sanpo.example/reset-password",
    );
  });

  it("does not double the slash on an origin that has one", () => {
    // `location.origin` never has a trailing slash, but a configured base URL
    // read from an env var routinely does, and a `//reset-password` path does
    // not match the redirect allow-list Supabase checks.
    expect(resetRedirectUrl("https://app.sanpo.example/")).toBe(
      "https://app.sanpo.example/reset-password",
    );
  });
});

describe("describeResetOutcome", () => {
  it("confirms when the request succeeded", () => {
    const out = describeResetOutcome(null, EMAIL);
    expect(out.tone).toBe("success");
    expect(out.message).toContain(EMAIL);
  });

  it("says the same thing when the address has no account", () => {
    // The finding this function exists for. GoTrue may answer a 400 for an
    // unknown address; repeating that on screen turns the form into a way of
    // asking "is this person a Sanpo customer?".
    const unknown = describeResetOutcome(
      { status: 400, message: "User not found" },
      EMAIL,
    );
    expect(unknown).toEqual(describeResetOutcome(null, EMAIL));
    expect(unknown.message).not.toContain("not found");
  });

  it("collapses an unrecognised status into the neutral confirmation", () => {
    // The default is closed, not open: a status this code has never seen must
    // not disclose anything by not having been thought about.
    const out = describeResetOutcome({ status: 418, message: "teapot" }, EMAIL);
    expect(out.tone).toBe("success");
    expect(out.message).not.toContain("teapot");
  });

  it("surfaces a rate limit, because waiting is something you can act on", () => {
    const out = describeResetOutcome(
      { status: 429, message: "For security purposes, you can only request this after 51 seconds." },
      EMAIL,
    );
    expect(out.tone).toBe("error");
    expect(out.message).toContain("51 seconds");
  });

  it("surfaces a transport failure rather than promising an email", () => {
    // A network error carries no status. Claiming the link is on its way costs
    // somebody an hour of waiting for a message nothing ever requested.
    const out = describeResetOutcome({ message: "Failed to fetch" }, EMAIL);
    expect(out.tone).toBe("error");
    expect(out.message).toContain("connection");
  });

  it("never leaks the account's own address back on an error path", () => {
    // Both error branches are about the request, so neither needs the address
    // — and an error message that echoes it is the shape that gets copied into
    // a screenshot.
    for (const err of [{ status: 429, message: "slow down" }, { message: "Failed to fetch" }]) {
      expect(describeResetOutcome(err, EMAIL).message).not.toContain(EMAIL);
    }
  });
});
