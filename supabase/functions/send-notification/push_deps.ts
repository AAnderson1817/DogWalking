// The push arm's WIRING, split out of index.ts (Codex review on PR #85).
//
// `push.ts` holds the decision logic and has had tests since M27 landed; this
// file holds the part that actually reaches the network, and until this split
// it had none — importing `index.ts` executes `serveFunction` and binds a
// port, so nothing could drive it.
//
// That is exactly the shape `fix(connect-routing)` recorded: `overage_deps.ts`
// had zero coverage because the suite injected pure mocks, so the ONE Stripe
// call still pointed at the platform account went unnoticed until it would
// have 500'd every overage walk. The finding this file was split out for is
// the same class — the `fetch` options are wiring, and `redirect: "manual"` is
// a security control that a mocked `sendPush` can never exercise.
//
// `fetchImpl` is injected for that reason and defaults to the global.
import { HttpError } from "../_lib/http.ts";
import { claimNotificationSend } from "./handler.ts";
import {
  encryptPushPayload,
  vapidAuthorization,
  type VapidConfig,
} from "../_lib/webpush.ts";
import { functionName, logServerError, requestId } from "../_lib/observe.ts";
import type { adminClient } from "../_lib/admin.ts";
import { type PushAttempt, type PushDeps, pushRecordPatch } from "./push.ts";

/**
 * Read the VAPID configuration, or null when push was never set up.
 *
 * Null is not an error on its own: with no keys the frontend never offers to
 * subscribe, so there are no devices and every notification records `skipped`
 * for want of a recipient — the honest state. It becomes an error only when
 * devices EXIST and the keys do not, which is a real misconfiguration (keys
 * rotated or removed out from under live subscriptions) and gets H17's loud
 * failure rather than a silent success.
 */
export function vapidConfig(): VapidConfig | null {
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  const subject = Deno.env.get("VAPID_SUBJECT");
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

/** Per-endpoint deadline. Ten seconds is far longer than a push service
 * needs and short enough that ten stalled devices cannot outlast the
 * invocation. */
const PUSH_TIMEOUT_MS = 10_000;

/**
 * The host, for a log line. Never the full endpoint: the path segment IS the
 * device's bearer credential — anyone holding it can push to that browser —
 * so it is exactly the thing not to write into a log aggregator.
 */
export function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "(unparseable)";
  }
}

export function makePushDeps(
  db: ReturnType<typeof adminClient>,
  vapid: VapidConfig | null,
  req: Request,
  fetchImpl: typeof fetch = fetch,
): PushDeps {
  const rid = requestId(req);
  return {
    // The same claim the email arm uses, and literally the same code (0051):
    // two copies of one rule is the drift this repository has already paid
    // for, and one of them was untestable where it sat.
    claimSend: (id, channel) => claimNotificationSend(db, id, channel),
    async getSubscriptions(operatorId, clientId) {
      // Explicit columns, never `*`: 0049 makes this a column-restricted table
      // (the encryption secrets are withheld from `authenticated`), and
      // PostgREST does not narrow a wildcard — it would raise 42501 for every
      // row. That is the fix(client-columns) defect.
      let q = db
        .from("push_subscriptions")
        .select("id, endpoint, p256dh, auth")
        .eq("operator_id", operatorId);
      q = clientId === null ? q.is("client_id", null) : q.eq("client_id", clientId);
      const { data, error } = await q;
      if (error) {
        throw new HttpError(500, "db_error", "could not read push subscriptions", error, {
          operator_id: operatorId,
        });
      }
      return data ?? [];
    },

    async sendPush(sub, payload) {
      // Everything before the fetch is OURS, and it is classified and logged
      // here rather than thrown (Codex review on PR #85, twelfth round).
      // Thrown, `deliverPush`'s catch flattened all of it to `status: 0` and
      // recorded "the request to the push service did not complete" — false,
      // since no request was made — while this function's own logging ran
      // only after the fetch, so the fault was written down nowhere. A
      // deployment whose VAPID keys were removed while devices existed showed
      // an ordinary transient failure, forever.
      const blocked = (
        reason: "not_configured" | "payload",
        message: string,
        cause?: unknown,
      ): PushAttempt => {
        logServerError({
          fn: functionName(req.url),
          request_id: rid,
          status: 500,
          code: `push_${reason}`,
          message,
          cause,
          context: { subscription_id: sub.id, endpoint_host: hostOf(sub.endpoint) },
        });
        return { status: 0, blocked: reason };
      };

      if (!vapid) {
        // Reachable only when devices exist without keys — see vapidConfig().
        return blocked(
          "not_configured",
          "push delivery is not configured, so this notification was not pushed",
          "VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT are unset in this deployment",
        );
      }
      // EVERY pre-fetch step, not the ones I happened to think of (Codex
      // review on PR #85, fourteenth round). Round twelve wrapped the
      // encryption and left `vapidAuthorization` where it was — inside the
      // `fetch` options object — so a malformed VAPID_SUBJECT or a private key
      // that will not import threw past the classification, was flattened to
      // `transport`, recorded the false network sentence and logged nothing:
      // the exact defect round twelve fixed, surviving in the sibling
      // operation. Enumerating the ways something can fail is how the next one
      // is missed, so the structure is the rule now: the `fetch` call below
      // takes only precomputed values, and nothing inside its argument can
      // throw.
      let body: Uint8Array;
      let authorization: string;
      try {
        // Key material that will not import, or a payload past the record
        // size. Neither is fixed by retrying THIS second, but both are fixed
        // by a later notification with a shorter body or a re-registered
        // device, so the row stays retryable and the fault is on the log.
        body = await encryptPushPayload(payload, { p256dh: sub.p256dh, auth: sub.auth });
      } catch (e) {
        return blocked("payload", "a push payload could not be encrypted", e);
      }
      try {
        // A bad subject or an unimportable private key. That is configuration,
        // not this device — every device fails identically until somebody
        // fixes the deployment — so it is classed with the missing keys above.
        authorization = await vapidAuthorization(sub.endpoint, vapid);
      } catch (e) {
        return blocked("not_configured", "the VAPID credentials could not sign a request", e);
      }
      // Every request gets a deadline (Codex review on PR #85). An endpoint
      // that accepts the connection and then STALLS would otherwise hold this
      // invocation open — and devices are awaited sequentially, ahead of the
      // email arm, so one slow endpoint costs the recipient their email and
      // every later device. That is precisely the channel isolation this
      // function claims, defeated by a socket rather than by an exception.
      //
      // Registered endpoints are attacker-influenced (any https url passes the
      // shape check), so this is not only about a push service having a bad
      // day.
      const res = await fetchImpl(sub.endpoint, {
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
        // Never follow a redirect (Codex review on PR #85). The allowlist
        // decides which host this function will contact, and a followed
        // redirect is that decision being made by the response instead — one
        // hop later, at a host nothing checked. A push service does not
        // redirect, so the 3xx that reaches the caller here is a failure and
        // is recorded as one. Measured in Deno rather than assumed: this
        // returns the real 302 (`type: "basic"`, `ok: false`) and makes no
        // second request — it does not throw and does not hand back an opaque
        // status 0, so nothing downstream needs a special case for it.
        redirect: "manual",
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          // Four hours. A walk report is worth holding while a phone is off;
          // it is not worth delivering next week.
          TTL: "14400",
        },
        body: body as BodyInit,
      });
      // The push service's own words are the only diagnostic available when a
      // body is rejected — and they go to the LOG, never to the caller
      // (Codex review on PR #85). Returning them put them in
      // `notifications.push_last_error`, which `authenticated` may select,
      // so a caller who could choose the endpoint could also read back what
      // it answered. Reading and logging in the same expression is the point:
      // the body never becomes a value anything downstream can forward.
      if (!res.ok) {
        logServerError({
          fn: functionName(req.url),
          request_id: rid,
          status: res.status,
          code: "push_rejected",
          message: "a push service rejected a notification",
          cause: (await res.text().catch(() => "")) || "(empty body)",
          context: { subscription_id: sub.id, endpoint_host: hostOf(sub.endpoint) },
        });
      }
      return { status: res.status };
    },

    async dropSubscription(id) {
      // supabase-js reports failures in the RESOLVED result, not by
      // rejecting, so the bare await said nothing (Codex review on PR #85).
      // A failed delete counted as "gone" anyway: `deliverPush` could then
      // record `skipped` — terminal — while the dead endpoint stayed in the
      // table for every future notification to POST to again.
      const { error } = await db.from("push_subscriptions").delete().eq("id", id);
      if (error) {
        // Logged, not thrown (Codex review on PR #85, tenth round). Throwing
        // from here aborted the whole device fanout on a database blip
        // affecting one dead row. The caller reads the boolean and keeps the
        // notification retryable, so the row is deleted on the next pass.
        logServerError({
          fn: functionName(req.url),
          request_id: rid,
          status: 500,
          code: "db_error",
          message: "could not drop a dead push subscription",
          cause: error,
          context: { subscription_id: id },
        });
        return false;
      }
      return true;
    },

    async noteFailure(id, error) {
      // ONE statement, through a definer function (Codex review on PR #85,
      // eighteenth round). This was a client-side read-modify-write, so two
      // notifications delivered concurrently to the same failing device both
      // read the old count and both wrote the same value — losing a failure
      // during exactly the burst the counter exists to show. PostgREST cannot
      // express `col = col + 1`, so it takes an RPC.
      //
      // That also deletes the read entirely, and with it the round-sixteen
      // branch that had to decide what an unreadable count meant. No read, no
      // wrong answer.
      const { error: rpcError } = await db.rpc("fn_note_push_failure", {
        p_id: id,
        p_error: error,
      });
      if (rpcError) {
        // Logged and swallowed: per-device health is diagnostic, and losing a
        // live notification over bookkeeping is the round-ten defect facing
        // the other way.
        logServerError({
          fn: functionName(req.url),
          request_id: rid,
          status: 500,
          code: "db_error",
          message: "could not record a device failure",
          cause: rpcError,
          context: { subscription_id: id },
        });
      }
    },

    async recordPush(id, outcome, previousAttempts) {
      const { error } = await db
        .from("notifications")
        .update(pushRecordPatch(outcome, previousAttempts))
        .eq("id", id);
      if (error) {
        throw new HttpError(500, "db_error", "could not record push delivery", error, {
          notification_id: id,
        });
      }
    },
  };
}
