import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const approved = {
  "../public/icons/favicon-64.png":
    "287bb24c9f932b0c92f59cd95514f9f331fd936a92ed41f3f9d978eb7aeed0f3",
  "../public/icons/icon-192.png":
    "131ac6e7dafdf7e4cd3c2bb067b11e8bc1e854e4ccae3f348b5e4325347d9cb1",
  "../public/icons/icon-512.png":
    "e07da61c1d5876b1ffbe853337eeb842115884e7a327f50880e4d65644138641",
  "../public/icons/icon-maskable-192.png":
    "131ac6e7dafdf7e4cd3c2bb067b11e8bc1e854e4ccae3f348b5e4325347d9cb1",
  "../public/icons/icon-maskable-512.png":
    "e07da61c1d5876b1ffbe853337eeb842115884e7a327f50880e4d65644138641",
  "../src/assets/brand/sanpo-app-icon-192px-approved-v1.png":
    "131ac6e7dafdf7e4cd3c2bb067b11e8bc1e854e4ccae3f348b5e4325347d9cb1",
  "../src/assets/brand/sanpo-app-icon-512px-approved-v1.png":
    "e07da61c1d5876b1ffbe853337eeb842115884e7a327f50880e4d65644138641",
  "../src/assets/brand/sanpo-app-icon-64px-approved-derivative-v1.png":
    "287bb24c9f932b0c92f59cd95514f9f331fd936a92ed41f3f9d978eb7aeed0f3",
  "../src/assets/brand/sanpo-app-icon-master-approved-v1.png":
    "084de0ddb51e594b9ada29f67035ed872dd4ea023113022aef03f777aa068c4e",
  "../src/assets/brand/sanpo-app-icon-master-approved-v1.svg":
    "303cac9437b5239dab2a856027f294a2e65966432a222f35140e87892bfd7766",
  "../src/assets/brand/sanpo-corporate-master-approved-v1.svg":
    "f8a61b56b5c6d2555b65465372bfbb1b39b2afef6d2ab0522c3d5f9095d180c0",
  "../src/assets/brand/sanpo-explanatory-lockup-approved-v1.svg":
    "893bd5e87d8447169f4226724522ee58a1885ac1c4cc2a286e19610cbd74d7c4",
  // Re-encoded from the approved PNG master to WebP q95 (same 875x1798
  // pixels, PSNR 38.8 dB, 2.25 MiB -> 437 KiB). Artwork is unchanged, so it
  // stays "v1"; the PNG master is in git history at d313486.
  "../src/assets/illustrations/sanpo-today-indigo-emaki-background-approved-v1.webp":
    "a34625fd300b21fc6103dd603fdd919ab1f95641789731642f83b05e93d89b6c",
  // Review M17. Responsive candidates, generated from the master above by
  // `scripts/generate-today-plate-variants.mjs` (Chromium, quality 0.90) —
  // which refuses to run unless that master hashes to the value on the line
  // above, so a variant can only ever be the APPROVED artwork made smaller.
  // The artwork is unchanged, so these stay "v1"; the widths are measured
  // field widths, not a generic ladder (438 = the field at 1440x900, 640 =
  // `--page-max`, 750 = 375 CSS px at DPR 2).
  //
  // Regenerating against a different Chromium build can produce different
  // bytes for the same picture. That makes these hashes a record of a
  // deliberate act rather than a derived value: change them in the same commit
  // as the regeneration, and say why.
  "../src/assets/illustrations/sanpo-today-indigo-emaki-background-approved-v1-438w.webp":
    "8dd4dd820303f37ab253d30ec60156d5a046c33606b9447bce29ad8bba0a0fc3",
  "../src/assets/illustrations/sanpo-today-indigo-emaki-background-approved-v1-640w.webp":
    "776af55c40e526bdf09120fe09ac2ed880b959b64b32dd0c5d02a70271b4e03f",
  "../src/assets/illustrations/sanpo-today-indigo-emaki-background-approved-v1-750w.webp":
    "a2f328dd00841ff57334183775d17526f7220a8740c63d177dcb7f30cdf8a0d1",
  // Review M19. Five STATE MARKS on the same 24x24 / 1.75px round-cap grid as
  // the navigation masters. Added because Money and the walk surfaces drew
  // them as text glyphs, and Nunito does not contain three of them: verified
  // in Chromium via `CSS.getPlatformFontsForNode` that U+2713, U+21A9 and
  // U+26A0 render in DejaVu Sans, the system fallback. The two most important
  // marks on the money surface, and the check on the client's own report
  // card, were drawn by whatever font the device happened to have.
  "../src/assets/icons/sanpo-alert-icon-approved-v1.svg":
    "d0b0653a4124f9f55caa35b15aac30dd0796786a53f629bee2a5a6118b03f7fd",
  "../src/assets/icons/sanpo-check-icon-approved-v1.svg":
    "b56b6dcc648095e14070388754f1db5a9901f8ef9a207d8fc0616158a6d4744a",
  "../src/assets/icons/sanpo-disputed-icon-approved-v1.svg":
    "bfc3c501ec01918e9c5845e15db16d3b2bf2ddcfaf45d23aa762c85809b25d12",
  "../src/assets/icons/sanpo-pending-icon-approved-v1.svg":
    "33552f22cc6ad50a6148869f9798237aab2028dd602d2399871e2cadbfcffcab",
  "../src/assets/icons/sanpo-returned-icon-approved-v1.svg":
    "61edaf62071ce29c5cbcb01110753696ae5f8391bfc1498462ecb16fc2761fae",
  "../src/assets/icons/sanpo-calendar-icon-approved-v1.svg":
    "341a47a144c9057aac70888cee6cfddd99082a39bce66b9afb40f093e465b171",
  "../src/assets/icons/sanpo-clients-icon-approved-v1.svg":
    "a0eaf5a66d63205b18db63c4e776a873391fae41db06546daf3854bd6c160f1f",
  "../src/assets/icons/sanpo-day-icon-approved-v1.svg":
    "85e2cd3c4848dc998e7f4abc67ec27a1d23f9e840d1412eb10e4cf9d4bba04e1",
  "../src/assets/icons/sanpo-inbox-icon-approved-v1.svg":
    "0701eea049ad92988003fc3eeeaaacb98e3b329b018b9cadd28da28857e12bf7",
  "../src/assets/icons/sanpo-payments-icon-approved-v1.svg":
    "20ce120bc38496f1b028019cb4aa414b4fa066c8196986156ac6db7a048aba69",
  "../src/assets/icons/sanpo-route-icon-approved-v1.svg":
    "573a373c977a5fcd35b6934ac78c6a50f7c7c81340381727f87307efd248f71a",
  "../src/styles/vendor/sanpo-product-color-tokens-r1.css":
    "a675872420e3b63df188d2adc953a9540aa1d054de70c06bfd2bfeff2a56f8bc",
};

let failed = false;

for (const [relativePath, expected] of Object.entries(approved)) {
  const absolutePath = fileURLToPath(new URL(relativePath, import.meta.url));
  const actual = createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
  if (actual !== expected) {
    failed = true;
    console.error(`${relativePath}: expected ${expected}, received ${actual}`);
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log(`Verified ${Object.keys(approved).length} approved Sanpo assets.`);
}
