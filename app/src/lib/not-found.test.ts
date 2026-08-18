import { describe, expect, it } from "vitest";
import { isNotFound } from "./api";

/**
 * Review M39. `ClientDetail` is the destination of the Clients tab and it
 * rendered "Client not found" for EVERY failure, with the raw error as the
 * hint and no retry — so an operator on a weak connection outside a client's
 * door was told the client did not exist, under a string like "JWT expired",
 * with nothing to press.
 *
 * The distinction has to be exact in one direction: anything not proven to be
 * a genuine absence must fall through to the retryable screen. Getting it
 * wrong the other way costs a wasted tap; getting it wrong this way is a dead
 * end on an installed PWA.
 */
describe("isNotFound", () => {
  it("recognises PostgREST's no-rows code on the error object", () => {
    expect(isNotFound({ code: "PGRST116", message: "JSON object requested" })).toBe(true);
  });

  it("recognises it when the code has been folded into the message", () => {
    // `must()` in api.ts rethrows some failures as a plain Error, so the
    // structured code is not always still there to read.
    expect(isNotFound(new Error("PGRST116: no rows returned"))).toBe(true);
  });

  it("does not call a dropped connection a missing client", () => {
    expect(isNotFound(new TypeError("Failed to fetch"))).toBe(false);
  });

  it("does not call an expired session a missing client", () => {
    expect(isNotFound({ code: "PGRST301", message: "JWT expired" })).toBe(false);
  });

  it("does not call a server error a missing client", () => {
    expect(isNotFound(new Error("Internal Server Error"))).toBe(false);
  });

  it("is safe on the things a catch block actually receives", () => {
    for (const value of [null, undefined, "", 0, {}, [], new Error("")]) {
      expect(isNotFound(value)).toBe(false);
    }
  });
});
