/**
 * Generate the Today plate's responsive variants (review M17).
 *
 * The approved plate is 875 x 1798 and that is ALL the pixels that exist: no
 * higher-resolution source exists anywhere in the repository or its history.
 * (`docs/reference/sanpo-today-locked-composition.png` is not one — it is the
 * composition reference, artwork *plus* UI, measured 18.57 dB PSNR against the
 * plate, and its own README says it "must not be embedded in the
 * application".) So the variants are downscales, and the review's other half —
 * "ship a 2x master" — is new artwork, not a code change.
 *
 * The source is the SHIPPED WebP rather than the lossless PNG master, which
 * does still exist in history at d313486. That is a second-generation encode,
 * so it was measured rather than waved through: against the lossless master
 * downscaled to the same size, encoding from the shipped plate scores
 * 35.15/35.46/36.01 dB at 438/640/750w, and encoding from the PNG master
 * 35.73/36.63/37.36 dB — 0.6 to 1.35 dB better for 2-3% more bytes, which is
 * nothing you can see in a watercolour wash. Two reasons not to spend it:
 * carrying a 2.25 MiB build-time-only input in the tree is a real cost, and
 * pinning to the shipped plate is the STRONGER guarantee — it proves each
 * variant derives from the exact artwork the app serves, rather than from a
 * file that could drift away from it.
 *
 * Widths are not a generic 1x/2x ladder. Each is a width the field is MEASURED
 * to take, so each candidate is the exact size some real device asks for:
 *
 *   438w  the field at 1440x900, the desktop viewport spec 07 names for
 *         testing — (900 - 0 nav) * 875/1798 = 438.0
 *   640w  the field's maximum: `--page-max` caps at 640px, so no device ever
 *         needs more than 640 CSS px
 *   750w  375 CSS px at DPR 2 — the commonest DPR-2 phone (iPhone SE class)
 *   875w  the master itself: every DPR-3 device, and every need above 750
 *
 * Encoding runs in Chromium, which is already a devDependency via
 * @playwright/test — no new dependency, and no image toolchain in this
 * container to reach for (there is no cwebp, ImageMagick, ffmpeg, PIL or
 * sharp). The honest residual: WebP bytes are the encoder's, so regenerating
 * against a different Chromium build can produce different bytes and therefore
 * different hashes. That is a deliberate act — update the hashes in
 * `verify-sanpo-assets.mjs` in the same commit and say why, exactly as the
 * WebP re-encode did.
 *
 *   node scripts/generate-today-plate-variants.mjs            # write variants
 *   node scripts/generate-today-plate-variants.mjs --check     # verify only
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const MASTER = fileURLToPath(
  new URL("../src/assets/illustrations/sanpo-today-indigo-emaki-background-approved-v1.webp", import.meta.url),
);

/**
 * The plate the variants are derived FROM, pinned by hash.
 *
 * Without this the generator would happily downscale whatever sits at that
 * path, so an unapproved plate could be laundered into four approved-looking
 * variants that `verify-sanpo-assets.mjs` would then be taught to accept. The
 * guard is the point: variants are only ever the approved artwork, smaller.
 */
const MASTER_SHA256 = "a34625fd300b21fc6103dd603fdd919ab1f95641789731642f83b05e93d89b6c";

export const PLATE_WIDTH = 875;
export const PLATE_HEIGHT = 1798;

/**
 * Quality 0.90. Measured against the master rendered at the same display
 * width: PSNR 37.40 dB at 438w/438px and 38.88 dB at 640w/640px, which is the
 * same neighbourhood as the 38.8 dB the original PNG -> WebP re-encode shipped
 * at. Raising it to 0.95 buys +1.4 dB for 38% more bytes, which is the wrong
 * side of the knee for artwork that is already a watercolour wash.
 */
const QUALITY = 0.9;

/** Derived widths — see the header for why each one exists. */
export const VARIANT_WIDTHS = [438, 640, 750];

export const variantPath = (width) =>
  fileURLToPath(
    new URL(
      `../src/assets/illustrations/sanpo-today-indigo-emaki-background-approved-v1-${width}w.webp`,
      import.meta.url,
    ),
  );

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function main() {
  const check = process.argv.includes("--check");
  const master = readFileSync(MASTER);
  const actual = sha256(master);
  if (actual !== MASTER_SHA256) {
    console.error(
      `refusing to generate: the plate at\n  ${MASTER}\nhashes ${actual}, not the approved ${MASTER_SHA256}.\n` +
        "Variants are downscales of the APPROVED artwork; generating them from anything else would " +
        "launder an unapproved plate through the hash guard.",
    );
    process.exit(1);
  }

  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH });
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    const encoded = await page.evaluate(
      async ({ b64, widths, quality, plateW, plateH }) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: "image/webp" });

        const source = await createImageBitmap(blob);
        if (source.width !== plateW || source.height !== plateH) {
          throw new Error(`master decoded to ${source.width}x${source.height}, expected ${plateW}x${plateH}`);
        }

        const out = [];
        for (const width of widths) {
          // Height is ROUNDED from the plate ratio rather than floored: the
          // e2e geometry spec asserts the rendered plate ratio to 2 decimal
          // places, and a variant whose own ratio drifts would fail it while
          // looking fine.
          const height = Math.round((plateH / plateW) * width);
          // `resizeQuality: "high"` is the explicitly good resampler;
          // drawImage's default scaling is not the same filter.
          const bitmap = await createImageBitmap(blob, {
            resizeWidth: width,
            resizeHeight: height,
            resizeQuality: "high",
          });
          const canvas = new OffscreenCanvas(width, height);
          canvas.getContext("2d").drawImage(bitmap, 0, 0);
          const variant = await canvas.convertToBlob({ type: "image/webp", quality });
          if (variant.type !== "image/webp") {
            throw new Error(`encoder returned ${variant.type}, not image/webp — this browser cannot encode WebP`);
          }
          const buf = new Uint8Array(await variant.arrayBuffer());
          out.push({ width, height, bytes: Array.from(buf) });
        }
        return out;
      },
      {
        b64: master.toString("base64"),
        widths: VARIANT_WIDTHS,
        quality: QUALITY,
        plateW: PLATE_WIDTH,
        plateH: PLATE_HEIGHT,
      },
    );

    let drift = false;
    for (const { width, height, bytes } of encoded) {
      const buf = Buffer.from(bytes);
      const path = variantPath(width);
      if (check) {
        let existing = null;
        try {
          existing = readFileSync(path);
        } catch {
          existing = null;
        }
        const same = existing !== null && sha256(existing) === sha256(buf);
        if (!same) drift = true;
        console.log(`${same ? "ok  " : "DRIFT"} ${width}x${height}  ${path.split("/").pop()}`);
      } else {
        writeFileSync(path, buf);
        console.log(
          `${width}x${height}  ${(buf.length / 1024).toFixed(1)} KiB  ${sha256(buf)}  ` +
            path.split("/").pop(),
        );
      }
    }
    if (check && drift) process.exit(1);
  } finally {
    await browser.close();
  }
}

// Only when RUN, never when imported: `scripts/today-plate.test.ts` imports
// `VARIANT_WIDTHS` from here to pin it against the widths the app actually
// ships, and a bare `await main()` would launch Chromium inside the test run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
