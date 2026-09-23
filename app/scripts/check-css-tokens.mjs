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
// value is actually SET ON A STYLE: a `--x` key in an object literal whose
// value reaches a JSX `style` prop — straight in (through parens, `as`,
// `satisfies`, `!`, a ternary branch, either side of `||`/`??`, the right of
// `&&`, or a spread into such an object), or through a `const` that is itself
// used that way in the same file, followed by symbol so a shadowing name is a
// different binding; and `….style.setProperty("--x", …)`. None exists today;
// counting them is what stops the gate going red on a healthy tree the day one
// does. Counting ANY `--x`-shaped key was the first version, and Codex was right
// to refuse it: a config or payload object would "define" a token no style ever
// sets, and a real `var(--missing)` would pass. That is the silent direction.
// Reading a `CSSProperties` TYPE as evidence was the second, and Codex refused
// that too, three rounds running (PR #95): a type says what shape an object
// has, not that anything applies it, so an unused typed object and a union
// that is really a payload each "defined" a token. The value is what is
// followed now, and a type decides nothing. And a key whose literal value
// REMOVES the property — null, undefined, a boolean or "", which React clears
// rather than sets, like setProperty(name, "") — defines nothing either
// (Codex, round 5).
//
// The strict rule's cost is the loud direction, and it is paid on purpose.
// Every other way a value reaches a style — an import from another file, a
// `let`, a function's return value, `useMemo`, `Object.assign` — is left
// unrecognised. Recognising them all is a type checker's job, and adding them
// one review round at a time is how a check grows without end. What makes the
// cost affordable is the red itself: when a missing name IS set somewhere, in a
// shape this does not read, the FAIL line points at where and says so, so the
// fix is in the message rather than in a reading of this file. That hint never
// counts as a definition — it only changes what the red says — and its remedy,
// a default in CSS, is a real definition whatever the object turns out to be.
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

// Wrappers that pass a value through unchanged.
const passesThrough = (n) => ts.isParenthesizedExpression(n) || ts.isAsExpression(n)
  || ts.isSatisfiesExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n);
const OR_LIKE = [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken];

// A value that REMOVES the property it names rather than setting it. React
// removes a style declaration whose value is null, undefined, a boolean or ""
// (for a custom property it calls setProperty(name, "")), and CSSOM's
// setProperty removes one given "" or null. Only a literal that always
// removes is refused: a value computed at run time — `on ? "red" : undefined`
// — sets the property whenever it is not empty, and a definition that holds
// sometimes is still a definition, the approximation the CSS side makes too.
const bare = (n) => { while (n && passesThrough(n)) n = n.expression; return n; };
const isEmptyString = (n) => (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === "";
function reactRemoves(value) {
  const v = bare(value);
  return v.kind === ts.SyntaxKind.NullKeyword || v.kind === ts.SyntaxKind.TrueKeyword
    || v.kind === ts.SyntaxKind.FalseKeyword || ts.isVoidExpression(v)
    || (ts.isIdentifier(v) && v.text === "undefined") || isEmptyString(v);
}
function cssomRemoves(value) {
  const v = bare(value); // absent in a one-argument call, which throws and sets nothing
  return !!v && (v.kind === ts.SyntaxKind.NullKeyword || isEmptyString(v));
}

// Walk up from an expression and say whether its value lands on a style.
// `seen` holds the consts already followed: `const x = c ? { … } : x` is legal
// syntax, and without it the walk from the object into `x` and back through
// its own initializer never ends.
function landsOnStyle(start, ctx, seen = new Set()) {
  let node = start;
  for (;;) {
    const p = node.parent;
    if (!p) return false;
    if (passesThrough(p)) { node = p; continue; }
    // `{ ...X, … }` puts X's keys on the containing object: X lands on a
    // style exactly when that one does.
    if (ts.isSpreadAssignment(p)) { node = p.parent; continue; }
    if (ts.isConditionalExpression(p) && (p.whenTrue === node || p.whenFalse === node)) { node = p; continue; }
    // Either side of `||`/`??` can be the result, and an object is truthy and
    // never nullish, so an object on the left IS the result; `a && b` is b.
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind;
      if (OR_LIKE.includes(op) || (op === ts.SyntaxKind.AmpersandAmpersandToken && p.right === node)) { node = p; continue; }
    }
    if (ts.isJsxExpression(p)) return ts.isJsxAttribute(p.parent) && p.parent.name.getText(ctx.sf) === "style";
    if (ts.isVariableDeclaration(p) && p.initializer === node) return constReachesStyle(p, ctx, seen);
    return false;
  }
}

// A const lands on a style when a use of it in this file does. By symbol,
// not by name: a parameter or an inner const of the same name is a different
// binding, and matching names would let one binding's style "define" the
// other's keys. Only a const — a `let` can be replaced before it is used.
function constReachesStyle(decl, ctx, seen) {
  if (!ts.isIdentifier(decl.name) || !(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const)) return false;
  const symbol = ctx.checker.getSymbolAtLocation(decl.name);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  for (const id of ctx.identifiers().get(decl.name.text) ?? []) {
    if (id === decl.name || ctx.checker.getSymbolAtLocation(id) !== symbol) continue;
    if (landsOnStyle(id, ctx, seen)) return true;
  }
  return false;
}

const COMPILER_OPTIONS = {
  noLib: true,
  noResolve: true,
  target: ts.ScriptTarget.Latest,
  jsx: ts.JsxEmit.Preserve,
  allowJs: true,
  skipLibCheck: true,
  types: [],
};

const scriptKind = (file) => (file.endsWith(".tsx") ? ts.ScriptKind.TSX
  : file.endsWith(".jsx") ? ts.ScriptKind.JSX
  : /\.m?js$/.test(file) ? ts.ScriptKind.JS
  : ts.ScriptKind.TS);

// One program over the sources read here, so the checker can resolve a name to
// its binding. Imports are not resolved (`noResolve`): a local's symbol never
// crosses a file, which is all the const rule needs.
function programOver(sources) {
  const host = {
    getSourceFile: (name) => {
      const text = sources.get(name);
      return text === undefined ? undefined : ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, scriptKind(name));
    },
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (f) => sources.has(f),
    readFile: (f) => sources.get(f),
    directoryExists: () => true,
    getDirectories: () => [],
  };
  return ts.createProgram([...sources.keys()], COMPILER_OPTIONS, host);
}

function scanTs(sf, checker) {
  const file = sf.fileName;
  // Every identifier in the file by name, built on first need: only an object
  // assigned to a const ever asks.
  let index;
  const identifiers = () => {
    if (!index) {
      index = new Map();
      const collect = (n) => {
        if (ts.isIdentifier(n)) index.set(n.text, [...(index.get(n.text) ?? []), n]);
        ts.forEachChild(n, collect);
      };
      collect(sf);
    }
    return index;
  };
  const ctx = { sf, checker, identifiers };
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
        if (!landsOnStyle(node.parent, ctx)) nearMisses.push({ name, kind: "key", file, line: lineOf(node) });
        else if (reactRemoves(node.initializer)) nearMisses.push({ name, kind: "removed", file, line: lineOf(node) });
        else defs.push(name);
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "setProperty") {
      const name = stringValue(node.arguments[0]);
      if (name && TOKEN.test(name)) {
        const onStyle = ts.isPropertyAccessExpression(node.expression.expression)
          && node.expression.expression.name.text === "style";
        if (!onStyle) nearMisses.push({ name, kind: "setProperty", file, line: lineOf(node) });
        else if (cssomRemoves(node.arguments[1])) nearMisses.push({ name, kind: "removed", file, line: lineOf(node) });
        else defs.push(name);
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
  const program = programOver(new Map(code.map((f) => [f, fs.readFileSync(f, "utf8")])));
  const checker = program.getTypeChecker();
  for (const f of code) {
    const r = scanTs(program.getSourceFile(f), checker);
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

const joinAnd = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

// "--x is set at a.ts:1 and b.tsx:3", or name by name when a prefix use
// matched several: "--s-1 is set at a.ts:1 and --s-2 is set at a.ts:2".
// Sorted by file and line, so the order does not depend on the directory walk.
function setAt(nearMisses) {
  const byPlace = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);
  const sorted = [...nearMisses].sort(byPlace);
  const at = (n) => `${path.relative(process.cwd(), n.file)}:${n.line}`;
  const names = new Set(sorted.map((n) => n.name));
  return names.size === 1
    ? `${sorted[0].name} is set at ${joinAnd(sorted.map(at))}`
    : joinAnd(sorted.map((n) => `${n.name} is set at ${at(n)}`));
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
    // Every place the name is set, not the first: the first found can be a
    // config key while the style object that matters comes later (Codex, PR
    // #95). The remedy is a default in CSS because that is a real definition
    // whatever the object turns out to be; the earlier "type it CSSProperties"
    // coached a config key into counting, the silent direction.
    const parts = [];
    const keys = u.nearMisses.filter((n) => n.kind === "key");
    const calls = u.nearMisses.filter((n) => n.kind === "setProperty");
    if (keys.length) {
      const one = keys.length === 1;
      parts.push(`${setAt(keys)}, but ${one ? "never reaches" : "none reaches"} a \`style\` this gate can follow; `
        + `if ${one ? "that object is" : "one of those objects is"} applied as a style some other way, `
        + "give the property a default in CSS");
    }
    const removed = u.nearMisses.filter((n) => n.kind === "removed");
    if (removed.length) {
      parts.push(`${setAt(removed)}, but to a value that removes the property rather than setting it, `
        + "as React does with null, undefined, a boolean or \"\" and setProperty with \"\" or null");
    }
    if (calls.length) {
      parts.push(`${setAt(calls)}, by setProperty on something that is not \`….style\`; if ${calls.length === 1
        ? "that is" : "one of those is"} a style declaration, call it on \`….style\``);
    }
    const hint = parts.length ? ` — ${parts.join("; and ")} (header of app/scripts/check-css-tokens.mjs)` : "";
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
