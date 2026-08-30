import { describe, expect, it } from "vitest";
import {
  clientFormError,
  clientFormOf,
  clientPatch,
  emailEditEffect,
  isEditable,
  propertyFormError,
  propertyFormOf,
  propertyPatch,
  type ClientEditable,
  type PropertyEditable,
} from "./client-edit";

const client = (over: Partial<ClientEditable> = {}): ClientEditable => ({
  auth_user_id: null,
  full_name: "Amelia Hart",
  email: "amelia@sanpo.test",
  phone: "+1 555-0101",
  purged_at: null,
  ...over,
});

const property = (over: Partial<PropertyEditable> = {}): PropertyEditable => ({
  label: "Home",
  address_line1: "12 Wabash Ave",
  city: "Chicago",
  postcode: "60601",
  access_notes_public: null,
  ...over,
});

describe("clientPatch", () => {
  it("is null when the operator opened the sheet and changed nothing", () => {
    const c = client();
    expect(clientPatch(c, clientFormOf(c))).toBeNull();
  });

  it("carries only the field that changed", () => {
    const c = client();
    expect(clientPatch(c, { ...clientFormOf(c), phone: "+1 555-0199" }))
      .toEqual({ phone: "+1 555-0199" });
  });

  it("writes null, not an empty string, for a cleared field", () => {
    // `""` and NULL read identically on screen and differently everywhere
    // else: send-notification skips a falsy email, while the invite ladder
    // compares `nullif(lower(trim(...)), '')` — so `""` binds the invite to
    // nothing while looking set.
    const c = client();
    expect(clientPatch(c, { ...clientFormOf(c), email: "   " }))
      .toEqual({ email: null });
  });

  it("treats a whitespace-only edit of an already-null field as no change", () => {
    const c = client({ phone: null });
    expect(clientPatch(c, { ...clientFormOf(c), phone: "  " })).toBeNull();
  });

  it("trims what it does send", () => {
    const c = client();
    expect(clientPatch(c, { ...clientFormOf(c), full_name: "  Amelia Hart-Osei  " }))
      .toEqual({ full_name: "Amelia Hart-Osei" });
  });

  it("never writes a column outside the three the form owns", () => {
    // `status` and `notes` sit in the same 0004 UPDATE grant. `status` is
    // written by three invite-lifecycle functions, so an operator setting it
    // by hand can desynchronise the row from its invite state; `notes` has no
    // SELECT grant since 0043, so anything written there can never be read
    // back. Both are excluded by construction, and this is the assertion that
    // keeps a later field from arriving by accident.
    const c = client();
    const patch = clientPatch(c, {
      full_name: "New Name",
      email: "new@sanpo.test",
      phone: "+1 555-0000",
    });
    expect(Object.keys(patch ?? {}).sort()).toEqual(["email", "full_name", "phone"]);
  });
});

describe("clientFormError", () => {
  it("requires a name — the row's only human identifier and NOT NULL", () => {
    expect(clientFormError({ full_name: "   ", email: "", phone: "" }))
      .toBe("A name is required.");
    expect(clientFormError({ full_name: "Ben", email: "", phone: "" })).toBeNull();
  });
});

describe("emailEditEffect", () => {
  const form = (c: ClientEditable, email: string) => ({ ...clientFormOf(c), email });

  it("says nothing when the address did not change", () => {
    const c = client();
    expect(emailEditEffect(c, form(c, "amelia@sanpo.test"))).toBe("unchanged");
  });

  it("does not cry wolf over capitalisation", () => {
    // Both ladders compare `lower(trim(...))` on both operands, so these two
    // strings admit exactly the same claimant. Warning here would train the
    // operator to ignore the warning that matters.
    const c = client();
    expect(emailEditEffect(c, form(c, "Amelia@Sanpo.TEST"))).toBe("unchanged");
  });

  it("is contact-only once the client has an account", () => {
    // The ladder stops at `already_claimed` and never reaches the email rung;
    // the login is auth.users.email, which nothing here writes.
    const c = client({ auth_user_id: "user-9" });
    expect(emailEditEffect(c, form(c, "moved@sanpo.test"))).toBe("contact-only");
  });

  it("stays contact-only for a claimed client who never had an address", () => {
    // Reachable, and the case that catches an effect ladder testing the invite
    // before the account: `fn_claim_invite` (0041:118-126) writes auth_user_id,
    // status and the notice columns and never touches `email`, so a client
    // created with no address and claimed through /claim/:token is claimed with
    // `email` still NULL. Telling that operator they are "binding an invite" on
    // an account that already exists is simply false.
    const c = client({ auth_user_id: "user-9", email: null });
    expect(emailEditEffect(c, form(c, "amelia@sanpo.test"))).toBe("contact-only");
  });

  it("stays contact-only when a claimed client's address is cleared", () => {
    const c = client({ auth_user_id: "user-9" });
    expect(emailEditEffect(c, form(c, ""))).toBe("contact-only");
  });

  it("binds an unbound invite when an address is added", () => {
    const c = client({ email: null });
    expect(emailEditEffect(c, form(c, "amelia@sanpo.test"))).toBe("binds-invite");
  });

  it("transfers the invite when the address changes", () => {
    const c = client();
    expect(emailEditEffect(c, form(c, "typo-fixed@sanpo.test"))).toBe("rebinds-invite");
  });

  it("re-opens the invite to anyone holding the link when the address is cleared", () => {
    // The dangerous direction, and the one with no other signal on screen:
    // a NULL email admits ANY address, and fn_invite_signup_check then
    // reserves whichever one arrives first.
    const c = client();
    expect(emailEditEffect(c, form(c, ""))).toBe("opens-invite");
    expect(emailEditEffect(c, form(c, "   "))).toBe("opens-invite");
  });
});

describe("isEditable", () => {
  it("withholds editing from a purged client", () => {
    // fn_purge_client (H5) writes the tombstone 'Deleted client' and nulls the
    // email. The UPDATE grant still covers both columns, so nothing in the
    // database stops an edit re-personalising an erasure done on request.
    expect(isEditable(client({ purged_at: "2026-08-01T00:00:00Z" }))).toBe(false);
    expect(isEditable(client())).toBe(true);
  });
});

describe("propertyPatch", () => {
  it("is null when nothing changed", () => {
    const p = property();
    expect(propertyPatch(p, propertyFormOf(p))).toBeNull();
  });

  it("carries only what changed and nulls a cleared field", () => {
    const p = property();
    expect(propertyPatch(p, { ...propertyFormOf(p), city: "Evanston", postcode: "  " }))
      .toEqual({ city: "Evanston", postcode: null });
  });

  it("never writes client_id, operator_id or the address line the form omits", () => {
    // `properties.client_id` IS in the UPDATE grant, so re-parenting a property
    // to another client is something the database would permit. The form does
    // not offer it, and this asserts the patch cannot acquire it. address_line2
    // is left out in both directions so the add and edit forms stay symmetric.
    const p = property();
    const patch = propertyPatch(p, { ...propertyFormOf(p), label: "Front door" });
    expect(Object.keys(patch ?? {})).toEqual(["label"]);
  });

  it("requires a label — NOT NULL, and the only thing telling two doors apart", () => {
    expect(propertyFormError({ label: " ", address_line1: "", city: "", postcode: "", access_notes_public: "" }))
      .toBe("A label is required.");
  });
});
