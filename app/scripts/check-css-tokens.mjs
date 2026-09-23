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
// A name built at runtime — `var(--s-${n})`, `"var(--s-" + n + ")"` — reaches
// the scan as a literal that ENDS mid-name. CSS cannot close a `var()` without
// `)` or `,`, so a literal ending inside a name is always a fragment, and
// reading the fragment as a whole name reported `--s-` undefined on a healthy
// tree. It is read as a prefix: some defined property must start with it, so a
// typo in the part that IS written down still fails. The residual, stated:
// whatever completes the name at runtime is not checked — a typo in the part
// that is substituted passes, and so does a fragment that was already the whole
// name (what follows begins with `,` or `)`) when a longer defined name extends
// it.
//
// Definitions come from CSS declarations (`--x:`), and from TS only where the
// value is actually SET ON A STYLE: a `--x` key in an object literal that flows
// straight into a JSX `style` prop (through parens, `as`, `satisfies`, a ternary
// branch, the right of `&&`/`||`/`??`, or a spread into such an object) or is
// typed or asserted as a type that includes `CSSProperties` (itself, or a union
// or intersection with it); and `….style.setProperty("--x", …)`. None exists
// today; counting them is what stops the gate going red on a healthy tree the
// day one does. Counting ANY `--x`-shaped key was the first version, and Codex
// was right to refuse it: a config or payload object would "define" a token no
// style ever sets, and a real `var(--missing)` would pass. That is the silent
// direction.
//
// The strict rule's cost is the loud direction, and it is paid on purpose.
// Every other way a value reaches a style — an untyped variable, a type alias,
// `Readonly<…>`, a function's return type, `useMemo`, `Object.assign` — is left
// unrecognised. Recognising them all is a type checker's job, and adding them
// one review round at a time is how a check grows without end. What makes the
// cost affordable is the red itself: when a missing name IS set somewhere, in a
// shape this does not read, the FAIL line points at where and says so, so
// the fix is in the message rather than in a reading of this file. That hint
// never counts as a definition — it only changes what the red says.
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

const CSS_PROPERTIES = /(^|\.)CSSProperties$/;

// A declared type that INCLUDES CSSProperties: itself, or a union or
// intersection with it (`CSSProperties & { "--gap": string }` is the
// conventional way to type a custom property). A type alias or a wrapper
// like `Readonly<…>` is not followed; see the header for why that is loud.
function isCssPropertiesType(type, sf) {
  if (!type) return false;
  if (ts.isParenthesizedTypeNode(type)) return isCssPropertiesType(type.type, sf);
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
    return type.types.some((t) => isCssPropertiesType(t, sf));
  }
  return ts.isTypeReferenceNode(type) && CSS_PROPERTIES.test(type.typeName.getText(sf));
}

// Walk up from an object literal through expressions that pass its value
// through unchanged, and say whether it lands on a style.
function isStyleObject(obj, sf) {
  let node = obj;
  for (;;) {
    const p = node.parent;
    if (!p) return false;
    if (ts.isParenthesizedExpression(p)) { node = p; continue; }
    // `{ ...X, … }` puts X's keys on the containing object: X is a style
    // object exactly when that one is.
    if (ts.isSpreadAssignment(p)) { node = p.parent; continue; }
    if (ts.isAsExpression(p) || ts.isSatisfiesExpression(p)) {
      if (isCssPropertiesType(p.type, sf)) return true;
      node = p; continue;
    }
    if (ts.isConditionalExpression(p) && (p.whenTrue === node || p.whenFalse === node)) { node = p; continue; }
    if (ts.isBinaryExpression(p) && p.right === node && [
      ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
    ].includes(p.operatorToken.kind)) { node = p; continue; }
    if (ts.isJsxExpression(p)) return ts.isJsxAttribute(p.parent) && p.parent.name.getText(sf) === "style";
    if (ts.isVariableDeclaration(p) && p.initializer === node) return isCssPropertiesType(p.type, sf);
    return false;
  }
}

export function scanTs(file, text) {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX
    : file.endsWith(".jsx") ? ts.ScriptKind.JSX
    : /\.m?js$/.test(file) ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const defs = [];
  const uses = [];
  // Keys and setProperty calls that name a custom property but are NOT read as
  // a style. They never define anything; they only make a red say where to look.
  const nearMisses = [];
  let literals = 0;
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const visit = (node) => {
    const literal = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
    if (literal) {
      literals += 1;
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      for (const m of node.text.matchAll(VAR_USE)) {
        // A name that runs to the literal's last character is not finished
        // there (see the header): it is a prefix of whatever gets built.
        const prefix = m.index + m[0].length === node.text.length;
        uses.push({ name: m[1], prefix, file, line: start + lineAt(node.text, m.index) - 1 });
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (name && TOKEN.test(name)) {
        if (isStyleObject(node.parent, sf)) defs.push(name);
        else nearMisses.push({ name, kind: "key", file, line: lineOf(node) });
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "setProperty") {
      const name = stringValue(node.arguments[0]);
      if (name && TOKEN.test(name)) {
        const onStyle = ts.isPropertyAccessExpression(node.expression.expression)
          && node.expression.expression.name.text === "style";
        if (onStyle) defs.push(name);
        else nearMisses.push({ name, kind: "setProperty", file, line: lineOf(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { defs, uses, nearMisses, literals };
}

export function check(root) {
  const files = walk(root);
  const css = files.filter((f) => f.endsWith(".css"));
  const code = files.filter((f) => TS_EXT.test(f) && !f.endsWith(".d.ts") && !TEST_FILE.test(f));
  const defined = new Set();
  const uses = [];
  const nearMisses = [];
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
    nearMisses.push(...r.nearMisses);
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
  // One rule for "does this name satisfy this use", shared by the check and the
  // hint, so the hint can never point at a key the check would not have taken.
  const satisfies = (u, name) => (u.prefix ? name.startsWith(u.name) : name === u.name);
  const names = [...defined];
  const missing = uses
    .filter((u) => !names.some((d) => satisfies(u, d)))
    .map((u) => ({ ...u, nearMisses: nearMisses.filter((n) => satisfies(u, n.name)) }));
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
    const what = u.prefix
      ? `var(${u.name}…) can name no defined custom property: none starts with ${u.name}`
      : `${u.name} is used but never defined`;
    let hint = "";
    const [near, ...more] = u.nearMisses;
    if (near) {
      // Conditional on purpose: the key may be a config or payload field, and
      // telling the reader to type THAT as CSSProperties would coach them into
      // the silent direction — a token "defined" by an object no style reads.
      const remedy = near.kind === "setProperty"
        ? "by setProperty on something that is not `….style`; if that is a style declaration, call it on `….style`"
        : "but not in a shape this gate reads as a style; if that object is applied as a style, type it CSSProperties";
      hint = ` — ${near.name} is set at ${path.relative(process.cwd(), near.file)}:${near.line}`
        + `${more.length ? ` (and ${more.length} more)` : ""}, ${remedy} (header of app/scripts/check-css-tokens.mjs)`;
    }
    console.log(`FAIL: ${what} (${where}:${u.line})${hint}`);
    if (ci) console.log(`::error file=${where},line=${u.line}::${what}${hint}`);
  }
  if (floors.length || missing.length) process.exit(1);
  console.log(
    `PASS: ${counts.uses} var() uses across ${counts.css} CSS and ${counts.code} TS/TSX files, `
      + `all naming one of ${counts.defined} defined custom properties`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
