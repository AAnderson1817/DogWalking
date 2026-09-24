// Review H6: the privacy notice and terms, and the versions a consent record
// points at.
//
// ── Why the version is a constant, and why it is guarded ───────────────────
//
// Recording `notice_accepted_at` alone is nearly worthless: if the document can
// change underneath the timestamp, the record says somebody agreed to something
// but not to what. So every acceptance stores a VERSION, and
// `app/scripts/legal-version.test.ts` hashes the content below and fails if the
// text changed without the version changing. That guard is what makes the
// stored version mean anything — without it, this is decoration.
//
// ── What this text is, and is not ──────────────────────────────────────────
//
// It is a factually accurate description of what this system actually does with
// data, written from the code: the tables, the edge functions, the five
// services that receive it, and the push service a browser uses once
// notifications are on. Every claim below was checked against a call site.
//
// What a copy leaves out is quoted, not described: the bullets under "A copy
// of your data" are the `not_included` sentences `fn_export_client_data`
// writes into every copy, and `app/scripts/legal-version.test.ts` fails if
// the two differ. Described in this file's own words, the notice once said
// the email setting was left out while the copy carried it.
//
// It is NOT legal advice and has not been reviewed by a lawyer. That is
// recorded as an owner action in `docs/dev/owner-actions.md`, not buried here,
// because a notice that hedges about its own validity is worse than useless to
// the person reading it — they need to know what happens to their data, and
// that part is true.

export interface LegalSection {
  heading: string;
  paragraphs: string[];
  /** Rendered as a list under the paragraphs. */
  bullets?: string[];
}

export interface LegalDocument {
  /** Stored on the consent record. Bump whenever the text changes. */
  version: string;
  title: string;
  updated: string;
  intro: string;
  sections: LegalSection[];
}

export const PRIVACY: LegalDocument = {
  version: "2026-09-25",
  title: "Privacy notice",
  updated: "25 September 2026",
  intro:
    "Sanpo is the software your walker uses to run their business. This notice describes what the software holds about you, who else it reaches, and how to get a copy or have it erased.",
  sections: [
    {
      heading: "Who holds your data",
      paragraphs: [
        "Your walker decides what to collect about you and why — they are the business you are dealing with. Sanpo provides the software and the systems it runs on, and processes your data on their instructions.",
        "If you want your data corrected, exported or erased, ask your walker. They can do all three from within Sanpo.",
      ],
    },
    {
      heading: "What is held",
      paragraphs: [
        "Your walker enters most of this before you have an account, because they need it to do the job:",
      ],
      bullets: [
        "Your name, email address, phone number, and any notes your walker keeps about you.",
        "Your address, and any notes about getting in — where to leave a parcel, which gate sticks.",
        "Entry credentials: a door code, lockbox combination or alarm sequence. These are encrypted, and every time one is viewed it is recorded with who viewed it and why.",
        "Your pets: name, breed, size, temperament, medical notes, medication, feeding notes, and your vet's details.",
        "Each visit: the date and time, how long it lasted, a route recorded from your walker's phone, photos they take, and any notes they leave.",
        "Billing: your plan, your credit balance, and a record of each payment.",
        "If you turn on notifications in your Sanpo account: the address your browser gives Sanpo for sending them to that device, and which browser it is.",
      ],
    },
    {
      heading: "Who else it reaches",
      paragraphs: [
        "Sanpo uses five other services to run, and a sixth once you turn on notifications. Each receives only what it needs:",
      ],
      bullets: [
        "Supabase — the database, sign-in, file storage and live updates. Everything described above is stored here.",
        "Stripe — payments. Receives your name and email address to create a customer record, and handles your card details directly. Sanpo never sees or stores your card number.",
        "Resend — email delivery. Receives your email address and the contents of the messages sent to you.",
        "Mapbox — map imagery. When a map is displayed, Mapbox receives requests for the map tiles around that location, which reveals roughly where the visit took place.",
        "Vercel — hosting for the website itself, which receives ordinary web request logs.",
        "If you turn on notifications, each one reaches your device through the push service your browser uses (Google's, for Chrome). It is encrypted so that only your browser can read it; the push service learns that a message was sent to your device, and when.",
      ],
    },
    {
      heading: "How long it is kept",
      paragraphs: [
        "Route traces are deleted automatically once they pass the window your walker sets — 365 days unless they change it. The visit itself, and its billing record, are kept.",
        "Everything else is kept while you are a client. When your walker erases your record, your address, entry codes, pet notes, route traces and photos are destroyed, and so is any record that you turned email back on. Three things survive on purpose: the billing ledger, because it is a financial record your walker is required to keep; the log of who viewed your entry codes, because a record of who opened your door is not something the person who opened it should be able to delete; and, if you unsubscribed from Sanpo email, the address and when you asked, so that erasing a record never starts email to that address again.",
      ],
    },
    {
      heading: "A copy of your data",
      paragraphs: [
        "You can ask your walker for a copy of what Sanpo holds about you, and they can produce it as a file from within Sanpo: your details, addresses and pets, your schedules, each visit with its route and photos, when your entry codes were viewed or changed and why, your plan and its changes, your credits and payments, and the notes and notifications your walker keeps about you.",
        "The file lists what it leaves out, and why, in these words:",
      ],
      bullets: [
        "The entry codes themselves: they are encrypted, and only the vault can read them.",
        "Your walker's IP address and device on the entry-code log, and whether your walker has read their notifications about you: those describe your walker, not you.",
        "The address typed on every claim of your account through your invite link, and on every attempt your invite refused, yours included. The file says when each was made, how it ended, and whether it came from your account.",
        "The time and network address Sanpo keeps for requests to create an account through your invite link, yours included, to limit how often the link can be tried. Your walker cannot read them; ask them to ask Sanpo.",
        "The messages Sanpo sent you, the record of when and why your email was turned off or back on, and the devices you turned notifications on for: your walker cannot see these, so a copy your walker makes cannot hold them. The file says only whether email to you is turned off, which is all your walker is shown. You can read your messages in your Sanpo account; for the rest, ask your walker to ask Sanpo.",
        "Keys that only work inside Sanpo or Stripe: the keys in your invite and unsubscribe links, your devices' notification keys, and Stripe's identifiers for you and your payments. A note on a credit entry is copied as it was written, and sometimes names the payment it came from.",
        "Bookkeeping: when each notification was delivered, when each row last changed, and how a plan change was carried out. The plans before and after each change, and every charge, are in the file.",
        "Your sign-in account (the address you sign in with, and when), and the copies Sanpo keeps of the payment messages Stripe sends it, which hold your name, email and billing address as Stripe has them. Your walker cannot read either; ask them to ask Sanpo.",
      ],
    },
    {
      heading: "Your choices",
      paragraphs: [
        "You can ask your walker to erase what Sanpo holds about you. Erasure is immediate and cannot be undone. Ask for a copy first if you want one: once your data is erased, a copy can no longer be made.",
        "Every email carries an unsubscribe link that works without signing in, including if you received it by mistake and have no account here.",
        "If you unsubscribe and later want email again, you can turn it back on from your Sanpo account, as long as it is the address you sign in with and, after unsubscribing, you sign in by opening a link sent to it. Sanpo records the address, the account that turned it back on, when, and when you had unsubscribed.",
      ],
    },
  ],
};

export const TERMS: LegalDocument = {
  version: "2026-08-29",
  title: "Terms of service",
  updated: "29 August 2026",
  intro:
    "These terms cover your use of the Sanpo software. Your arrangement for the walks themselves — price, cancellation, what happens if your dog is unwell — is between you and your walker.",
  sections: [
    {
      heading: "What Sanpo is",
      paragraphs: [
        "Sanpo is software for independent pet-care professionals. Your walker runs their own business; Sanpo is not a walking service, does not employ or vet walkers, and is not a party to your arrangement with them.",
        "Payments are taken by your walker through their own Stripe account. They are the merchant on your statement.",
      ],
    },
    {
      heading: "Your account",
      paragraphs: [
        "Keep your password to yourself. If you think somebody else has access to your account, tell your walker and change it.",
        "An invitation link is personal to you. It expires, and your walker can withdraw it.",
      ],
    },
    {
      heading: "What the software does and does not promise",
      paragraphs: [
        "Route recording depends on your walker's phone. A phone that locks, loses signal or runs out of battery will leave gaps, and Sanpo marks those gaps rather than drawing a line across them. A recorded route is evidence of a visit; it is not a guarantee of one.",
        "Sanpo is provided as-is. It does not guarantee uninterrupted availability.",
      ],
    },
    {
      heading: "Billing",
      paragraphs: [
        "Plans are sold as credits. A visit is either covered by a credit or charged at your walker's overage rate — never part of each.",
        "Cancellation windows are set by your walker and shown when you book.",
      ],
    },
  ],
};

export const LEGAL_DOCUMENTS = { privacy: PRIVACY, terms: TERMS } as const;
export type LegalSlug = keyof typeof LEGAL_DOCUMENTS;
