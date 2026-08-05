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
  "../src/assets/illustrations/sanpo-today-indigo-emaki-background-approved-v1.png":
    "9deb38869c94d1f33d7a747fe618a05ab5da86209c3f37721ee903e80fd8cef8",
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
