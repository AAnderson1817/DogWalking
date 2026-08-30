// Typed data-access layer (spec 06). ALL reads/writes and edge invocations
// flow through here; screens never call supabase.from directly. Wrappers for
// later-phase surfaces exist as typed stubs so screens can bind early.
import { businessWallClockToMs } from "./format";
import { LOW_CREDIT_SUBSCRIPTION_STATUSES } from "./selectors";
import { supabase } from "./supabase";
import type { Database } from "./types";
import type {
  Clients,
  CreditLedger,
  InviteClaimOutcome,
  Notifications,
  Operators,
  Payments,
  PaymentStatus,
  Pets,
  Plans,
  Properties,
  RecurringSchedules,
  ServiceTypes,
  WalkGpsPoints,
  WalkPhotos,
  Walks,
} from "./types";

type TableInsert<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Insert"];
type TableUpdate<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Update"];

function must<T>(data: T | null, error: { message: string } | null): T {
  if (error) throw new Error(error.message);
  if (data === null) throw new Error("not found");
  return data;
}

/**
 * Row bounds for list queries (review M9).
 *
 * PostgREST caps an unbounded select at `max_rows` — 1000 — and returns the
 * first page WITHOUT SAYING SO, so an unbounded query does not fail, it
 * quietly answers a different question. Two of those questions were money and
 * service: `listPayments()` feeds Today's "Needs attention" strip and Money's
 * three headline totals, and `listWalksDetailed` orders ASCENDING, so a client
 * past the cap keeps their oldest walks and loses every recent one — including
 * the "next walk" the portal exists to show.
 *
 * An explicit limit does not remove the cap. It makes the boundary chosen and
 * sayable, and it sits BELOW the cap so the number that applies is the one in
 * this file rather than a platform default nothing here mentions.
 *
 * Three sizes, because one number would be wrong somewhere: a route bounded at
 * 200 points is a truncated route, and a roster bounded at 5000 is not bounded.
 */
export const LIST_PAGE = 200;
/** Reference data an operator scrolls: clients, pets, properties, ledger. */
export const LIST_PAGE_LARGE = 500;
/** One walk's own rows — GPS points arrive about every 5 s while walking. */
export const WALK_DETAIL_PAGE = 5000;

// ── clients ────────────────────────────────────────────────────────────────
export async function listClients(): Promise<Clients[]> {
  const { data, error } = await supabase.from("clients").select("*").order("full_name").limit(LIST_PAGE_LARGE);
  return must(data, error);
}

export async function getClient(id: string): Promise<Clients> {
  const { data, error } = await supabase.from("clients").select("*").eq("id", id).single();
  return must(data, error);
}

export async function createClient(row: TableInsert<"clients">): Promise<Clients> {
  const { data, error } = await supabase.from("clients").insert(row).select().single();
  return must(data, error);
}

export async function updateClient(id: string, patch: TableUpdate<"clients">): Promise<Clients> {
  const { data, error } = await supabase
    .from("clients").update(patch).eq("id", id).select().single();
  return must(data, error);
}

/** The signed-in client persona's own row (portal). */
/**
 * Review L11. `auth.getUser()` is a network round trip to `/auth/v1/user`, and
 * it ran on every mount of six screens including Today — serialized in FRONT
 * of the real query, for an id `AuthProvider` has already resolved and
 * `RequireRole` has already blocked render on.
 *
 * The id is now an optional argument. Callers that hold it (every screen, via
 * `useAuth()`) skip the round trip; the fallback keeps the function usable
 * from anywhere and keeps this a performance change rather than a refactor
 * that could strand a caller.
 */
export async function getMyClient(userId?: string): Promise<Clients | null> {
  let uid = userId;
  if (!uid) {
    const { data: userData } = await supabase.auth.getUser();
    uid = userData.user?.id;
  }
  if (!uid) return null;
  const { data, error } = await supabase
    .from("clients").select("*").eq("auth_user_id", uid).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

// ── pets ───────────────────────────────────────────────────────────────────
export async function listPets(clientId?: string): Promise<Pets[]> {
  let query = supabase.from("pets").select("*").eq("active", true).order("name").limit(LIST_PAGE_LARGE);
  if (clientId) query = query.eq("client_id", clientId);
  const { data, error } = await query;
  return must(data, error);
}

export async function createPet(row: TableInsert<"pets">): Promise<Pets> {
  const { data, error } = await supabase.from("pets").insert(row).select().single();
  return must(data, error);
}

export async function updatePet(id: string, patch: TableUpdate<"pets">): Promise<Pets> {
  const { data, error } = await supabase.from("pets").update(patch).eq("id", id).select().single();
  return must(data, error);
}

// ── properties ─────────────────────────────────────────────────────────────
export async function listProperties(clientId?: string): Promise<Properties[]> {
  let query = supabase.from("properties").select("*").order("label").limit(LIST_PAGE_LARGE);
  if (clientId) query = query.eq("client_id", clientId);
  const { data, error } = await query;
  return must(data, error);
}

export async function createProperty(row: TableInsert<"properties">): Promise<Properties> {
  const { data, error } = await supabase.from("properties").insert(row).select().single();
  return must(data, error);
}

export async function updateProperty(
  id: string,
  patch: TableUpdate<"properties">,
): Promise<Properties> {
  const { data, error } = await supabase
    .from("properties").update(patch).eq("id", id).select().single();
  return must(data, error);
}

// ── service types & plans ──────────────────────────────────────────────────
export async function listServiceTypes(): Promise<ServiceTypes[]> {
  const { data, error } = await supabase.from("service_types").select("*").order("duration_minutes").limit(LIST_PAGE);
  return must(data, error);
}

export async function listPlans(): Promise<Plans[]> {
  const { data, error } = await supabase.from("plans").select("*").order("price_pence").limit(LIST_PAGE);
  return must(data, error);
}

// ── settings: service types and plans (review B6) ──────────────────────────
// The database has always granted the operator full CRUD on both tables with
// correct operator_id policies (0004); there was simply no UI and no client
// binding. RLS supplies operator_id scoping, so none of these pass it.

export async function createServiceType(
  row: Omit<TableInsert<"service_types">, "operator_id">,
): Promise<ServiceTypes> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) throw new Error("not signed in");
  const { data, error } = await supabase
    .from("service_types").insert({ ...row, operator_id: uid }).select().single();
  return must(data, error);
}

export async function updateServiceType(
  id: string,
  patch: TableUpdate<"service_types">,
): Promise<ServiceTypes> {
  const { data, error } = await supabase
    .from("service_types").update(patch).eq("id", id).select().single();
  return must(data, error);
}

export async function deleteServiceType(id: string): Promise<void> {
  const { error } = await supabase.from("service_types").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function updatePlan(
  id: string,
  patch: TableUpdate<"plans">,
): Promise<Plans> {
  const { data, error } = await supabase
    .from("plans").update(patch).eq("id", id).select().single();
  return must(data, error);
}

// ── walks ──────────────────────────────────────────────────────────────────
export interface WalkFilters {
  clientId?: string;
  date?: string;
  from?: string;
  to?: string;
  status?: Walks["status"];
  /**
   * Newest first. Load-bearing next to `limit` (review M9): the default order
   * is ascending, so "the last three reports" asked with a limit alone returns
   * the OLDEST three — and a client past PostgREST's 1000-row cap loses every
   * recent walk while keeping their first year.
   */
  newestFirst?: boolean;
  /** Overrides the default bound where a caller knows it needs fewer. */
  limit?: number;
}

/** Shared filter/ordering, so the two walk listers cannot drift apart. */
function walkQuery<Q extends {
  eq(col: string, v: unknown): Q;
  gte(col: string, v: unknown): Q;
  lte(col: string, v: unknown): Q;
  order(col: string, opts?: { ascending: boolean }): Q;
  limit(n: number): Q;
}>(query: Q, filters: WalkFilters): Q {
  let q = query;
  if (filters.clientId) q = q.eq("client_id", filters.clientId);
  if (filters.date) q = q.eq("scheduled_date", filters.date);
  if (filters.from) q = q.gte("scheduled_date", filters.from);
  if (filters.to) q = q.lte("scheduled_date", filters.to);
  if (filters.status) q = q.eq("status", filters.status);
  const ascending = !filters.newestFirst;
  return q
    .order("scheduled_date", { ascending })
    .order("window_start", { ascending })
    .limit(filters.limit ?? LIST_PAGE_LARGE);
}

export async function listWalks(filters: WalkFilters = {}): Promise<Walks[]> {
  const { data, error } = await walkQuery(supabase.from("walks").select("*"), filters);
  return must(data, error);
}

export async function getWalk(id: string): Promise<Walks> {
  const { data, error } = await supabase.from("walks").select("*").eq("id", id).single();
  return must(data, error);
}

export async function createWalk(row: TableInsert<"walks">): Promise<Walks> {
  const { data, error } = await supabase.from("walks").insert(row).select().single();
  return must(data, error);
}

/** Atomic client self-booking (fn_book_walk, migration 0013): inserts the
 * walk and its walk_pets in one transaction, so a failure can't leave an
 * orphan petless walk that a retry would double-book. Returns the walk id. */
export async function bookWalk(args: {
  property_id: string;
  service_type_id: string;
  scheduled_date: string;
  window_start: string;
  window_end: string;
  pet_ids: string[];
}): Promise<string> {
  const { data, error } = await supabase.rpc("fn_book_walk", {
    p_property: args.property_id,
    p_service: args.service_type_id,
    p_date: args.scheduled_date,
    p_window_start: args.window_start,
    p_window_end: args.window_end,
    p_pet_ids: args.pet_ids,
  });
  return must(data as string | null, error);
}

export async function updateWalk(id: string, patch: TableUpdate<"walks">): Promise<Walks> {
  const { data, error } = await supabase.from("walks").update(patch).eq("id", id).select().single();
  return must(data, error);
}

export async function listWalkPets(walkId: string): Promise<Pets[]> {
  const { data, error } = await supabase
    .from("walk_pets").select("pets(*)").eq("walk_id", walkId).limit(LIST_PAGE);
  const rows = must(data, error);
  return rows.flatMap((r) => (r.pets ? [r.pets as unknown as Pets] : []));
}

export async function setWalkPets(
  walkId: string,
  operatorId: string,
  petIds: string[],
): Promise<void> {
  const { error: delErr } = await supabase.from("walk_pets").delete().eq("walk_id", walkId);
  if (delErr) throw new Error(delErr.message);
  if (petIds.length === 0) return;
  const { error } = await supabase.from("walk_pets").insert(
    petIds.map((petId) => ({ walk_id: walkId, pet_id: petId, operator_id: operatorId })),
  );
  if (error) throw new Error(error.message);
}

export async function listWalkPhotos(walkId: string): Promise<WalkPhotos[]> {
  const { data, error } = await supabase
    .from("walk_photos").select("*").eq("walk_id", walkId).order("taken_at").limit(LIST_PAGE);
  return must(data, error);
}

/**
 * Record a photo the moment it lands in Storage, rather than waiting for
 * complete-walk to write every row from the completion request (review H8).
 *
 * Before this, the only pointer to an uploaded photo was React state. Any
 * remount — a reload, a back-swipe, the OS reclaiming the tab — stranded every
 * photo taken so far in the bucket with no row referencing it, and the operator
 * got no error and no list of what had already been uploaded.
 *
 * `ignoreDuplicates` against `uq_walk_photos_path` (0013) makes this safe to
 * repeat, and complete-walk's own upsert uses the same conflict target, so a
 * path written here and sent again at completion is a no-op rather than a
 * second row.
 */
export async function insertWalkPhoto(
  operatorId: string,
  walkId: string,
  storagePath: string,
): Promise<void> {
  const { error } = await supabase.from("walk_photos").upsert(
    {
      walk_id: walkId,
      operator_id: operatorId,
      storage_path: storagePath,
      taken_at: new Date().toISOString(),
    },
    { onConflict: "walk_id,storage_path", ignoreDuplicates: true },
  );
  if (error) throw new Error(error.message);
}

export async function listWalkGpsPoints(walkId: string): Promise<WalkGpsPoints[]> {
  const { data, error } = await supabase
    .from("walk_gps_points").select("*").eq("walk_id", walkId).order("recorded_at").limit(WALK_DETAIL_PAGE);
  return must(data, error);
}

export async function insertGpsPoints(
  rows: TableInsert<"walk_gps_points">[],
): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await supabase.from("walk_gps_points").insert(rows);
  if (error) throw new Error(error.message);
}

// ── schedules (phase 06 surfaces; wrappers ready) ──────────────────────────
export async function listSchedules(clientId?: string): Promise<RecurringSchedules[]> {
  let query = supabase.from("recurring_schedules").select("*").eq("active", true).limit(LIST_PAGE);
  if (clientId) query = query.eq("client_id", clientId);
  const { data, error } = await query;
  return must(data, error);
}

// ── ledger, payments, notifications ────────────────────────────────────────
export async function listLedger(clientId: string): Promise<CreditLedger[]> {
  const { data, error } = await supabase
    .from("credit_ledger")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .order("seq", { ascending: false })
    .limit(LIST_PAGE_LARGE);
  return must(data, error);
}

export async function listPayments(clientId?: string): Promise<Payments[]> {
  let query = supabase
    .from("payments")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(PAYMENTS_PAGE);
  if (clientId) query = query.eq("client_id", clientId);
  const { data, error } = await query;
  return must(data, error);
}

/**
 * Clients at or below the operator's low-credit threshold (review M9).
 *
 * Today used to fetch EVERY client and filter in the browser to render at most
 * a handful of rows. The predicate is the same one `lowCreditClients` applies
 * — the shared status list below is what stops the two drifting — but asked of
 * Postgres, which has the index and does not have to send the rest.
 */
export async function listLowCreditClients(
  threshold: number,
  limit = LIST_PAGE,
): Promise<Clients[]> {
  const { data, error } = await supabase
    .from("clients")
    .select("*")
    .neq("status", "archived")
    .in("subscription_status", [...LOW_CREDIT_SUBSCRIPTION_STATUSES])
    .lte("credit_balance", threshold)
    .order("credit_balance")
    .limit(limit);
  return must(data, error);
}

export interface AttentionPayment extends Payments {
  client: { full_name: string } | null;
}

/**
 * Failed payments that still need somebody to act (review M9, M3).
 *
 * Today used to fetch every payment ever and filter in the browser for at most
 * five rows. Past PostgREST's 1000-row cap that silently dropped the newest
 * failures — the ones that matter — from the strip whose entire job is to
 * surface them.
 *
 * The client name is joined rather than looked up against a separate
 * `listClients()` call, which is what made fetching the whole roster look
 * necessary.
 */
export async function listAttentionPayments(limit = 5): Promise<AttentionPayment[]> {
  const { data, error } = await supabase
    .from("payments")
    .select("*, client:clients(full_name)")
    .eq("status", "failed")
    // 0034: a failure settled by a later success is not anybody's to act on.
    .is("superseded_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  return must(data as unknown as AttentionPayment[] | null, error);
}

export interface PaymentDetailed extends Payments {
  client: { full_name: string } | null;
  walk: {
    service: { name: string } | null;
    walk_pets: { pets: { name: string } | null }[];
  } | null;
}

/** Payment activity with the display context required by the Money ledger. */
/**
 * Bounded, because PostgREST caps an unbounded select at 1000 rows by default
 * and returns the first page WITHOUT SAYING SO (review M3/M9). The Money
 * screen sums this list into its three headline totals, so past that cap every
 * one of them silently under-reported — the worst possible failure on the
 * screen an operator uses to decide whether they have been paid.
 *
 * An explicit limit does not fix the truncation; it makes it visible and
 * deliberate, and `PAYMENTS_PAGE` is the number the caller can then say out
 * loud. A `since` bound is what actually keeps the totals meaningful, and the
 * Money rail passes one.
 */
export const PAYMENTS_PAGE = 500;

export async function listPaymentsDetailed(
  clientId?: string,
  since?: Date,
): Promise<PaymentDetailed[]> {
  let query = supabase
    .from("payments")
    .select("*, client:clients(full_name), walk:walks(service:service_types(name), walk_pets(pets(name)))")
    .order("created_at", { ascending: false })
    .limit(PAYMENTS_PAGE);
  if (clientId) query = query.eq("client_id", clientId);
  if (since) query = query.gte("created_at", since.toISOString());
  const { data, error } = await query;
  return must(data as unknown as PaymentDetailed[] | null, error);
}

export function paymentPetNames(payment: PaymentDetailed): string[] {
  return payment.walk?.walk_pets.flatMap((row) => row.pets ? [row.pets.name] : []) ?? [];
}

export async function listNotifications(unreadOnly = false): Promise<Notifications[]> {
  let query = supabase
    .from("notifications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(LIST_PAGE);
  if (unreadOnly) query = query.is("read_at", null);
  const { data, error } = await query;
  return must(data, error);
}

export async function markNotificationRead(id: string): Promise<void> {
  const { error } = await supabase
    .from("notifications").update({ read_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
}

// ── database RPCs ──────────────────────────────────────────────────────────
export async function adjustCredits(
  clientId: string,
  amount: number,
  note: string,
): Promise<number> {
  const { data, error } = await supabase.rpc("fn_adjust_credits", {
    p_client: clientId,
    p_amount: amount,
    p_note: note,
  });
  if (error) throw new Error(error.message);
  return data as number;
}

export async function walkCost(walkId: string): Promise<number> {
  const { data, error } = await supabase.rpc("fn_walk_cost", { p_walk: walkId });
  if (error) throw new Error(error.message);
  return data as number;
}

/**
 * Why the outcomes come back as data rather than as thrown errors (review H4).
 *
 * `fn_claim_invite` writes an audit row for every attempt, and a PL/pgSQL
 * `raise` rolls the transaction back to the caller's savepoint — which
 * discards the row it just wrote. Log-then-raise therefore records only the
 * attempts that SUCCEEDED, and the refusals, which are the interesting ones,
 * vanish. So the function returns its verdict and this layer turns it into an
 * error for the screen.
 *
 * The refusal is never the exception: it is the absence of the binding UPDATE,
 * which the function performs only on `claimed`.
 */
// The outcome enum comes from the generated schema types rather than being
// restated here. A second copy is the drift this repository has already paid
// for once, in the payment-status sets.
export class InviteClaimError extends Error {
  // Written out rather than declared as a constructor parameter property:
  // `erasableSyntaxOnly` is on, and that syntax is not type-erasable.
  readonly outcome: Exclude<InviteClaimOutcome, "claimed">;

  constructor(outcome: Exclude<InviteClaimOutcome, "claimed">) {
    super(INVITE_CLAIM_MESSAGE[outcome]);
    this.name = "InviteClaimError";
    this.outcome = outcome;
  }
}

/**
 * Each message names what the person can actually do next. "Expired" and
 * "withdrawn" are deliberately different sentences: an expired invite wants a
 * reissue, a withdrawn one was somebody's decision and asking for a reissue of
 * it is the wrong request to make.
 */
export const INVITE_CLAIM_MESSAGE: Record<Exclude<InviteClaimOutcome, "claimed">, string> = {
  not_found: "This invite link is not valid. Ask your walker to send a fresh one.",
  already_claimed: "This invite has already been claimed. Sign in instead.",
  expired: "This invite has expired. Ask your walker to send a fresh one.",
  revoked: "This invite was withdrawn by your walker. Ask them for a new one.",
  email_mismatch:
    "This invite was sent to a different email address. Sign up with the address your walker invited, or ask them to update it.",
};

export async function claimInvite(token: string, noticeVersion: string): Promise<string> {
  // The version travels with the claim so the acceptance and the account
  // binding are one transaction — a claimed account with no consent record is
  // then not a state that can occur (review H6).
  // Required at this boundary, not optional. The SQL default exists so the
  // function stays callable from a smoke block, but there is no product path
  // that should claim an invite without having shown the notice — making the
  // argument optional here is how that path gets added by accident.
  const { data, error } = await supabase.rpc("fn_claim_invite", {
    p_token: token,
    p_notice_version: noticeVersion,
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as
    | { client_id: string | null; outcome: InviteClaimOutcome }
    | undefined;
  // A missing row is not a claim. Treating it as one would navigate a signed-up
  // account into a portal it was never bound to.
  if (!row) throw new InviteClaimError("not_found");
  if (row.outcome !== "claimed" || !row.client_id) {
    throw new InviteClaimError(
      row.outcome === "claimed" ? "not_found" : row.outcome,
    );
  }
  return row.client_id;
}

/** Reissue an invite: new token, fresh window, revocation cleared. */
export async function rotateInvite(clientId: string): Promise<string> {
  const { data, error } = await supabase.rpc("fn_rotate_invite", { p_client: clientId });
  if (error) throw new Error(error.message);
  return data as string;
}

/** Withdraw an invite that should no longer be claimable. */
export async function revokeInvite(clientId: string): Promise<void> {
  const { error } = await supabase.rpc("fn_revoke_invite", { p_client: clientId });
  if (error) throw new Error(error.message);
}

/** The one place the claim URL is built, so Roster and ClientDetail agree. */
export function inviteUrlFor(token: string): string {
  return `${window.location.origin}/claim/${token}`;
}

/**
 * Release an invite claimed by the wrong person, and reissue in one statement.
 *
 * H4's own scenario is a link that travelled. Expiry, revocation and email
 * binding bound FUTURE claims; none of them helps once a wrong one has landed —
 * `fn_revoke_invite` and `fn_rotate_invite` both require an UNCLAIMED invite,
 * and the client row cannot be deleted because every child FK restricts. The
 * operator's only route was the service role.
 *
 * Severing and reissuing together is the whole point: two statements leave a
 * window where the client is unclaimed and the OLD token is still live, so
 * whoever holds it simply claims again.
 */
export async function unbindInvite(clientId: string): Promise<string> {
  const { data, error } = await supabase.rpc("fn_unbind_invite", { p_client: clientId });
  if (error) throw new Error(error.message);
  return data as string;
}

export type InviteState = "claimed" | "revoked" | "expired" | "active";

/**
 * One place that decides what an invite's state is, so the Roster chip and the
 * ClientDetail panel cannot disagree. Order matters: a claimed invite is
 * claimed regardless of what its expiry says, because the expiry stopped being
 * consulted the moment an account was bound.
 */
export function inviteState(c: {
  auth_user_id: string | null;
  invite_revoked_at?: string | null;
  invite_expires_at?: string | null;
}): InviteState {
  if (c.auth_user_id) return "claimed";
  if (c.invite_revoked_at) return "revoked";
  if (c.invite_expires_at && new Date(c.invite_expires_at).getTime() <= Date.now()) {
    return "expired";
  }
  return "active";
}

/** Invite preview for /claim/:token — filtered select on invite_token. */
export async function previewInvite(
  token: string,
): Promise<Pick<Clients, "id" | "full_name" | "status"> | null> {
  const { data, error } = await supabase
    .from("clients")
    .select("id, full_name, status")
    .eq("invite_token", token)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

// ── data export and erasure (review H5) ────────────────────────────────────

/** The whole of a client's record as one JSON document, for portability. */
export async function exportClientData(clientId: string): Promise<unknown> {
  const { data, error } = await supabase.rpc("fn_export_client_data", { p_client: clientId });
  if (error) throw new Error(error.message);
  return data;
}

export interface PurgeResult {
  /** Objects the browser removed from storage. */
  photosDeleted: number;
  /** Objects storage refused to delete. Non-empty means the purge is INCOMPLETE. */
  failedPaths: string[];
}

/**
 * Erase a client's personal data.
 *
 * Two phases, and the order is the whole design. SQL cannot delete an object
 * from a Supabase bucket — dropping the `storage.objects` row removes the
 * metadata and leaves the file — so a SQL-only purge would destroy the POINTER
 * to a photo of somebody's house and leave the photo.
 *
 * So `fn_purge_client` destroys everything it can and RETURNS the storage
 * paths, keeping the rows that name them. This function deletes the objects
 * (the operator already holds a storage delete policy scoped to their own
 * folder, 0004), and only then calls `fn_purge_client_photos` to drop the rows.
 *
 * The rows are the work queue — the pattern the vault rewrap settled on. If
 * this dies between the phases, re-running returns the same paths. A file left
 * in the bucket with nothing in the database naming it is structurally
 * impossible, because the row outlives the object by construction.
 *
 * A path that storage refuses is REPORTED rather than swallowed, and the rows
 * are still dropped only for what actually went. Reporting "deleted" over a
 * file that is still there is the one outcome that would make this worse than
 * doing nothing.
 */
export async function purgeClient(clientId: string): Promise<PurgeResult> {
  const { data, error } = await supabase.rpc("fn_purge_client", { p_client: clientId });
  if (error) throw new Error(error.message);
  const paths = ((data ?? []) as Array<{ storage_path: string }>)
    .map((r) => r.storage_path)
    .filter((p): p is string => typeof p === "string" && p.length > 0);

  const failedPaths: string[] = [];
  let photosDeleted = 0;

  // Split by bucket: walk photos and pet photos live in different ones, and
  // `remove` is per-bucket.
  for (const bucket of ["walk-photos", "pet-photos"] as const) {
    const mine = paths.filter((p) => bucketOf(p) === bucket);
    if (mine.length === 0) continue;
    const { data: removed, error: rmError } = await supabase.storage
      .from(bucket)
      .remove(mine.map(stripBucket));
    if (rmError) {
      failedPaths.push(...mine);
      continue;
    }
    photosDeleted += removed?.length ?? 0;
    const removedSet = new Set((removed ?? []).map((o) => o.name));
    failedPaths.push(...mine.filter((p) => !removedSet.has(stripBucket(p))));
  }

  if (failedPaths.length === 0) {
    await supabase.rpc("fn_purge_client_photos", { p_client: clientId });
  }
  return { photosDeleted, failedPaths };
}

/**
 * Stored paths may or may not carry the bucket as a first segment depending on
 * where they were written. Both shapes are handled rather than assumed, because
 * guessing wrong here means silently failing to delete a photo while reporting
 * success.
 */
function bucketOf(path: string): "walk-photos" | "pet-photos" {
  if (path.startsWith("pet-photos/")) return "pet-photos";
  if (path.startsWith("walk-photos/")) return "walk-photos";
  // Pet photos are written as `{operator}/pet/...`; walk photos as
  // `{operator}/{walk}/...`.
  return path.split("/")[1] === "pet" ? "pet-photos" : "walk-photos";
}

function stripBucket(path: string): string {
  return path.replace(/^(walk-photos|pet-photos)\//, "");
}

/**
 * What a single walk was charged, if anything (review H12).
 *
 * The client's own RLS lets them read their payments, so this needs no new
 * grant. Bounded and newest-first because a walk can carry more than one
 * overage row — a declined attempt and a later successful re-charge — and the
 * one worth showing is the succeeded one.
 */
export async function getWalkOverageCents(walkId: string): Promise<number | null> {
  const { data, error } = await supabase
    .from("payments")
    .select("amount_pence, status")
    .eq("walk_id", walkId)
    .eq("type", "overage")
    .eq("status", "succeeded")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.amount_pence ?? null;
}

// ── edge function invocations ──────────────────────────────────────────────
interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/**
 * Unwraps one edge-function result. Pure and exported so it can be tested
 * without a client: the interesting behaviour is entirely in the error path,
 * and that path is what was broken.
 *
 * @supabase/functions-js throws FunctionsHttpError on ANY non-2xx
 * (FunctionsClient.js:268-269) and its catch returns `{ data: null, error,
 * response }` (:292-296). So on every error status `data` is null, the branch
 * that reads `data.error.message` is unreachable, and the message the user saw
 * was the SDK's fixed string — "Edge Function returned a non-2xx status code"
 * (types.js:73-76) — for all nine edge calls. An operator whose walk failed to
 * bill was told that, instead of why.
 *
 * The envelope is recoverable because `invoke` also returns the raw Response.
 * Note the shape: the detail is CAPTURED inside the try and thrown OUTSIDE it.
 * Throwing inside would be swallowed by the same catch, which is exactly the
 * no-op this replaces — it reads as "throw the good message, else fall back"
 * and does the opposite.
 */
export async function unwrapEdgeResult<T>(
  name: string,
  result: {
    data?: Envelope<T> | null;
    error?: { message: string } | null;
    response?: { json: () => Promise<unknown> } | null;
  },
): Promise<T> {
  const { data, error, response } = result;
  if (error) {
    let detail: string | undefined;
    let code: string | undefined;
    if (response) {
      try {
        const envelope = (await response.json()) as Envelope<T> | null;
        const message = envelope?.error?.message;
        if (typeof message === "string" && message.trim() !== "") detail = message;
        const envCode = envelope?.error?.code;
        if (typeof envCode === "string" && envCode !== "") code = envCode;
      } catch {
        // No body, or not JSON. Fall back to the SDK's message rather than
        // masking the failure with a parse error.
      }
    }
    throw new EdgeError(detail ?? error.message, code);
  }
  if (!data?.ok || data.data === undefined) {
    throw new EdgeError(data?.error?.message ?? `${name} failed`, data?.error?.code);
  }
  return data.data;
}

/**
 * An edge failure with the envelope's machine-readable `code` attached. Still
 * an ordinary Error — every existing `err.message` catch keeps working — but
 * a caller that needs to BRANCH on the failure (claim-signup mapping invite
 * outcomes back onto the H4 dead-ends) finally has something better than
 * matching sentence text.
 */
export class EdgeError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "EdgeError";
    this.code = code;
  }
}

async function invokeEdge<T>(name: string, body: Record<string, unknown>): Promise<T> {
  return unwrapEdgeResult<T>(name, await supabase.functions.invoke<Envelope<T>>(name, { body }));
}

export interface CompleteWalkResult {
  walk: Walks;
  billing: {
    outcome: "debited" | "overage";
    cost_credits?: number;
    charged_pence?: number;
    payment_status?: PaymentStatus;
  };
}

export function completeWalk(body: {
  walk_id: string;
  ended_at: string;
  distance_m: number;
  notes?: string;
  potty_pee?: boolean;
  potty_poo?: boolean;
  fed?: boolean;
  watered?: boolean;
  photo_paths?: string[];
}): Promise<CompleteWalkResult> {
  return invokeEdge("complete-walk", body);
}

export function createCheckout(clientId: string, planId: string): Promise<{ url: string }> {
  return invokeEdge("create-checkout", { client_id: clientId, plan_id: planId });
}

/** Payment-mode checkout: the client buys `credits` for `amountPence`, and
 * the paying card is saved for off-session visit charges (review H32). The
 * grant lands when the webhook sees checkout.session.completed. */
export function createTopupCheckout(
  clientId: string,
  credits: number,
  amountPence: number,
): Promise<{ url: string }> {
  return invokeEdge("create-checkout", {
    client_id: clientId,
    topup: { credits, amount_pence: amountPence },
  });
}

/** Setup-mode checkout: card on file for a pay-per-visit client, under a
 * mandate naming the visit prices. Refused server-side (409
 * visit_price_missing) until a visit price exists to name. */
export function createSetupCheckout(clientId: string): Promise<{ url: string }> {
  return invokeEdge("create-checkout", { client_id: clientId, setup: true });
}

/** The operator's own $49/month Sanpo subscription checkout (review H31) —
 * platform account, not Connect. */
export function createOperatorCheckout(): Promise<{ url: string | null }> {
  return invokeEdge("operator-billing", { action: "checkout" });
}

/** Platform billing portal for the operator's Sanpo subscription. */
export function createOperatorPortal(): Promise<{ url: string }> {
  return invokeEdge("operator-billing", { action: "portal" });
}

/**
 * Create the auth account for an invited client via the public claim-signup
 * edge function (review H31) — the invite is validated server-side BEFORE
 * any account exists, so ClaimInvite no longer depends on public signUp and
 * the GoTrue signup toggle can be off. A refused invite comes back with the
 * 0039 outcome as the envelope code, remapped here onto the same
 * InviteClaimError the RPC path throws so the dead-end sentences stay
 * differentiated (H4).
 */
export async function claimSignup(
  token: string,
  email: string,
  password: string,
): Promise<void> {
  try {
    await invokeEdge("claim-signup", { token, email, password });
  } catch (e) {
    const code = e instanceof EdgeError ? e.code : undefined;
    if (code && code !== "claimed" && code in INVITE_CLAIM_MESSAGE) {
      throw new InviteClaimError(code as Exclude<InviteClaimOutcome, "claimed">);
    }
    throw e;
  }
}

/**
 * `already_charged` is returned by the edge function and was dropped by this
 * type, so no caller could tell a fresh charge from a no-op that found an
 * existing succeeded row — and BillingConsole announced "Recovered $22.00" for
 * money it had not moved (review M3).
 */
/**
 * Whether the signed-in account has a password at all (review M2, 0035).
 *
 * `SignIn` offers a magic link and no operator path ever sets a password, so
 * an operator can hold a perfectly good session and still have nothing to type
 * into the vault's re-auth. GoTrue cannot tell us — it returns the same
 * `invalid_credentials` for "wrong password" and "no password", deliberately,
 * so that sign-in is not an account oracle. The definer function reads
 * `auth.users.encrypted_password` and refuses to answer about anyone but you.
 */
export async function accountHasPassword(): Promise<boolean> {
  const { data, error } = await supabase.rpc("fn_account_has_password", {
    p_user: (await supabase.auth.getUser()).data.user?.id ?? "",
  });
  if (error) throw error;
  return data === true;
}

export function chargeOverage(
  walkId: string,
): Promise<{ payment: Payments; already_charged?: boolean }> {
  return invokeEdge("charge-overage", { walk_id: walkId });
}

// ── Stripe Connect (review B5) ─────────────────────────────────────────────
// Clients pay the operator directly: the operator is the merchant of record,
// so nothing can be charged until they have connected an account Stripe has
// enabled.
export interface ConnectStatus {
  connected: boolean;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
}

/**
 * Creating a plan is NOT a plain insert (review B6). A plan without a Stripe
 * Price cannot be checked out, and the review's fix is explicit that the
 * operator must not be asked to paste a `price_…` — so the edge function
 * mints the Product and Price on their connected account and writes the row
 * with the resulting id in one step.
 */
export function createPlan(body: {
  name: string;
  credits_per_cycle: number;
  price_pence: number;
  cycle: "weekly" | "monthly";
  rollover_policy: "none" | "capped" | "unlimited";
  rollover_cap?: number | null;
  rollover_expiry_days?: number | null;
  overage_rate_pence: number;
}): Promise<{ plan: Plans }> {
  return invokeEdge("create-plan", body);
}

export function connectStatus(): Promise<ConnectStatus> {
  return invokeEdge("connect-onboarding", { action: "status" });
}

/** Mints a single-use Stripe onboarding link. Short-lived, so it is fetched
 * at click time rather than held in state. */
export function connectStart(): Promise<{ url: string; account_id: string }> {
  return invokeEdge("connect-onboarding", { action: "start" });
}

export interface VaultGetResult {
  secret: string;
  label: string | null;
  entry_method: string;
}

export function vaultGet(body: {
  credential_id: string;
  purpose: string;
  password: string;
}): Promise<VaultGetResult> {
  return invokeEdge("credential-vault", { action: "get", ...body });
}

export function vaultPut(body: {
  credential_id?: string;
  property_id?: string;
  entry_method?: string;
  label?: string;
  secret: string;
  password: string;
}): Promise<{ credential: Record<string, unknown> }> {
  return invokeEdge("credential-vault", { action: "put", ...body });
}

export function vaultDelete(body: {
  credential_id: string;
  password: string;
}): Promise<{ revoked: boolean }> {
  return invokeEdge("credential-vault", { action: "delete", ...body });
}

// Built in later phases (07/06); typed now so screens can bind early.
export function changePlan(
  clientId: string,
  newPlanId: string,
): Promise<{ new_balance: number; pending?: boolean; intent_id?: string }> {
  return invokeEdge("change-plan", { client_id: clientId, new_plan_id: newPlanId });
}

export function billingPortal(clientId: string): Promise<{ url: string }> {
  return invokeEdge("billing-portal", { client_id: clientId });
}

export function materializeWalks(): Promise<{ created: number }> {
  return invokeEdge("materialize-walks", {});
}

// ── storage ────────────────────────────────────────────────────────────────
export async function uploadWalkPhoto(
  operatorId: string,
  walkId: string,
  file: Blob,
): Promise<string> {
  const path = `${operatorId}/${walkId}/${crypto.randomUUID()}.jpg`;
  const { error } = await supabase.storage.from("walk-photos").upload(path, file, {
    contentType: "image/jpeg",
  });
  if (error) throw new Error(error.message);
  return path;
}

export async function signedPhotoUrl(path: string, expiresIn = 3600): Promise<string> {
  const { data, error } = await supabase.storage.from("walk-photos")
    .createSignedUrl(path, expiresIn);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

// ── operators (phase 04) ───────────────────────────────────────────────────
/** Same round-trip removal as `getMyClient` — see the note there (review L11). */
export async function getMyOperator(userId?: string): Promise<Operators | null> {
  let uid = userId;
  if (!uid) {
    const { data: userData } = await supabase.auth.getUser();
    uid = userData.user?.id;
  }
  if (!uid) return null;
  const { data, error } = await supabase
    .from("operators").select("*").eq("id", uid).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function createOperator(row: {
  id: string;
  business_name: string;
  display_name: string;
  email: string;
  phone?: string | null;
  /** Which version of the terms was shown at signup (review H6). */
  terms_version?: string;
  terms_accepted_at?: string;
}): Promise<Operators> {
  const { data, error } = await supabase.from("operators").insert(row).select().single();
  return must(data, error);
}

export async function updateOperator(
  id: string,
  patch: TableUpdate<"operators">,
): Promise<Operators> {
  const { data, error } = await supabase
    .from("operators").update(patch).eq("id", id).select().single();
  return must(data, error);
}

export interface InvitePreview {
  full_name: string;
  business_name: string;
  already_claimed: boolean;
}

/** Preview an invite as the (just-signed-up) authenticated claimer. */
export async function previewInviteAuthed(token: string): Promise<InvitePreview | null> {
  const { data, error } = await supabase.rpc("fn_preview_invite", { p_token: token });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  return (row as InvitePreview | undefined) ?? null;
}

// ── access credentials (phase 05) ──────────────────────────────────────────
// IMPORTANT: never select * on access_credentials — the ciphertext column
// has no SELECT grant (invariant 2) and a wildcard select would be denied.
const CRED_META =
  "id, operator_id, property_id, entry_method, label, rotated_at, revoked_at, created_at";

export interface CredentialMeta {
  id: string;
  operator_id: string;
  property_id: string;
  entry_method: Database["public"]["Enums"]["entry_method"];
  label: string | null;
  rotated_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export async function listCredentials(propertyId?: string): Promise<CredentialMeta[]> {
  let query = supabase.from("access_credentials").select(CRED_META).is("revoked_at", null);
  if (propertyId) query = query.eq("property_id", propertyId);
  const { data, error } = await query.order("created_at").limit(LIST_PAGE);
  return must(data as CredentialMeta[] | null, error);
}

export interface CredentialLogRow {
  id: string;
  credential_id: string;
  accessed_by: string;
  action: Database["public"]["Enums"]["credential_action"];
  purpose: string | null;
  accessed_at: string;
  walk_id: string | null;
}

const CRED_LOG = "id, credential_id, accessed_by, action, purpose, accessed_at, walk_id";

export async function listCredentialLog(credentialId: string): Promise<CredentialLogRow[]> {
  const { data, error } = await supabase
    .from("credential_access_log")
    .select(CRED_LOG)
    .eq("credential_id", credentialId)
    .order("accessed_at", { ascending: false })
    .limit(LIST_PAGE);
  return must(data as CredentialLogRow[] | null, error);
}

/**
 * The trail for every credential on the signed-in CLIENT's properties
 * (review H3).
 *
 * The person whose door it is had no read path at all, which is what made the
 * audit trail unable to answer the question it exists for. RLS does the scoping
 * — `credential_access_log_client_select` in 0030 joins credential → property →
 * client — so this passes no ids and cannot be widened from here.
 *
 * Deliberately NOT selecting `ip` or `user_agent`: those describe the operator's
 * device, and a client does not need their walker's IP address to know their
 * door was opened.
 */
export async function listMyCredentialLog(limit = 100): Promise<CredentialLogRow[]> {
  const { data, error } = await supabase
    .from("credential_access_log")
    .select(CRED_LOG)
    .order("accessed_at", { ascending: false })
    .limit(limit);
  return must(data as CredentialLogRow[] | null, error);
}

// ── detailed walk listing (dashboard / calendar cards) ─────────────────────
export interface WalkDetailed extends Walks {
  walk_pets: { pets: { name: string } | null }[];
  property: { label: string } | null;
  client: { full_name: string } | null;
}

export async function listWalksDetailed(filters: WalkFilters = {}): Promise<WalkDetailed[]> {
  const { data, error } = await walkQuery(
    supabase
      .from("walks")
      .select("*, walk_pets(pets(name)), property:properties(label), client:clients(full_name)"),
    filters,
  );
  return must(data as unknown as WalkDetailed[] | null, error);
}

/**
 * Walks the nightly sweep flagged as abandoned (review M28).
 *
 * Deliberately unfiltered by date. That is the whole point: Today asks for
 * `{ date: today }`, so a walk started yesterday and never ended was invisible
 * on every screen in the product — never billed, never reported, and with
 * nothing anywhere to tell the operator it had happened.
 */
export async function listAbandonedWalks(): Promise<WalkDetailed[]> {
  const { data, error } = await supabase
    .from("walks")
    .select("*, walk_pets(pets(name)), property:properties(label), client:clients(full_name)")
    .eq("status", "in_progress")
    .not("abandoned_at", "is", null)
    .order("started_at")
    .limit(LIST_PAGE);
  return must(data as unknown as WalkDetailed[] | null, error);
}

export function walkPetNames(walk: WalkDetailed): string[] {
  return walk.walk_pets.flatMap((wp) => (wp.pets ? [wp.pets.name] : []));
}

// ── pet photos ─────────────────────────────────────────────────────────────
export async function uploadPetPhoto(
  operatorId: string,
  petId: string,
  file: Blob,
): Promise<string> {
  const path = `${operatorId}/${petId}/${crypto.randomUUID()}.jpg`;
  const { error } = await supabase.storage.from("pet-photos").upload(path, file, {
    contentType: "image/jpeg",
  });
  if (error) throw new Error(error.message);
  return path;
}

export async function signedPetPhotoUrl(path: string, expiresIn = 3600): Promise<string> {
  const { data, error } = await supabase.storage.from("pet-photos")
    .createSignedUrl(path, expiresIn);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

// ── recurring schedules (phase 06) ─────────────────────────────────────────
export async function createSchedule(
  row: TableInsert<"recurring_schedules">,
): Promise<RecurringSchedules> {
  const { data, error } = await supabase
    .from("recurring_schedules").insert(row).select().single();
  return must(data, error);
}

export async function updateSchedule(
  id: string,
  patch: TableUpdate<"recurring_schedules">,
): Promise<RecurringSchedules> {
  const { data, error } = await supabase
    .from("recurring_schedules").update(patch).eq("id", id).select().single();
  return must(data, error);
}

export async function listSchedulePets(scheduleId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("schedule_pets").select("pet_id").eq("schedule_id", scheduleId);
  return must(data, error).map((r) => r.pet_id);
}

export async function setSchedulePets(
  scheduleId: string,
  _operatorId: string,
  petIds: string[],
): Promise<void> {
  const { error } = await supabase.rpc("fn_set_schedule_pets", {
    p_schedule: scheduleId,
    p_pet_ids: petIds,
  });
  if (error) throw new Error(error.message);
}

/**
 * Deactivate a schedule and cancel its FUTURE materialized scheduled walks
 * (phase 06 deletion semantics — past walks are kept).
 */
export async function deactivateSchedule(scheduleId: string, today: string): Promise<void> {
  const { error } = await supabase.rpc("fn_deactivate_schedule", {
    p_schedule: scheduleId,
    p_today: today,
  });
  if (error) throw new Error(error.message);
}

// ── portal (phase 07) ──────────────────────────────────────────────────────
export interface MyOperatorView {
  id: string;
  display_name: string;
  business_name: string;
  cancellation_cutoff_hours: number;
  /** So the portal can state the retention window the notice describes (H6). */
  gps_retention_days: number;
}

/** The caller's operator identity + cutoff via v_my_operator (both personas). */
export async function getMyOperatorView(): Promise<MyOperatorView | null> {
  const { data, error } = await supabase
    .from("v_my_operator")
    .select("id, display_name, business_name, cancellation_cutoff_hours, gps_retention_days")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as MyOperatorView | null;
}

export async function getPlan(planId: string): Promise<Plans | null> {
  const { data, error } = await supabase
    .from("plans").select("*").eq("id", planId).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/** Client-persona cancellation (guarded server-side by the 0008 trigger). */
export async function cancelOwnWalk(walkId: string): Promise<void> {
  const { error } = await supabase
    .from("walks").update({ status: "cancelled" }).eq("id", walkId);
  if (error) throw new Error(error.message);
}

/** True while the walk can still be cancelled by the client. */
export function withinCancellationWindow(
  scheduledDate: string,
  windowStart: string,
  cutoffHours: number,
  nowMs: number = Date.now(),
): boolean {
  // Walk times are operator wall-clock (America/Chicago); interpret them in
  // that zone rather than the device's, so a traveling client isn't gated by
  // their local clock. This mirrors the 0008 guard for UI purposes — the
  // trigger remains authoritative.
  const start = businessWallClockToMs(scheduledDate, windowStart);
  return nowMs <= start - cutoffHours * 3600_000;
}

/**
 * PostgREST's "no rows returned" from a `.single()` — the only error that
 * genuinely means the record does not exist (review M39).
 *
 * Everything else a loader can throw — a dropped connection, an expired JWT,
 * a 5xx — means "we could not find out", and telling an operator standing
 * outside a client's door that the client does not exist is both wrong and
 * unrecoverable, because a not-found screen offers no retry.
 */
export function isNotFound(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "code" in err) {
    return (err as { code?: unknown }).code === "PGRST116";
  }
  return err instanceof Error && /PGRST116/.test(err.message);
}
