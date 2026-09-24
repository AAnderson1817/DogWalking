import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LEGAL_DOCUMENTS, type LegalDocument } from "../src/lib/legal.js";

/**
 * Review H6. A consent record stores WHICH version of a document somebody
 * accepted. That is only worth storing if the version cannot drift from the
 * text — otherwise `notice_version = '2026-08-29'` proves that a person agreed
 * to something, and nothing about what.
 *
 * So the content is hashed and pinned. Editing a document without bumping its
 * version fails here, which is the entire mechanism by which the stored
 * version means anything.
 *
 * When you legitimately change a document: bump `version` in
 * `app/src/lib/legal.ts`, run this test, and ADD the printed hash under the
 * new version. Bumping the version is the point — every acceptance recorded
 * against the old version keeps pointing at the old text, which is what a
 * consent record is for.
 *
 * The pins are keyed by version, not by document. Keyed by document, as they
 * first were, the one pin was simply updated to the new hash: a text change
 * with no bump passed (measured, 6 of 6, while bumping the notice for 0054),
 * and this test's own message told whoever changed the text to do exactly
 * that. Keyed by version, the failure names the bump as the fix, and the only
 * way to pass without one is to rewrite a hash already pinned for a version
 * people accepted. This test cannot see that edit: it has no history. What it
 * does is make the edit a visible change to a published pin, which review
 * refuses. A version that has never merged has been accepted by nobody, so
 * its pin may still be rewritten while the change that introduces it is open.
 */

/** document -> version -> sha256 of that version's rendered text. Append-only. */
const PINNED: Record<string, Record<string, string>> = {
  privacy: {
    "2026-08-29": "fe9fc1ec7c4ef5c09df65601ce7b4fa56b73ea6420729b93eebe0cf093597858",
    // 0054: turning email back on, what survives erasure of an unsubscribe,
    // and what the export file holds.
    "2026-09-24": "dd6b0cdf77eaeb9539fc634d05e8daa2520556f8bd8bfc17a7c5c222e8eaa48e",
  },
  terms: {
    "2026-08-29": "c3c4bf9a14fc266090630d49a45629d87c009ffebc54962d509e0e6016a63707",
  },
};

/**
 * Everything a reader actually sees, in order. Deliberately excludes `version`
 * itself: hashing it would make every version bump self-satisfying, and the
 * check would pass for a document whose text changed at the same time.
 */
function renderedText(doc: LegalDocument): string {
  return [
    doc.title,
    doc.updated,
    doc.intro,
    ...doc.sections.flatMap((s: LegalDocument["sections"][number]) => [s.heading, ...s.paragraphs, ...(s.bullets ?? [])]),
  ].join("\n");
}

function hash(doc: LegalDocument): string {
  return createHash("sha256").update(renderedText(doc), "utf8").digest("hex");
}

describe("legal documents", () => {
  for (const [slug, doc] of Object.entries(LEGAL_DOCUMENTS) as Array<[string, LegalDocument]>) {
    it(`${slug} text matches the hash pinned for version ${doc.version}`, () => {
      const actual = hash(doc);
      const pinned = PINNED[slug]?.[doc.version];
      if (pinned === undefined) {
        throw new Error(
          `The ${slug} document is at version ${doc.version}, which has no pinned hash.\n\n` +
            `If this is a new version, add it: PINNED.${slug}["${doc.version}"] = "${actual}"`,
        );
      }
      if (actual !== pinned) {
        throw new Error(
          `The ${slug} document changed, but its version (${doc.version}) did not.\n\n` +
            `If that was intentional: bump its \`version\` in app/src/lib/legal.ts and add ` +
            `the printed hash under the new version. Do not change the hash pinned for ` +
            `${doc.version}: every consent already recorded against it points at the OLD ` +
            `text, which is what makes the record evidence. Changing the words without ` +
            `changing the version silently rewrites what people agreed to.\n\n` +
            `The current text hashes to:\n  ${actual}`,
        );
      }
    });

    // A document reverted to an older version, or a version pinned and never
    // shipped, both leave the table and the document disagreeing about which
    // text is current.
    it(`${slug} is on the newest version pinned for it`, () => {
      const versions = Object.keys(PINNED[slug] ?? {}).sort();
      expect(versions.length).toBeGreaterThan(0);
      expect(doc.version).toBe(versions[versions.length - 1]);
    });

    it(`${slug} has a version, a date and some content`, () => {
      expect(doc.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(doc.updated.length).toBeGreaterThan(0);
      expect(doc.sections.length).toBeGreaterThan(0);
      for (const s of doc.sections) {
        expect(s.heading.length).toBeGreaterThan(0);
        expect(s.paragraphs.length + (s.bullets?.length ?? 0)).toBeGreaterThan(0);
      }
    });
  }

  /**
   * The notice names the services that receive data. If one is added to the
   * product and not to this list, the notice becomes false — so the list is
   * asserted against the names, and adding a subprocessor means editing the
   * document (which then fails the hash until the version is bumped).
   */
  it("the privacy notice names every subprocessor the code sends data to", () => {
    const text = renderedText(LEGAL_DOCUMENTS.privacy);
    for (const service of ["Supabase", "Stripe", "Resend", "Mapbox", "Vercel"]) {
      expect(text).toContain(service);
    }
  });

  /** Erasure and export are the two rights the product actually implements. */
  it("the privacy notice describes the paths that exist", () => {
    const text = renderedText(LEGAL_DOCUMENTS.privacy).toLowerCase();
    expect(text).toContain("erase");
    expect(text).toContain("as a file");
    expect(text).toContain("unsubscribe");
  });

  /**
   * The export (`fn_export_client_data`, 0040) holds the client row's contact
   * fields, properties, pets, walks, entry-credential labels, the ledger and
   * payments. It does not hold route traces, photos or the credential access
   * log, among other things, so a notice promising "everything" is false, and
   * this notice said so until 0054's review caught the new version repeating
   * it. Growing the export would let the claim come back; until then it stays
   * out, and the notice names what the file leaves out.
   */
  it("the privacy notice does not promise an export of everything", () => {
    const text = renderedText(LEGAL_DOCUMENTS.privacy).toLowerCase();
    expect(text).not.toMatch(/copy of everything|everything held about you/);
    for (const omitted of ["route traces", "photos", "who viewed your entry codes"]) {
      expect(text).toContain(`${omitted}`);
    }
    expect(text).toContain("left out");
  });
});
