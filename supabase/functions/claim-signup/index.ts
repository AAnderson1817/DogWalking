// claim-signup — POST, PUBLIC (verify_jwt = false in supabase/config.toml;
// review H31). Creates the auth account for an invited client AFTER
// validating the invite server-side, so ClaimInvite stops depending on
// public `supabase.auth.signUp` and the GoTrue signup toggle becomes
// something the owner can actually turn off.
//
// Auth surface, deliberately: no JWT is read anywhere in this function (its
// caller does not have one yet — creating the account is the point), and
// none of the unverified-claim helpers (isServiceAuth, sessionAssurance) may
// ever be used here, because with verify_jwt off the gateway verifies
// nothing. The only privileged object is the service-role client, used for
// exactly two calls whose inputs are validated first.
//
// Abuse bound: an account can only be created by presenting a LIVE invite
// token (unguessable uuid, 14-day expiry, revocable — 0039), and a token
// bound to an email admits only that email. That is strictly narrower than
// what this function replaces, which was public signup with no token at all.
import { jsonOk, readJson, serveFunction } from "../_lib/http.ts";
import { HttpError } from "../_lib/http.ts";
import { adminClient } from "../_lib/admin.ts";
import { type ClaimSignupDeps, handleClaimSignup } from "./handler.ts";

function makeDeps(): ClaimSignupDeps {
  const db = adminClient();
  return {
    async checkInvite(token, email) {
      const { data, error } = await db.rpc("fn_invite_signup_check", {
        p_token: token,
        p_email: email,
      });
      if (error) {
        throw new HttpError(500, "db_error", "invite check failed", error);
      }
      return String(data);
    },

    async createUser(email, password) {
      // email_confirm false: the person typing the email has not proven they
      // own it, and an invite can be unbound (clients.email null), so skipping
      // confirmation would let a link-holder camp a stranger's address. On
      // deployments with confirmations on, the frontend's sign-in attempt
      // returns "email not confirmed" and offers the resend path.
      const { error } = await db.auth.admin.createUser({
        email,
        password,
        email_confirm: false,
      });
      if (!error) return "created";
      const code = (error as { code?: string }).code;
      if (code === "email_exists" || /already.*(registered|exists)/i.test(error.message ?? "")) {
        return "exists";
      }
      // GoTrue's own 4xx refusals are the CALLER's to fix, and its messages
      // for them are user-facing by design — collapsing them into a 500 gave
      // the person a generic sentence for a condition retrying can never
      // change (adversarial review). weak_password keeps the code the
      // handler's own floor uses, so the frontend has one branch.
      if (code === "weak_password") {
        throw new HttpError(400, "weak_password", error.message);
      }
      if (
        code === "validation_failed" || code === "email_address_invalid" ||
        code === "email_address_not_authorized"
      ) {
        throw new HttpError(400, "bad_request", error.message);
      }
      throw new HttpError(500, "signup_failed", "could not create the account", error);
    },
  };
}

serveFunction(async (req) => {
  const body = await readJson<unknown>(req);
  return jsonOk(await handleClaimSignup(body, makeDeps()));
});
