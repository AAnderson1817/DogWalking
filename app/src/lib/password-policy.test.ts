import { describe, expect, it } from "vitest";
import { PASSWORD_MIN_LENGTH, passwordPolicyProblem } from "./password-policy";

/**
 * Behaviour of the courtesy check. The other half — that these constants
 * still agree with `supabase/config.toml` — is
 * `scripts/password-policy.test.ts`, which needs to read a file off disk and
 * so belongs in the node project with the other text-analysis checks.
 */
describe("passwordPolicyProblem", () => {
  it("says nothing about an empty field", () => {
    // The disabled submit button covers "you have not typed anything yet".
    expect(passwordPolicyProblem("")).toBeNull();
  });

  it("accepts a password that meets every requirement", () => {
    expect(passwordPolicyProblem("Correct-Horse-9")).toBeNull();
  });

  it("accepts a passphrase with no symbols", () => {
    // `lower_upper_letters_digits` asks for three character classes and says
    // nothing about punctuation. A rule stricter than the server's would
    // refuse a password the server would have taken.
    expect(passwordPolicyProblem("Staplebattery7")).toBeNull();
  });

  it("reports length before composition", () => {
    expect(passwordPolicyProblem("Ab1")).toBe("Use at least 12 characters.");
  });

  it.each([
    ["ALLUPPERCASE123", "Add a lowercase letter."],
    ["alllowercase123", "Add an uppercase letter."],
    ["NoDigitsInHere", "Add a digit."],
  ])("names the missing class in %s", (password, expected) => {
    expect(passwordPolicyProblem(password)).toBe(expected);
  });

  it("never rejects on length a password the server would accept", () => {
    // The direction that matters: this check must be no stricter than the
    // server. A client rule that refuses a valid password locks somebody out
    // of their own account with no way to tell it is the client's fault.
    const atFloor = "Aa1" + "b".repeat(PASSWORD_MIN_LENGTH - 3);
    expect(atFloor.length).toBe(PASSWORD_MIN_LENGTH);
    expect(passwordPolicyProblem(atFloor)).toBeNull();
  });
});
