// The rules behind the operator's client and property edit forms (backlog 1).
//
// Client records were create-only: `updateClient` shipped with zero importers
// and no screen edited a name, email, phone or address after Roster created
// the row. The grants had allowed it since `0004`, so this was a missing
// surface rather than a missing capability — and two designs already depended
// on it. Spec 04 tells the operator that a wrongly-reserved invite address "is
// recoverable the ordinary way: the operator edits the client's email in the
// roster"; `fn_unbind_invite` (0042) deliberately does NOT clear `email`, so
// releasing a wrongly-claimed account reissues a token still bound to the
// wrong person's address. Neither recovery existed.
//
// The logic lives here rather than in the sheet because the consequences of an
// email edit are the interesting part and they belong somewhere a test can
// reach without rendering anything.

/** The three columns this form may write. `status` and `notes` are excluded. */
export interface ClientEditForm {
  full_name: string;
  email: string;
  phone: string;
}

export interface ClientEditable {
  auth_user_id: string | null;
  full_name: string;
  email: string | null;
  phone: string | null;
  purged_at?: string | null;
}

export interface PropertyEditForm {
  label: string;
  address_line1: string;
  city: string;
  postcode: string;
  access_notes_public: string;
}

export interface PropertyEditable {
  label: string;
  address_line1: string | null;
  city: string | null;
  postcode: string | null;
  access_notes_public: string | null;
}

/**
 * Empty means absent, everywhere.
 *
 * The Roster add-client form has always written `email.trim() || null`, and a
 * form that cleared a field to `""` instead would make two states that read
 * identically on screen and differently in every consumer: `send-notification`
 * skips on a falsy email but `fn_invite_signup_check` compares
 * `nullif(lower(trim(...)), '')` against the stored value, so `""` binds the
 * invite to nothing while looking set.
 */
const nullIfBlank = (s: string): string | null => s.trim() || null;

export const clientFormOf = (c: ClientEditable): ClientEditForm => ({
  full_name: c.full_name,
  email: c.email ?? "",
  phone: c.phone ?? "",
});

export const propertyFormOf = (p: PropertyEditable): PropertyEditForm => ({
  label: p.label,
  address_line1: p.address_line1 ?? "",
  city: p.city ?? "",
  postcode: p.postcode ?? "",
  access_notes_public: p.access_notes_public ?? "",
});

/** `full_name` is NOT NULL and the row's only human identifier. */
export function clientFormError(form: ClientEditForm): string | null {
  return form.full_name.trim() ? null : "A name is required.";
}

export function propertyFormError(form: PropertyEditForm): string | null {
  return form.label.trim() ? null : "A label is required.";
}

/**
 * Only what changed, or null when nothing did.
 *
 * A patch of every field would be harmless today — all three columns are in
 * the `0004` UPDATE grant and none carries a trigger — but "save" on an
 * untouched form would still rewrite `email`, and `email` is the column the
 * invite ladder reads. Sending only the difference means the surface cannot
 * have an effect the operator did not ask for.
 */
export function clientPatch(
  c: ClientEditable,
  form: ClientEditForm,
): Partial<Pick<ClientEditable, "full_name" | "email" | "phone">> | null {
  const next = {
    full_name: form.full_name.trim(),
    email: nullIfBlank(form.email),
    phone: nullIfBlank(form.phone),
  };
  const patch: Record<string, string | null> = {};
  if (next.full_name !== c.full_name) patch.full_name = next.full_name;
  if (next.email !== (c.email ?? null)) patch.email = next.email;
  if (next.phone !== (c.phone ?? null)) patch.phone = next.phone;
  return Object.keys(patch).length ? patch : null;
}

export function propertyPatch(
  p: PropertyEditable,
  form: PropertyEditForm,
): Partial<PropertyEditable> | null {
  const next: PropertyEditable = {
    label: form.label.trim(),
    address_line1: nullIfBlank(form.address_line1),
    city: nullIfBlank(form.city),
    postcode: nullIfBlank(form.postcode),
    access_notes_public: nullIfBlank(form.access_notes_public),
  };
  const patch: Record<string, string | null> = {};
  for (const key of Object.keys(next) as Array<keyof PropertyEditable>) {
    if (next[key] !== (p[key] ?? null)) patch[key] = next[key];
  }
  return Object.keys(patch).length ? patch : null;
}

/**
 * What changing the email actually does — the reason this form needs copy
 * rather than just a field.
 *
 * `clients.email` is the last rung of the claim ladder in BOTH
 * `fn_claim_invite` (0039/0041) and `fn_invite_signup_check` (0045): a NULL
 * email admits any address (and the first admitted one is then reserved into
 * the row), a non-NULL email admits only that address, compared
 * `lower(trim(...))` on both sides. So on an unclaimed client this field is
 * not contact detail — it decides who may become the account.
 *
 * Once `auth_user_id` is set the ladder stops at `already_claimed` and never
 * reaches the email rung. The login identity is `auth.users.email`, written
 * once by `claim-signup`'s `createUser` and updated by nothing here, so an
 * edit after claiming changes where mail is sent and nothing else.
 */
export type EmailEditEffect =
  | "unchanged"
  | "contact-only"
  | "binds-invite"
  | "rebinds-invite"
  | "opens-invite";

export function emailEditEffect(c: ClientEditable, form: ClientEditForm): EmailEditEffect {
  const next = nullIfBlank(form.email);
  const current = c.email ?? null;
  // Case-insensitively equal is not a change the ladder can see: it compares
  // `lower(trim(...))` on both operands, so "Amelia@x.test" and "amelia@x.test"
  // admit exactly the same claimant. Warning about that would be a false alarm
  // on a capitalisation fix.
  const same = next === current
    || (next !== null && current !== null && next.toLowerCase() === current.toLowerCase());
  if (same) return "unchanged";
  if (c.auth_user_id) return "contact-only";
  if (current === null) return "binds-invite";
  if (next === null) return "opens-invite";
  return "rebinds-invite";
}

/**
 * A purged client (review H5) is a tombstone: `fn_purge_client` sets
 * `full_name` to 'Deleted client' and nulls the email. The UPDATE grant still
 * covers those columns, so nothing in the database stops an edit re-personalising
 * an erasure that was performed on request — which is why the affordance is
 * withheld here rather than left to the operator's judgement.
 */
export const isEditable = (c: ClientEditable): boolean => !c.purged_at;
