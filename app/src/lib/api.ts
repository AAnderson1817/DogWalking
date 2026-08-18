// Typed data-access layer (spec 06). ALL reads/writes and edge invocations
// flow through here; screens never call supabase.from directly. Wrappers for
// later-phase surfaces exist as typed stubs so screens can bind early.
import { businessWallClockToMs } from "./format";
import { supabase } from "./supabase";
import type { Database } from "./types";
import type {
  Clients,
  CreditLedger,
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

// ── clients ────────────────────────────────────────────────────────────────
export async function listClients(): Promise<Clients[]> {
  const { data, error } = await supabase.from("clients").select("*").order("full_name");
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
export async function getMyClient(): Promise<Clients | null> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return null;
  const { data, error } = await supabase
    .from("clients").select("*").eq("auth_user_id", uid).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

// ── pets ───────────────────────────────────────────────────────────────────
export async function listPets(clientId?: string): Promise<Pets[]> {
  let query = supabase.from("pets").select("*").eq("active", true).order("name");
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
  let query = supabase.from("properties").select("*").order("label");
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
  const { data, error } = await supabase.from("service_types").select("*").order("duration_minutes");
  return must(data, error);
}

export async function listPlans(): Promise<Plans[]> {
  const { data, error } = await supabase.from("plans").select("*").order("price_pence");
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
}

export async function listWalks(filters: WalkFilters = {}): Promise<Walks[]> {
  let query = supabase.from("walks").select("*");
  if (filters.clientId) query = query.eq("client_id", filters.clientId);
  if (filters.date) query = query.eq("scheduled_date", filters.date);
  if (filters.from) query = query.gte("scheduled_date", filters.from);
  if (filters.to) query = query.lte("scheduled_date", filters.to);
  if (filters.status) query = query.eq("status", filters.status);
  const { data, error } = await query
    .order("scheduled_date")
    .order("window_start");
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
    .from("walk_pets").select("pets(*)").eq("walk_id", walkId);
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
    .from("walk_photos").select("*").eq("walk_id", walkId).order("taken_at");
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
    .from("walk_gps_points").select("*").eq("walk_id", walkId).order("recorded_at");
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
  let query = supabase.from("recurring_schedules").select("*").eq("active", true);
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
    .order("seq", { ascending: false });
  return must(data, error);
}

export async function listPayments(clientId?: string): Promise<Payments[]> {
  let query = supabase.from("payments").select("*").order("created_at", { ascending: false });
  if (clientId) query = query.eq("client_id", clientId);
  const { data, error } = await query;
  return must(data, error);
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
  let query = supabase.from("notifications").select("*").order("created_at", { ascending: false });
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

export async function claimInvite(token: string): Promise<string> {
  const { data, error } = await supabase.rpc("fn_claim_invite", { p_token: token });
  if (error) throw new Error(error.message);
  return data as string;
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
    if (response) {
      try {
        const envelope = (await response.json()) as Envelope<T> | null;
        const message = envelope?.error?.message;
        if (typeof message === "string" && message.trim() !== "") detail = message;
      } catch {
        // No body, or not JSON. Fall back to the SDK's message rather than
        // masking the failure with a parse error.
      }
    }
    throw new Error(detail ?? error.message);
  }
  if (!data?.ok || data.data === undefined) {
    throw new Error(data?.error?.message ?? `${name} failed`);
  }
  return data.data;
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

/**
 * `already_charged` is returned by the edge function and was dropped by this
 * type, so no caller could tell a fresh charge from a no-op that found an
 * existing succeeded row — and BillingConsole announced "Recovered $22.00" for
 * money it had not moved (review M3).
 */
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
export async function getMyOperator(): Promise<Operators | null> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
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
  const { data, error } = await query.order("created_at");
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
    .order("accessed_at", { ascending: false });
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
  let query = supabase
    .from("walks")
    .select("*, walk_pets(pets(name)), property:properties(label), client:clients(full_name)");
  if (filters.clientId) query = query.eq("client_id", filters.clientId);
  if (filters.date) query = query.eq("scheduled_date", filters.date);
  if (filters.from) query = query.gte("scheduled_date", filters.from);
  if (filters.to) query = query.lte("scheduled_date", filters.to);
  if (filters.status) query = query.eq("status", filters.status);
  const { data, error } = await query.order("scheduled_date").order("window_start");
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
}

/** The caller's operator identity + cutoff via v_my_operator (both personas). */
export async function getMyOperatorView(): Promise<MyOperatorView | null> {
  const { data, error } = await supabase
    .from("v_my_operator")
    .select("id, display_name, business_name, cancellation_cutoff_hours")
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
