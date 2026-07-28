import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const approved = {
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
