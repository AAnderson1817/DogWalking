import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `scripts/check-auth-posture.sh` compares a project's live auth config against
 * the posture in `docs/dev/auth-posture.md`.
 *
 * It exists as a script, rather than as bash inside `staging-smoke.yml`, for
 * one reason: the inline version could not be exercised by anything. It ran for
 * the first time long after it was written — every staging-smoke run in between
 * was `skipped` — and when it finally ran it reported a failure that could not
 * be acted on, because `jq '.k // false'` renders an ABSENT key and a false one
 * identically.
 *
 * That distinction is the whole point of this suite. One case is "flip a
 * dashboard toggle"; the other is "this script names a key that does not
 * exist, and no dashboard change will ever satisfy it". A gate that cannot be
 * satisfied is worse than no gate, because it teaches everyone to ignore red.
 */

const SCRIPT = resolve(__dirname, "..", "..", "scripts", "check-auth-posture.sh");

/** A project matching every value docs/dev/auth-posture.md asks for. */
const compliant = {
  secure_password_change_enabled: true,
  password_min_length: 12,
  password_required_characters: "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
  sessions_timebox: 0,
  sessions_inactivity_timeout: 0,
  mfa_totp_enroll_enabled: true,
  mfa_totp_verify_enabled: true,
};

/**
 * What staging actually returned the first time this check ever ran. Kept
 * verbatim as a fixture so a future change is measured against a real response
 * rather than an idealised one — including the SMTP key, because "never print
 * the whole body" is a rule with a test below.
 */
const liveStaging = {
  password_min_length: 6,
  password_required_characters: null,
  sessions_timebox: 0,
  sessions_inactivity_timeout: 0,
  mfa_totp_enroll_enabled: true,
  mfa_totp_verify_enabled: true,
  disable_signup: false,
  jwt_exp: 3600,
  refresh_token_rotation_enabled: true,
  mailer_secure_email_change_enabled: true,
  smtp_pass: "correct-horse-battery-staple",
};

function run(config: Record<string, unknown>): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "auth-posture-"));
  const file = join(dir, "auth.json");
  writeFileSync(file, JSON.stringify(config));
  try {
    const out = execFileSync(SCRIPT, [file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("check-auth-posture", () => {
  it("passes a project that matches the intended posture", () => {
    const { code, out } = run(compliant);
    expect(out).toContain("AUTH POSTURE PASS");
    expect(code).toBe(0);
  });

  /**
   * The bug this script was written for. Both of these fail, and they must
   * fail with DIFFERENT text, because they have different fixes.
   */
  it("distinguishes a key that is off from a key that is absent", () => {
    const off = run({ ...compliant, secure_password_change_enabled: false });
    expect(off.code).toBe(1);
    expect(off.out).toContain("secure_password_change is OFF");
    expect(off.out).not.toContain("cannot be checked");

    const { secure_password_change_enabled: _drop, ...absent } = compliant;
    const missing = run(absent);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("cannot be checked");
    expect(missing.out).toContain("no key 'secure_password_change_enabled'");
    // The half that makes it actionable: it must say a dashboard change
    // cannot help, or the reader goes and flips a toggle for nothing.
    expect(missing.out).toMatch(/no dashboard change/i);
    expect(missing.out).not.toContain("secure_password_change is OFF");
  });

  /** Present-but-null is what an unset boolean looks like. Say so. */
  it("reports a present null as present, not as absent", () => {
    const { out, code } = run({ ...compliant, secure_password_change_enabled: null });
    expect(code).toBe(1);
    expect(out).toContain("secure_password_change is OFF");
    expect(out).toContain("null (present, unset)");
    expect(out).not.toContain("cannot be checked");
  });

  /**
   * An absent key is only actionable if the log says what the API DID return —
   * otherwise the reader has to fetch the config by hand to find the right
   * spelling, which is the moment they give up on the gate.
   */
  it("names related keys from the response when one is missing", () => {
    const { secure_password_change_enabled: _drop, ...absent } = compliant;
    const { out } = run({ ...absent, mailer_secure_email_change_enabled: true });
    expect(out).toContain("mailer_secure_email_change_enabled");
  });

  it("fails a password floor under 12 and reports the live value", () => {
    const { code, out } = run({ ...compliant, password_min_length: 6 });
    expect(code).toBe(1);
    expect(out).toContain("Password floor is 6, below 12");
  });

  it("treats a non-numeric password floor as a shape change, not as compliant", () => {
    const { code, out } = run({ ...compliant, password_min_length: "twelve" });
    expect(code).toBe(1);
    expect(out).toContain("is not a number");
  });

  /** Warnings must not turn the gate red — that was a deliberate decision. */
  it("warns without failing on an unset timebox and inactivity timeout", () => {
    const { code, out } = run(compliant);
    expect(code).toBe(0);
    expect(out).toContain("::warning title=No session timebox");
    expect(out).toContain("::warning title=No inactivity timeout");
  });

  /**
   * A timebox caps session age; GoTrue only demands reauthentication for a
   * password change once a session is older than 24h. Set the timebox at or
   * under 24h and `secure_password_change` can never fire again.
   */
  it("flags the timebox/secure_password_change interaction only once the timebox is set", () => {
    const quiet = run(compliant); // timebox 0
    expect(quiet.out).not.toContain("now inert");

    const boxed = run({ ...compliant, sessions_timebox: 43200 }); // 12h
    expect(boxed.code).toBe(0);
    expect(boxed.out).toContain("now inert");
    expect(boxed.out).toMatch(/aal2/);

    // Above 24h a session can outlive the window, so the setting still works.
    const long = run({ ...compliant, sessions_timebox: 172800 }); // 48h
    expect(long.out).not.toContain("now inert");
  });

  /**
   * `/config/auth` carries SMTP credentials and external provider secrets.
   * Whatever this script prints, it is not the response body.
   */
  it("never prints a secret from the response, even when reporting failures", () => {
    const { out } = run(liveStaging);
    expect(out).not.toContain("correct-horse-battery-staple");
    expect(out).not.toContain("smtp_pass");
  });

  /** The real staging response: two fatals, and TOTP reported as on. */
  it("reproduces the live staging verdict", () => {
    const { code, out } = run(liveStaging);
    expect(code).toBe(1);
    expect(out).toContain("Password floor is 6, below 12");
    expect(out).toContain("secure_password_change");
    expect(out).toContain("ok    TOTP verification is on");
    expect(out).toContain("AUTH POSTURE FAIL");
  });

  it("refuses a response that is not a JSON object rather than passing it", () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-posture-"));
    const file = join(dir, "auth.json");
    writeFileSync(file, "<html>gateway timeout</html>");
    let code = 0;
    let out = "";
    try {
      out = execFileSync(SCRIPT, [file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      code = err.status ?? -1;
      out = err.stdout ?? "";
    }
    expect(code).toBe(1);
    expect(out).toContain("not a JSON object");
  });
});
