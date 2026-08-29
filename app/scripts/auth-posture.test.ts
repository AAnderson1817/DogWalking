import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * Key names the live Management API actually returns.
 *
 * Captured from the `Read back the deployed auth settings` job on run
 * 33278632974 (2026-08-29), which printed them because the script had asked for
 * a key that does not exist. It is the response's own key list filtered to
 * names matching `secure|password|change|enabled`, so it is not the whole
 * response — but it is exhaustive for every key this check cares about, which
 * is what the coverage test below needs.
 *
 * This list is the fixture's *shape*. Values are set per-case; names are never
 * invented, which is the entire point — see the header comment.
 */
const LIVE_KEYS = [
  "mailer_secure_email_change_enabled",
  "mailer_notifications_password_changed_enabled",
  "mfa_phone_enroll_enabled",
  "mfa_phone_verify_enabled",
  "mfa_totp_enroll_enabled",
  "mfa_totp_verify_enabled",
  "mfa_web_authn_enroll_enabled",
  "mfa_web_authn_verify_enabled",
  "password_hibp_enabled",
  "password_min_length",
  "password_required_characters",
  "refresh_token_rotation_enabled",
  "security_captcha_enabled",
  "security_manual_linking_enabled",
  "security_update_password_require_current_password",
  "security_update_password_require_reauthentication",
] as const;

/**
 * A project matching every value docs/dev/auth-posture.md asks for.
 *
 * **Derived from the live key set, never written by hand.** The defect this
 * file now guards against was a `compliant` fixture invented from the same
 * wrong assumption as the script: both named `secure_password_change_enabled`,
 * a key the Management API has never returned. The suite was green while the
 * gate was permanently red in CI, because the one fixture captured from reality
 * was only ever used on the failure paths.
 *
 * A test cannot catch an error it shares with the code. So the pass-path
 * fixture is built by starting from real key names and overriding values.
 */
const compliant: Record<string, unknown> = {
  ...Object.fromEntries(LIVE_KEYS.map((k) => [k, false])),
  security_update_password_require_current_password: true,
  security_update_password_require_reauthentication: true,
  password_min_length: 12,
  password_required_characters: "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
  sessions_timebox: 0,
  sessions_inactivity_timeout: 0,
  mfa_totp_enroll_enabled: true,
  mfa_totp_verify_enabled: true,
};

/**
 * What staging actually returned. Kept as a fixture so a future change is
 * measured against a real response rather than an idealised one — including the
 * SMTP key, because "never print the whole body" is a rule with a test below.
 *
 * The two `security_update_password_*` values are **unknown**: the run that
 * captured this list failed before reading them, because the script was asking
 * for a different name. They are `null` here rather than guessed, and the next
 * staging run is what fills them in.
 */
const liveStaging: Record<string, unknown> = {
  ...Object.fromEntries(LIVE_KEYS.map((k) => [k, false])),
  password_min_length: 6,
  password_required_characters: null,
  security_update_password_require_current_password: null,
  security_update_password_require_reauthentication: null,
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
   * **The test that would have caught the defect this file now documents.**
   *
   * Every key the script names must be a key the live API actually returns.
   * The script shipped asking for `secure_password_change_enabled`, which the
   * Management API has never had, so the gate was unsatisfiable by any
   * dashboard change and CI's staging-smoke job was red on every run from the
   * day it landed. Nothing here noticed, because the fixture asserting the pass
   * path was invented with the same wrong name.
   *
   * Parsing the script rather than restating its key list is load-bearing: a
   * hand-written copy of the list is a third place to make the same mistake.
   */
  it("names only keys the live API actually returns", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const uncommented = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    const named = new Set(
      [...uncommented.matchAll(/^\s*(?:require_true|require_at_least|warn_unless_set|warn_unless_true)\s+([a-z0-9_]+)/gm)]
        .map((m) => m[1] as string),
    );
    // `require_true_any` takes its keys last, one bare identifier per
    // continuation line. Anchored on a CALL — `require_true_any "Label"` — and
    // bounded by the backslash continuation, because a looser `[\s\S]*?` walks
    // straight into the function's own definition and collects `return`, `fi`
    // and `done` as if they were API keys. (It did.)
    const lines = uncommented.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*require_true_any\s+"/.test(lines[i] ?? "")) continue;
      let j = i;
      while (j < lines.length && /\\\s*$/.test(lines[j] ?? "")) j++;
      for (let k = i; k <= j && k < lines.length; k++) {
        const m = /^\s*([a-z0-9_]+)\s*\\?\s*$/.exec(lines[k] ?? "");
        if (m?.[1]) named.add(m[1]);
      }
    }
    expect(named.size).toBeGreaterThan(3); // the parser found something
    const live = new Set<string>([...LIVE_KEYS, "sessions_timebox", "sessions_inactivity_timeout"]);
    expect([...named].filter((k) => !live.has(k))).toEqual([]);
  });

  /**
   * The bug this script was written for. Both of these fail, and they must
   * fail with DIFFERENT text, because they have different fixes.
   */
  it("distinguishes a key that is off from a key that is absent", () => {
    const off = run({
      ...compliant,
      security_update_password_require_current_password: false,
      security_update_password_require_reauthentication: false,
    });
    expect(off.code).toBe(1);
    expect(off.out).toContain("Secure password change is OFF");
    expect(off.out).not.toContain("cannot be checked");

    const {
      security_update_password_require_current_password: _a,
      security_update_password_require_reauthentication: _b,
      ...absent
    } = compliant;
    const missing = run(absent);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("cannot be checked");
    // The half that makes it actionable: it must say a dashboard change
    // cannot help, or the reader goes and flips a toggle for nothing.
    expect(missing.out).toMatch(/no dashboard change/i);
    expect(missing.out).not.toContain("Secure password change is OFF");
  });

  /**
   * The two keys are not equivalent — `require_current_password` closes the
   * exploit, `require_reauthentication` only narrows it — so the log has to say
   * which one it is relying on.
   */
  it("passes on either key alone, and names the one it found", () => {
    const viaCurrent = run({
      ...compliant,
      security_update_password_require_reauthentication: false,
    });
    expect(viaCurrent.code).toBe(0);
    expect(viaCurrent.out).toContain("via security_update_password_require_current_password");

    const viaReauth = run({
      ...compliant,
      security_update_password_require_current_password: false,
    });
    expect(viaReauth.code).toBe(0);
    expect(viaReauth.out).toContain("via security_update_password_require_reauthentication");
  });

  /** Present-but-null is what an unset boolean looks like. Say so. */
  it("reports a present null as present, not as absent", () => {
    const { out, code } = run({
      ...compliant,
      security_update_password_require_current_password: null,
      security_update_password_require_reauthentication: null,
    });
    expect(code).toBe(1);
    expect(out).toContain("Secure password change is OFF");
    expect(out).toContain("null (present, unset)");
    expect(out).not.toContain("cannot be checked");
  });

  /**
   * An absent key is only actionable if the log says what the API DID return —
   * otherwise the reader has to fetch the config by hand to find the right
   * spelling, which is the moment they give up on the gate.
   */
  it("names related keys from the response when one is missing", () => {
    const {
      security_update_password_require_current_password: _a,
      security_update_password_require_reauthentication: _b,
      ...absent
    } = compliant;
    const { out } = run({ ...absent, security_manual_linking_enabled: true });
    expect(out).toContain("security_manual_linking_enabled");
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
    expect(out).toContain("Secure password change");
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
