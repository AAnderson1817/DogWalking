import { describe, expect, it } from "vitest";
import { unwrapEdgeResult } from "./api";

// The SDK's fixed message for any non-2xx (@supabase/functions-js
// types.js:73-76). Every edge failure in the product used to surface exactly
// this, for all nine call sites.
const SDK_MESSAGE = "Edge Function returned a non-2xx status code";

function httpError(envelope: unknown) {
  return {
    data: null,
    error: { message: SDK_MESSAGE },
    response: { json: () => Promise.resolve(envelope) },
  };
}

describe("unwrapEdgeResult", () => {
  it("returns the payload on success", async () => {
    await expect(
      unwrapEdgeResult("complete-walk", { data: { ok: true, data: { billed: true } } }),
    ).resolves.toEqual({ billed: true });
  });

  it("surfaces the envelope's message on a non-2xx, not the SDK's", async () => {
    // The assertion that matters. A test that only checks "it throws" passes
    // against the bug AND against a fix that is a no-op, which is how the
    // first attempt at this fix got as far as being published.
    await expect(
      unwrapEdgeResult(
        "credential-vault",
        httpError({ ok: false, error: { code: "key_unknown", message: "this credential was encrypted with a key this deployment does not hold" } }),
      ),
    ).rejects.toThrow("this credential was encrypted with a key this deployment does not hold");
  });

  it("does not leak the SDK's message when a real reason exists", async () => {
    await expect(
      unwrapEdgeResult("charge-overage", httpError({ ok: false, error: { code: "card_declined", message: "The card was declined." } })),
    ).rejects.toThrow(/^The card was declined\.$/);
  });

  it("falls back to the SDK message when the body is not JSON", async () => {
    // The branch the catch legitimately serves — a gateway 502 with an HTML
    // body. Masking that with a parse error would be worse than the original.
    await expect(
      unwrapEdgeResult("change-plan", {
        data: null,
        error: { message: SDK_MESSAGE },
        response: { json: () => Promise.reject(new SyntaxError("Unexpected token <")) },
      }),
    ).rejects.toThrow(SDK_MESSAGE);
  });

  it("falls back when there is no response at all (network error)", async () => {
    await expect(
      unwrapEdgeResult("billing-portal", { data: null, error: { message: "Failed to fetch" } }),
    ).rejects.toThrow("Failed to fetch");
  });

  it("falls back when the envelope carries no message", async () => {
    await expect(
      unwrapEdgeResult("materialize-walks", httpError({ ok: false })),
    ).rejects.toThrow(SDK_MESSAGE);
    await expect(
      unwrapEdgeResult("materialize-walks", httpError({ ok: false, error: { code: "x", message: "   " } })),
    ).rejects.toThrow(SDK_MESSAGE);
  });

  it("still reports a 2xx envelope that is not ok", async () => {
    await expect(
      unwrapEdgeResult("complete-walk", { data: { ok: false, error: { code: "already", message: "walk already completed" } } }),
    ).rejects.toThrow("walk already completed");
  });

  it("names the function when a 2xx envelope is malformed", async () => {
    await expect(unwrapEdgeResult("create-checkout", { data: { ok: true } })).rejects.toThrow(
      "create-checkout failed",
    );
  });
});
