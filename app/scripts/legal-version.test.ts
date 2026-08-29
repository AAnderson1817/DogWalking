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
 * `app/src/lib/legal.ts`, run this test, and paste the printed hash in.
 * Bumping the version is the point — every acceptance recorded against the old
 * version keeps pointing at the old text, which is what a consent record is
 * for.
 */

/** version -> sha256 of the document's rendered text. */
const PINNED: Record<string, string> = {
  privacy: "fe9fc1ec7c4ef5c09df65601ce7b4fa56b73ea6420729b93eebe0cf093597858",
  terms: "c3c4bf9a14fc266090630d49a45629d87c009ffebc54962d509e0e6016a63707",
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
      if (actual !== PINNED[slug]) {
        throw new Error(
          `The ${slug} document changed.\n\n` +
            `If that was intentional: bump its \`version\` in app/src/lib/legal.ts, ` +
            `then set PINNED.${slug} to:\n  ${actual}\n\n` +
            `Every consent already recorded against version ${doc.version} points at the ` +
            `OLD text, which is what makes the record evidence. Changing the words without ` +
            `changing the version silently rewrites what people agreed to.`,
        );
      }
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
    expect(text).toContain("copy of everything");
    expect(text).toContain("unsubscribe");
  });
});
