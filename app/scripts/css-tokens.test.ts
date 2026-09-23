import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Gate 12 (`scripts/check-css-tokens.mjs`) — every `var(--x)` names a custom
 * property something defines.
 *
 * Driven through the real CLI against throwaway trees, because the CLI is what
 * `validate.sh` and CI run: exit code, floors and messages are the contract.
 * Every case breaks ONE rule and requires the gate to notice; the reason is
 * that the first version of this gate scanned CSS only, and a `var(--s-5)` in
 * a TSX style object sat live with every gate green.
 */

const SCRIPT = resolve(__dirname, "check-css-tokens.mjs");

/** The minimal healthy tree: a stylesheet and a component with a literal. */
const CSS = ":root { --a: 4px; --a_b: 8px; }\n.x { padding: var(--a); }\n";
const TSX = 'export const Ok = () => <p className="ok" style={{ margin: "var(--a)" }} />;\n';

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "css-tokens-"));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
}

function run(root: string): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, root], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_ACTIONS: "" },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("gate 12: css tokens defined", () => {
  it("passes a healthy tree", () => {
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "screens/Ok.tsx": TSX }));
    expect(out).toContain("PASS:");
    expect(code).toBe(0);
  });

  it("fails a TSX style object naming an undefined token, with file and line", () => {
    // The Pricing.tsx shape exactly: the defect the CSS-only gate could not see.
    const screen = 'export const S = () => (\n  <ul style={{ paddingLeft: "var(--nope)" }} />\n);\n';
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "screens/S.tsx": screen }));
    expect(out).toMatch(/FAIL: --nope is used but never defined \(.*S\.tsx:2\)/);
    expect(code).toBe(1);
  });

  it("keeps the CSS half: a stylesheet naming an undefined token fails", () => {
    const css = `${CSS}.y {\n  margin: var(--gone);\n}\n`;
    const { code, out } = run(tree({ "styles/tokens.css": css, "screens/Ok.tsx": TSX }));
    expect(out).toMatch(/FAIL: --gone is used but never defined \(.*tokens\.css:4\)/);
    // A stylesheet value is a style by construction, so its red never
    // suggests the string might be prose.
    expect(out).not.toContain("only mentions");
    expect(code).toBe(1);
  });

  it("does not count a mention as a use: comments and JSX text are not styles", () => {
    // lib/today-plate.ts already mentions `var(--page-max)` in a doc comment,
    // and the note explaining a fix is where the missing name gets written.
    const mentions = [
      "// never write var(--nope): the scale skips 5",
      "/* var(--nope) in a block comment */",
      "/** doc: `.page { max-width: var(--nope) }` */",
      'export const S = () => <p className="x">write var(--nope) here</p>;',
    ].join("\n");
    const css = `${CSS}/* var(--nope) in stylesheet prose */\n`;
    const { code, out } = run(tree({ "styles/tokens.css": css, "screens/S.tsx": mentions, "screens/Ok.tsx": TSX }));
    expect(out).toContain("PASS:");
    expect(code).toBe(0);
  });

  it("reads template literals, including the text around a substitution", () => {
    const src = [
      "export const w = (n: number) => `calc(var(--whole) * 2)`;",
      "export const h = (n: number) => `calc(${n}px + var(--tail))`;",
    ].join("\n");
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "lib/sizes.ts": src, "screens/Ok.tsx": TSX }));
    expect(out).toContain("FAIL: --whole is used but never defined");
    expect(out).toContain("FAIL: --tail is used but never defined");
    expect(code).toBe(1);
  });

  it("reads a name that runs into a substitution as a prefix, not a whole name", () => {
    // `var(--s-${n})` reaches the scan as a template head ending in `--s-`;
    // checked as a whole name, that is "--s- is used but never defined" on a
    // healthy tree. Concatenation leaves the same fragment in a string literal.
    const src = [
      "export const t = (n: 1 | 2) => `var(--s-${n})`;",
      'export const c = (n: 1 | 2) => "var(--s-" + n + ")";',
      "export const m = (a: string, n: 1 | 2) => `${a} var(--s-${n})`;",
    ].join("\n");
    const css = ":root { --s-1: 4px; --s-2: 8px; }\n";
    const { code, out } = run(tree({ "styles/tokens.css": `${CSS}${css}`, "lib/space.ts": src, "screens/Ok.tsx": TSX }));
    expect(out).toContain("PASS:");
    expect(code).toBe(0);
  });

  it("fails a prefix that no defined token starts with", () => {
    const src = "export const t = (n: number) => `var(--nosuch-${n})`;";
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "lib/space.ts": src, "screens/Ok.tsx": TSX }));
    expect(out).toMatch(/FAIL: var\(--nosuch-…\) can name no defined custom property: none starts with --nosuch- \(.*space\.ts:1\)/);
    expect(code).toBe(1);
  });

  it("still reads a name finished before the substitution as a whole name", () => {
    // `--a_` is terminated by the comma, so it is a whole name — and an
    // undefined one — even though `--a_b` would satisfy it as a prefix.
    const src = "export const t = (fallback: string) => `var(--a_, ${fallback})`;";
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "lib/space.ts": src, "screens/Ok.tsx": TSX }));
    expect(out).toContain("FAIL: --a_ is used but never defined");
    expect(code).toBe(1);
  });

  it("counts a custom property set on a style from TS as defined", () => {
    // None exists today. Without this the gate goes red on a healthy tree the
    // day one does, which is how a gate gets deleted. Each shape here is one
    // the definition rule must recognise as a STYLE.
    const src = [
      'import type { CSSProperties } from "react";',
      'export const A = () => <div style={{ "--local": "1px", padding: "var(--local)" } as object} />;',
      'export const B = () => <div style={{ ["--comp" as string]: 1, margin: "var(--comp)" }} />;',
      'export const C = (on: boolean) => <div style={on ? { "--cond": "1px" } : undefined} className="var(--cond)" />;',
      'const vars = { "--viaType": "1px" } as CSSProperties;',
      'export const D = () => <div style={vars} className="var(--viaType)" />;',
      'const annotated: React.CSSProperties = { "--annot": "1px" };',
      'export const E = () => <div style={annotated} className="var(--annot)" />;',
      'export function f(el: HTMLElement) { el.style.setProperty("--set", "2px"); return "var(--set)"; }',
      'export function g() { document.documentElement.style.setProperty("--root", "2px"); return "var(--root)"; }',
      // Codex on PR #95, round 2: a spread into a style object, and a type
      // that includes CSSProperties without being exactly it.
      'export const F = () => <div style={{ ...{ "--spread": "1px" }, padding: "var(--spread)" }} />;',
      'export const G = (on: boolean) => <div style={{ ...(on ? { "--condSpread": "1px" } : {}), padding: "var(--condSpread)" }} />;',
      'const inter: React.CSSProperties & { "--gap": string } = { "--gap": "1px" };',
      'export const H = () => <div style={inter} className="var(--gap)" />;',
      'const maybe: (CSSProperties | undefined) = { "--maybe": "1px" };',
      'export const I = () => <div style={maybe} className="var(--maybe)" />;',
      'const nullable: null | React.CSSProperties = { "--nullable": "1px" };',
      'export const J = () => <div style={nullable ?? undefined} className="var(--nullable)" />;',
      // Codex on PR #95, round 4: a declaration counts because its VALUE
      // reaches a style prop, not because of its type, so an untyped const
      // passed to \`style\` counts, through a chain of consts and a \`!\` too.
      'const plainStyle = { "--untyped": "1px" };',
      'export const K = () => <div style={plainStyle} className="var(--untyped)" />;',
      'const base = { "--chain": "1px" };',
      "const alias = base;",
      'export const L = () => <div style={alias} className="var(--chain)" />;',
      'const nn = { "--nonnull": "1px" };',
      'export const M = () => <div style={nn!} className="var(--nonnull)" />;',
    ].join("\n");
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "screens/Local.tsx": src }));
    expect(out).toContain("PASS:");
    expect(code).toBe(0);
  });

  it("names an unrecognised style shape in the red, and still does not count it", () => {
    // The strict rule leaves most flows unrecognised on purpose — a plain
    // variable, a type alias, a function's return type. What makes that
    // affordable is a red that points at the key, so the fix is in the message.
    const src = [
      'const styleFor = () => ({ "--plain": "1px" });',
      'export const S = () => <p className="x" style={styleFor()} />;',
      'export const T = () => <p className="x" style={{ margin: "var(--plain)" }} />;',
    ].join("\n");
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "screens/S.tsx": src }));
    expect(out).toMatch(
      /FAIL: --plain is used but never defined \(.*S\.tsx:3\) — --plain is set at .*S\.tsx:1, but never reaches a `style` this gate can follow/,
    );
    expect(out).toContain("if that object is applied as a style some other way, give the property a default in CSS");
    expect(code).toBe(1);

    // The hint reads a prefix the way the check does: one rule for both.
    const built = [
      'const steps = { "--sp-1": "4px" };',
      "export const U = (n: 1) => <p className=\"x\" style={{ gap: `var(--sp-${n})` }} />;",
    ].join("\n");
    const r = run(tree({ "styles/tokens.css": CSS, "screens/U.tsx": built }));
    expect(r.out).toMatch(/FAIL: var\(--sp-…\) can name no defined custom property: none starts with --sp- \(.*U\.tsx:2\) — --sp-1 is set at .*U\.tsx:1/);
    expect(r.code).toBe(1);

    // Several names under one prefix are named one by one, so no location is
    // attributed to a name that is not set there.
    const two = [
      'const steps = { "--sp-1": "4px" };',
      'const more = { "--sp-2": "8px" };',
      "export const U = (n: 1 | 2) => <p className=\"x\" style={{ gap: `var(--sp-${n})` }} />;",
    ].join("\n");
    const r2 = run(tree({ "styles/tokens.css": CSS, "screens/U.tsx": two }));
    expect(r2.out).toMatch(/— --sp-1 is set at .*U\.tsx:1 and --sp-2 is set at .*U\.tsx:2, but none reaches a `style`/);
    expect(r2.code).toBe(1);
  });

  it("does not count a --x key in an ordinary object as a definition", () => {
    // Codex on PR #95: counting ANY `--x`-shaped key let a config or payload
    // object "define" a token no stylesheet or style ever sets, so a real
    // `var(--missing)` elsewhere passed while computing to nothing at runtime.
    const config = 'export const payload = { "--missing": 1, kind: "config" };';
    const screen = 'export const S = () => <p className="x" style={{ margin: "var(--missing)" }} />;';
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "lib/config.ts": config, "screens/S.tsx": screen }));
    expect(out).toContain("FAIL: --missing is used but never defined");
    expect(code).toBe(1);
  });

  it("counts a declaration only when its value reaches a style, whatever its type says", () => {
    // Codex on PR #95, rounds 3 and 4: a type says what shape an object has,
    // not that anything applies it. A typed declaration nothing passes to a
    // style defines nothing, so the rule follows the value instead.
    const src = [
      'import type { CSSProperties } from "react";',
      "type Payload = { kind: string };",
      'const unused: CSSProperties & { "--unused": string } = { "--unused": "1px" };',
      'const payload: CSSProperties | Payload = { "--missing": 1, kind: "payload" };',
      'const asserted = { "--asserted": "1px" } as CSSProperties;',
      // Only a const is followed: a let can be replaced before it is used.
      'let swapped = { "--swapped": "1px" };',
      "swapped = {};",
      'export const S = () => <p className="x" style={swapped} />;',
      // A parameter that shadows the const is a different binding.
      'const shadow = { "--shadow": "1px" };',
      "export function T(shadow: object) { return <p className=\"x\" style={shadow} />; }",
      'export const U = () => <p className="x" style={{ margin: "var(--unused) var(--missing) var(--asserted) var(--swapped) var(--shadow)" }} />;',
    ].join("\n");
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "screens/S.tsx": src }));
    for (const name of ["--unused", "--missing", "--asserted", "--swapped", "--shadow"]) {
      expect(out).toContain(`FAIL: ${name} is used but never defined`);
    }
    expect(code).toBe(1);
  });

  it("does not count a key whose value removes the property instead of setting it", () => {
    // Codex on PR #95, round 5: React removes a style declaration whose value is
    // null, undefined, a boolean or "" (for a custom property it calls
    // setProperty(name, "")), and setProperty(name, "") or (name, null) removes
    // one too. Such a key reaches a style and defines nothing.
    const src = [
      "declare const el: HTMLElement;",
      'const vars = { "--missing": undefined, "--nul": null, "--bool": false, "--empty": "", "--tmpl": ``, "--voided": void 0, "--cast": undefined as unknown as string };',
      'el.style.setProperty("--cleared", "");',
      'el.style.setProperty("--nulled", null);',
      'export const S = () => <p className="x" style={{ ...vars, margin: "var(--missing) var(--nul) var(--bool) var(--empty) var(--tmpl) var(--voided) var(--cast) var(--cleared) var(--nulled)" }} />;',
    ].join("\n");
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "screens/S.tsx": src }));
    for (const name of ["--missing", "--nul", "--bool", "--empty", "--tmpl", "--voided", "--cast", "--cleared", "--nulled"]) {
      expect(out).toContain(`FAIL: ${name} is used but never defined`);
    }
    expect(out).toMatch(/--missing is set at .*S\.tsx:2, but to a value that removes the property rather than setting it/);
    expect(code).toBe(1);
  });

  it("still counts a value that sets something: a number, and a conditional that may", () => {
    // 0 is set (only null, undefined, booleans and "" are removed), and a value
    // that is sometimes undefined still sets the property when it is not: only
    // a literal that ALWAYS removes is refused.
    const src = [
      "declare const on: boolean;",
      'const vars = { "--zero": 0, "--accent": on ? "red" : undefined };',
      'export const S = () => <p className="x" style={{ ...vars, margin: "var(--zero) var(--accent)" }} />;',
    ].join("\n");
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "screens/S.tsx": src }));
    expect(out).toContain("PASS:");
    expect(code).toBe(0);
  });

  it("does not count a key that a later property or spread in the same style removes", () => {
    // Codex on PR #95, round 7: React applies the LAST value an object literal
    // gives a key, so a setting followed by a clearing defines nothing — in the
    // key's own literal, and at every literal it is spread into on the way.
    const src = [
      'import type { CSSProperties } from "react";',
      'const set = { "--missing": "red" } as CSSProperties;',
      'const clear = { "--missing": undefined } as CSSProperties;',
      'export const S = () => <div style={{ ...set, ...clear, margin: "var(--missing)" }} />;',
      'const twice = { "--twice": "red", "--twice": undefined };',
      "export const T = () => <div style={twice} />;",
      'const base = { "--based": "red" };',
      'export const U = () => <div style={{ ...base, "--based": null }} />;',
      'export const V = () => <div style={{ "--inline": "1px", ...({ "--inline": "" } as object) }} />;',
      // A host element that clears the key says more than a component that
      // may drop it, whichever of the two comes first in the file.
      'const both = { "--both": "red" };',
      "export const X = () => <Card style={both} />;",
      'export const Y = () => <div style={{ ...both, "--both": undefined }} />;',
      'export const W = () => <p className="x" style={{ margin: "var(--twice) var(--based) var(--inline) var(--both)" }} />;',
    ].join("\n");
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "screens/S.tsx": src }));
    const line = (name: string) => out.split("\n").find((l) => l.startsWith(`FAIL: ${name} is used`)) ?? "";
    for (const name of ["--missing", "--twice", "--based", "--inline", "--both"]) {
      expect(line(name)).toContain(`FAIL: ${name} is used but never defined`);
    }
    // The red names where the value is set AND where it is taken away again.
    expect(line("--missing")).toMatch(
      /— --missing is set at .*S\.tsx:2, but a later property or spread in the same style removes it \(at .*S\.tsx:4\); give the property a default in CSS/,
    );
    expect(line("--based")).toMatch(/--based is set at .*S\.tsx:7, but a later property or spread in the same style removes it \(at .*S\.tsx:8\)/);
    expect(line("--both")).toMatch(/--both is set at .*S\.tsx:10, but a later property or spread in the same style removes it \(at .*S\.tsx:12\)/);
    expect(code).toBe(1);
  });

  it("still counts a key when what follows it may set it, leaves it alone, or cannot be read", () => {
    // The last value wins in the other direction too, and only a later value
    // that DEFINITELY removes is refused: a spread this cannot read, or one
    // that clears on one arm of a ternary only, may leave the key set — the
    // approximation the removal rule makes for a value computed at run time.
    const src = [
      "declare const on: boolean;",
      "declare const props: { style?: object };",
      'const vars = { "--late": undefined, "--late": "red" };',
      "export const A = () => <div style={vars} />;",
      'export const B = () => <div style={{ "--forwarded": "1px", ...props.style }} />;',
      'export const C = () => <div style={{ "--sometimes": "1px", ...(on ? { "--sometimes": undefined } : {}) }} />;',
      'export const D = () => <div style={{ "--kept": "1px", "--other": undefined, margin: 0 }} />;',
      // A const cleared on one path and applied whole on another still counts.
      'const two = { "--two": "1px" };',
      'export const E = () => <div style={{ ...two, "--two": undefined }} />;',
      "export const F = () => <div style={two} />;",
      'export const G = () => <p className="x" style={{ margin: "var(--late) var(--forwarded) var(--sometimes) var(--kept) var(--two)" }} />;',
    ].join("\n");
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "screens/S.tsx": src }));
    expect(out).toContain("PASS:");
    expect(code).toBe(0);
  });

  it("follows a declaration that refers to itself without looping", () => {
    // Legal syntax, a TDZ error at run time. Without a guard the walk from the
    // object into the const and back through its own initializer never ends.
    const src = [
      "declare const on: boolean;",
      'const loop = on ? { "--loop": "1px" } : loop;',
      'export const V = () => <p className="x" style={{ margin: "var(--loop)" }} />;',
    ].join("\n");
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "screens/V.tsx": src }));
    expect(out).toContain("FAIL: --loop is used but never defined");
    expect(code).toBe(1);
  });

  it("names every place a missing name is set, not only the first", () => {
    // Codex on PR #95, round 3: with only the first near-miss named, a config
    // key found before the real (untyped) style object hid the one worth
    // reading behind "(and 1 more)". Both files are named, whichever is first.
    const config = 'export const payload = { "--missing": 1, kind: "config" };';
    const screen = [
      'const vars = () => ({ "--missing": "1px" });',
      'export const S = () => <p className="x" style={vars()} />;',
      'export const T = () => <p className="x" style={{ margin: "var(--missing)" }} />;',
    ].join("\n");
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "lib/config.ts": config, "screens/S.tsx": screen }));
    const line = out.split("\n").find((l) => l.startsWith("FAIL: --missing")) ?? "";
    expect(line).toMatch(/config\.ts:1/);
    expect(line).toMatch(/S\.tsx:1/);
    expect(line).toContain("if one of those objects is applied as a style some other way, give the property a default in CSS");
    expect(code).toBe(1);
  });

  it("does not count setProperty on something that is not a style", () => {
    const src = [
      'declare const api: { setProperty(k: string, v: number): void };',
      'api.setProperty("--notstyle", 1);',
      'export const S = () => <p className="x" style={{ margin: "var(--notstyle)" }} />;',
    ].join("\n");
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "screens/S.tsx": src }));
    expect(out).toContain("FAIL: --notstyle is used but never defined");
    // The hint's remedy fits the call: "type it CSSProperties" cannot apply
    // to a setProperty, and a remedy that cannot apply is noise in a red.
    expect(out).toMatch(/--notstyle is set at .*S\.tsx:2, by setProperty on something that is not `….style`/);
    expect(code).toBe(1);
  });

  it("does not count a key that reaches only a component's style: the component may drop it", () => {
    // Codex on PR #95, round 6: React applies `style` to a host element and to
    // nothing else. A component receives it as an ordinary prop, and whether
    // it passes it on to an element is not visible from here, so its keys are
    // reported, not counted. `motion.div` begins with a lowercase letter and is
    // still a component: the rule reads the tag, not its text.
    const src = [
      "declare const Sink: (p: { style?: object }) => null;",
      'export const S = () => <Sink style={{ "--sunk": "red" }} />;',
      'const vars = { "--via": "1px" };',
      "export const T = () => <Card style={vars} />;",
      'export const U = () => <motion.div style={{ "--moved": "1px" }} />;',
      'export const V = () => <p className="x" style={{ margin: "var(--sunk) var(--via) var(--moved)" }} />;',
    ].join("\n");
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "screens/S.tsx": src }));
    const line = (name: string) => out.split("\n").find((l) => l.startsWith(`FAIL: ${name} is used`)) ?? "";
    expect(line("--sunk")).toMatch(
      /— --sunk is set at .*S\.tsx:2, but reaches only the `style` of `<Sink>`, a component this gate cannot see into; if it passes `style` on to an element, give the property a default in CSS/,
    );
    expect(line("--via")).toMatch(/— --via is set at .*S\.tsx:3, but reaches only the `style` of `<Card>`/);
    expect(line("--moved")).toMatch(/— --moved is set at .*S\.tsx:5, but reaches only the `style` of `<motion\.div>`/);
    expect(code).toBe(1);
  });

  it("counts a host element's style, a dashed custom element included, whatever a component also gets", () => {
    // A tag with a lowercase first letter or a dash is a string to every JSX
    // transform, i.e. a host element, and React applies `style` to it. A const
    // that reaches a component AND a host element counts, whichever is first.
    const src = [
      'export const A = () => <svg style={{ "--svg": "1px" }} />;',
      'export const B = () => <my-widget style={{ "--custom-el": "1px" }} />;',
      'export const C = () => <My-Widget style={{ "--dashed": "1px" }} />;',
      'const both = { "--both": "1px" };',
      "export const D = () => <Card style={both} />;",
      "export const E = () => <div style={both} />;",
      'export const F = () => <p className="x" style={{ margin: "var(--svg) var(--custom-el) var(--dashed) var(--both)" }} />;',
    ].join("\n");
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "screens/Host.tsx": src }));
    expect(out).toContain("PASS:");
    expect(code).toBe(0);
  });

  it("reads a var( in any string as a use, and says how to mention one when the string is not a style", () => {
    // Codex on PR #95, round 6, asked for strings in non-style contexts to be
    // skipped. Declined: a value reaches a style through flows this cannot
    // follow, and the only non-style attribute strings with var() in the tree
    // are SVG stroke/fill, which ARE uses (next case). So a mention is red, and
    // the red says the fix is one token: name the property without `var(`.
    const src = [
      "declare const on: boolean;",
      'export const S = () => <p className="x" title="Use var(--prose) here" />;',
      'export const T = () => <p className="x" title="Use the --named token here" />;',
      'export const U = () => <ul style={{ paddingLeft: "var(--typo)" }} />;',
      'export const V = () => <ul style={{ color: on ? "var(--branch)" : "red" }} />;',
      'export const W = () => <Card style={{ margin: "var(--comp)" }} />;',
      "export const X = (n: number) => <ul style={{ gap: `var(--tpl-${n})` }} />;",
      'export const Y = (n: number) => <ul style={{ gap: "var(--cat-" + n + ")" }} />;',
    ].join("\n");
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "screens/S.tsx": src }));
    const line = (name: string) => out.split("\n").find((l) => l.startsWith(`FAIL: ${name} is used`)) ?? "";
    expect(line("--prose")).toMatch(
      /\(.*S\.tsx:2\) — if this string only mentions --prose rather than applying it, write it without `var\(`: every `var\(` in a string is read as a use/,
    );
    expect(out).not.toContain("--named");
    // A string that visibly sits in a style gets an ordinary red: the hint is
    // for prose, and on the likeliest red — a typo in a style — it is noise.
    for (const name of ["--typo", "--branch", "--comp"]) {
      expect(line(name)).toContain(`FAIL: ${name} is used but never defined`);
      expect(line(name)).not.toContain("only mentions");
    }
    // A name built in a template or by `+` inside a style is still in a style.
    for (const prefix of ["--tpl-", "--cat-"]) {
      const built = out.split("\n").find((l) => l.includes(`none starts with ${prefix} `)) ?? "";
      expect(built).toContain(`FAIL: var(${prefix}…) can name no defined custom property`);
      expect(built).not.toContain("only mentions");
    }
    expect(code).toBe(1);
  });

  it("still reads a non-style attribute as a use: SVG stroke and fill apply tokens", () => {
    // MapView's SVG fallback draws the route with `stroke="var(--…)"`, a
    // presentation attribute rather than a `style`. Chromium applies it
    // (measured), so it is a use, and skipping strings outside a style would
    // stop checking the one place the route's colour is named.
    const src = 'export const R = () => <path stroke="var(--route)" fill="var(--a)" />;';
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "components/Map.tsx": src }));
    expect(out).toContain("FAIL: --route is used but never defined");
    expect(code).toBe(1);
  });

  it("reads token names with underscores whole (the CI copy truncated them)", () => {
    // CI's inline copy read names as [a-zA-Z0-9-], so `var(--a_c)` was seen as
    // `--a`, which IS defined, and passed. validate.sh's copy allowed `_`.
    const ok = 'export const S = () => <p className="x" style={{ margin: "var(--a_b)" }} />;';
    expect(run(tree({ "styles/tokens.css": CSS, "screens/S.tsx": ok })).code).toBe(0);

    const bad = 'export const S = () => <p className="x" style={{ margin: "var(--a_c)" }} />;';
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "screens/S.tsx": bad }));
    expect(out).toContain("FAIL: --a_c is used but never defined");
    expect(code).toBe(1);
  });

  it("does not read test files: a fixture may name a token that does not exist", () => {
    const test = 'it("x", () => render(<p className="t" style={{ color: "var(--nope)" }} />));';
    const { code, out } = run(tree({ "styles/tokens.css": CSS, "screens/Ok.tsx": TSX, "screens/Ok.test.tsx": test }));
    expect(out).toContain("PASS:");
    expect(code).toBe(0);
  });

  describe("refuses to pass having checked nothing", () => {
    it("an empty tree", () => {
      const { code, out } = run(tree({}));
      expect(out).toContain("FAIL: no .css files found");
      expect(out).toContain("FAIL: no .ts/.tsx files found");
      expect(code).toBe(1);
    });

    it("a tree with no TS at all — the shipped gate's whole blind spot", () => {
      const { code, out } = run(tree({ "styles/tokens.css": CSS }));
      expect(out).toContain("FAIL: no .ts/.tsx files found");
      expect(code).toBe(1);
    });

    it("a TS scan that reads no string literals", () => {
      const { code, out } = run(tree({ "styles/tokens.css": CSS, "lib/n.ts": "export const n = 1;\n" }));
      expect(out).toContain("FAIL: the TypeScript scan read no string literals");
      expect(code).toBe(1);
    });
  });
});
