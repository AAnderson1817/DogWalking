// Typed data-access layer (spec 06). ALL reads/writes and edge invocations
// flow through here; screens never call supabase.from directly. Wrappers for
// later-phase surfaces exist as typed stubs so screens can bind early.
import { supabase } from "./supabase";
import type { Database } from "./types";
import type {
  Clients,
  CreditLedger,
  Notifications,
  Operators,
  Payments,
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

async function invokeEdge<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<Envelope<T>>(name, { body });
  if (error) throw new Error(error.message);
  if (!data?.ok || data.data === undefined) {
    throw new Error(data?.error?.message ?? `${name} failed`);
  }
  return data.data;
}

export interface CompleteWalkResult {
  walk: Walks;
  billing: {
    outcome: "debited" | "overage";
    cost_credits?: number;
    charged_pence?: number;
    payment_status?: string;
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

export function chargeOverage(walkId: string): Promise<{ payment: Payments }> {
  return invokeEdge("charge-overage", { walk_id: walkId });
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
  key_location_hint?: string;
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
export function changePlan(clientId: string, newPlanId: string): Promise<{ new_balance: number }> {
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
