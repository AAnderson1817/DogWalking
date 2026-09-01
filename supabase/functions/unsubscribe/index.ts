// unsubscribe — one of four `verify_jwt = false` endpoints (stripe-webhook,
// platform-webhook, claim-signup and this), and the only one addressed to a
// person who holds no account at all.
//
// Review M29. `clients.email` is typed by the operator and reconciled with
// nothing, so one typo sends a stranger a recurring feed of `walk_complete`
// notifications: when a named person's house is empty, several times a week.
// That person cannot sign in — they are not a client, they claimed no invite —
// so an opt-out behind a session is no opt-out at all for exactly the recipient
// who most needs one.
//
// Hence a bearer token in the URL, carried only in mail already addressed to
// them, and `verify_jwt = false` in `config.toml` (which `supabase functions
// deploy` does read, unlike the `[auth]` block — see review H2).
//
// ── What this endpoint deliberately does not do ──────────────────────────
//
//   * It never says whether a token exists. `fn_unsubscribe_by_token` answers
//     identically either way, because an unauthenticated endpoint that
//     distinguishes them is an oracle for guessing them.
//   * It takes no other input. No email address, no client id, no scope — a
//     public endpoint that accepts an address is a way to unsubscribe somebody
//     else.
//   * It is not rate-limited, because there is nothing to gain by calling it:
//     a valid token only ever suppresses its own address, and the operation is
//     idempotent.
import { adminClient } from "../_lib/admin.ts";
import { serveFunction } from "../_lib/http.ts";
import { handleUnsubscribe } from "./handler.ts";

// GET is the whole point: the link lives in an email and a person clicks it.
// POST is RFC 8058 one-click, sent by the mail provider. Everything else in
// this project is POST-only and stays that way — see ServeOptions.
serveFunction(
  (req) =>
    handleUnsubscribe(req, {
      suppress: async (token) => await adminClient().rpc("fn_unsubscribe_by_token", {
        p_token: token,
      }),
    }),
  { methods: ["GET", "POST"] },
);
