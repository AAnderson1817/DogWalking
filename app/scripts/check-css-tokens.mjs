#!/usr/bin/env node
// Gate 12: every `var(--x)` names a custom property something defines.
//
// ONE implementation, called by `scripts/validate.sh`, by `ci.yml`'s step of
// the same name, and documented in `.claude/skills/validate/SKILL.md`. There
// used to be three inline copies, SKILL.md said "keep this identical", and they
// had drifted: validate.sh read token names as `[A-Za-z0-9_-]`, CI as
// `[a-zA-Z0-9-]`. A rule written three times is three rules.
//
// Why TSX as well as CSS: the first version scanned `*.css` only, so a
// `var(--s-5)` in a React style object shipped in `Pricing.tsx` and sat live
// for weeks with every gate green — the THIRD `--s-5` in this repository, after
// two in CSS that this gate did catch. The spacing scale is 1·2·3·4·6·8·12.
//
// Why a parser rather than a regex over TS source: a comment or a sentence of
// JSX text that MENTIONS a token is not a use. `lib/today-plate.ts` already
// carries `var(--page-max)` in a doc comment, and the note explaining a fix is
// exactly where somebody writes the name of the token that does not exist. So
// uses are read from string and template literals in the TypeScript AST, and
// comments and JSX text are never looked at.
//
// Definitions come from CSS declarations (`--x:`), and from TS where a custom
// property can also be set: an object-literal key (`style={{ "--x": … }}`) and
// `setProperty("--x", …)`. None exists today; counting them anyway is what
// stops the gate going red on a healthy tree the day one does.
//
// Like the CSS side always has, this is scope-blind: a token defined under one
// selector satisfies a use anywhere. Fixing that is a different gate.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TOKEN = /^--[A-Za-z0-9_-]+$/;
const VAR_USE = /var\(\s*(--[A-Za-z0-9_-]+)/g;
const CSS_DEF = /(--[A-Za-z0-9_-]+)\s*:/g;
const TS_EXT = /\.(tsx?|jsx?|mjs)$/;
// Tests are fixtures, not UI: a test may name a token that does not exist on
// purpose, and nothing in one is ever painted by a user's browser.
const TEST_FILE = /\.test\.[jt]sx?$/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const lineAt = (text, index) => text.slice(0, index).split("\n").length;

export function scanCss(file, text) {
  // Blank comments in place, newlines kept, so line numbers stay true. A
  // `var(--role)` written in prose to explain a rule is not a use.
  const t = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const defs = [...t.matchAll(CSS_DEF)].map((m) => m[1]);
  const uses = [...t.matchAll(VAR_USE)].map((m) => ({ name: m[1], file, line: lineAt(t, m.index) }));
  return { defs, uses };
}

function stringValue(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))) {
    node = node.expression;
  }
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

function propertyName(name) {
  if (ts.isComputedPropertyName(name)) return stringValue(name.expression);
  return stringValue(name);
}

export function scanTs(file, text) {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX
    : file.endsWith(".jsx") ? ts.ScriptKind.JSX
    : /\.m?js$/.test(file) ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const defs = [];
  const uses = [];
  let literals = 0;

  const visit = (node) => {
    const literal = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
    if (literal) {
      literals += 1;
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      for (const m of node.text.matchAll(VAR_USE)) {
        uses.push({ name: m[1], file, line: start + lineAt(node.text, m.index) - 1 });
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (name && TOKEN.test(name)) defs.push(name);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "setProperty") {
      const name = stringValue(node.arguments[0]);
      if (name && TOKEN.test(name)) defs.push(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { defs, uses, literals };
}

export function check(root) {
  const files = walk(root);
  const css = files.filter((f) => f.endsWith(".css"));
  const code = files.filter((f) => TS_EXT.test(f) && !f.endsWith(".d.ts") && !TEST_FILE.test(f));
  const defined = new Set();
  const uses = [];
  let literals = 0;
  for (const f of css) {
    const r = scanCss(f, fs.readFileSync(f, "utf8"));
    r.defs.forEach((d) => defined.add(d));
    uses.push(...r.uses);
  }
  for (const f of code) {
    const r = scanTs(f, fs.readFileSync(f, "utf8"));
    r.defs.forEach((d) => defined.add(d));
    uses.push(...r.uses);
    literals += r.literals;
  }
  // A checker that scanned nothing reports agreement. These are the ways it
  // could scan nothing and still exit 0: a wrong root, a glob that matches no
  // files, or an AST walk that stopped seeing literals.
  const floors = [];
  if (css.length === 0) floors.push(`no .css files found under ${root}`);
  if (code.length === 0) floors.push(`no .ts/.tsx files found under ${root}`);
  if (code.length > 0 && literals === 0) floors.push("the TypeScript scan read no string literals at all — the parser is not seeing the source");
  if (css.length > 0 && code.length > 0 && uses.length === 0) floors.push("no var() uses found anywhere — nothing was checked");
  const missing = uses.filter((u) => !defined.has(u.name));
  return { missing, floors, counts: { css: css.length, code: code.length, uses: uses.length, defined: defined.size } };
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(process.argv[2] ?? path.join(here, "..", "src"));
  const { missing, floors, counts } = check(root);
  const ci = process.env.GITHUB_ACTIONS === "true";
  for (const f of floors) console.log(`FAIL: ${f}`);
  for (const u of missing) {
    const where = path.relative(process.cwd(), u.file);
    console.log(`FAIL: ${u.name} is used but never defined (${where}:${u.line})`);
    if (ci) console.log(`::error file=${where},line=${u.line}::${u.name} is used but never defined`);
  }
  if (floors.length || missing.length) process.exit(1);
  console.log(
    `PASS: ${counts.uses} var() uses across ${counts.css} CSS and ${counts.code} TS/TSX files, `
      + `all naming one of ${counts.defined} defined custom properties`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
