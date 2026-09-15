import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * There is exactly ONE Realtime channel in this application, and both sides of
 * it declare `private: true`.
 *
 * Review H1: `private` defaults to FALSE in realtime-js, Supabase authorizes
 * private channels only, and a public topic of the same name is joinable by
 * any holder of the anon key — which ships in the bundle. While a walk was in
 * progress that meant broadcasting the live position of a named person at a
 * named residential address to anyone who asked, and accepting `send` on the
 * same topic, so the proof of service the product sells could be fabricated.
 * Migration 0020 wrote the `realtime.messages` policies for `walk:{id}` and
 * nothing else, so a SECOND channel is an unauthorized topic by construction.
 *
 * This replaces a `ci.yml` grep step, and it replaces it for two reasons that
 * pull in opposite directions — which is why the answer is a parser.
 *
 *  - The grep passed for the wrong reason. `grep -rln` yields FILE names, so a
 *    second `supabase.channel(…)` planted inside `useWalkChannel.ts` left the
 *    same one filename and the step reported PASS. Measured.
 *
 *  - Counting instead fixed that and made the check RED ON A HEALTHY TREE,
 *    which this repository's log calls the worst shape available, because the
 *    private-call count came from `supabase\.channel\([^)]*config: *\{ *private: true`.
 *    Measured against three spellings that are all correct code:
 *      `supabase.channel(topicFor(walkId), { config: { private: true } })`
 *        — `[^)]*` stops at the inner call's `)`,            gate RED
 *      `supabase.channel(`walk:${walkId}`, { config: { private:true } })`
 *        — no space after the colon,                          gate RED
 *      `supabase.channel(`walk:${walkId}`, {config:{private: true}})`
 *        —                                                    gate green
 *    Nothing in this repository enforces that spacing (no prettier, no oxlint
 *    quote or spacing rule), so two of the three were one edit away.
 *
 * A regex over an argument list is the wrong instrument for a question about
 * an argument list. The compiler already knows where the call ends and which
 * property is which.
 */

const APP_SRC = fileURLToPath(new URL("../src", import.meta.url));
const BROADCAST = fileURLToPath(
  new URL("../../supabase/functions/_lib/broadcast.ts", import.meta.url),
);

/** The one file allowed to open a channel, relative to `app/src`. */
const CHANNEL_OWNER = "hooks/useWalkChannel.ts";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

interface ChannelCall {
  file: string;
  line: number;
  private: boolean;
  why: string;
}

/**
 * The local names in `file` that hold the Supabase client.
 *
 * The first version of this file asked whether the receiver was the
 * IDENTIFIER `supabase`, which is a spelling and not an identity: Codex
 * planted `const realtime = supabase; realtime.channel(\`walk:${walkId}\`)` —
 * a second, PUBLIC topic — and all five tests stayed green, because the real
 * call still satisfied the precondition and `calls.length` never moved. The
 * import may be renamed too (`import { supabase as db }`), which is ordinary
 * TypeScript and would have been equally invisible.
 *
 * So: seed from the IMPORT of `supabase` (whatever it is bound to locally),
 * then take the fixpoint over plain aliases — `const x = <client>`, and the
 * same through a cast or parentheses, which are transparent. That is the same
 * receiver-resolution `discarded-errors.test.ts` had to build for supabase-js
 * query chains, and for the same reason: a receiver is a value, not a word.
 *
 * Deliberately NOT the compiler's symbol resolution here, which would need a
 * Program over the whole app for one question; a per-file scan sees every
 * alias reachable without a module hop, and a client that crosses a module
 * boundary under a new name arrives through an import this seeds from.
 */
function clientNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteralLike(st.moduleSpecifier)) continue;
    if (!/(^|\/)supabase$/.test(st.moduleSpecifier.text)) continue;
    const named = st.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      if ((el.propertyName ?? el.name).text === "supabase") names.add(el.name.text);
    }
  }

  // Parentheses, `as`, `satisfies` and `!` all hand the same value through.
  const unwrap = (e: ts.Expression): ts.Expression => {
    let cur = e;
    for (;;) {
      if (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur)
        || ts.isSatisfiesExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
      else return cur;
    }
  };

  // Fixpoint: an alias of an alias is still the client.
  for (let grew = true; grew;) {
    grew = false;
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const init = unwrap(n.initializer);
        if (ts.isIdentifier(init) && names.has(init.text) && !names.has(n.name.text)) {
          names.add(n.name.text);
          grew = true;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return names;
}

function channelCalls(files: string[]): ChannelCall[] {
  const found: ChannelCall[] = [];
  for (const file of files) {
    const source = parse(file);
    const clients = clientNames(source);
    const declared = declaredObjects(source);
    const rel = relative(APP_SRC, file).split("\\").join("/");
    const visit = (node: ts.Node): void => {
      // Every `.channel(…)` call is looked at, and its receiver is then
      // CLASSIFIED — a receiver this file cannot resolve to the client is
      // reported rather than skipped, because "cannot say" is not "not a
      // channel". Measured on the healthy tree: one `.channel(` in app/src,
      // on the client, so refusing the unresolvable is not a red on healthy
      // code. The day something unrelated grows a `.channel` method, somebody
      // decides here rather than the gate quietly stopping looking.
      if (
        ts.isCallExpression(node) &&
        ((ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "channel") ||
          (ts.isElementAccessExpression(node.expression) &&
            ts.isStringLiteralLike(node.expression.argumentExpression) &&
            node.expression.argumentExpression.text === "channel"))
      ) {
        const receiver = node.expression.expression;
        const onClient = ts.isIdentifier(receiver) && clients.has(receiver.text);
        if (!onClient) {
          found.push({
            file: rel,
            line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            private: false,
            why: `\`${receiver.getText()}.channel(…)\` — this check cannot resolve that receiver to the `
              + `Supabase client, so it cannot say the topic is private. Classify it here.`,
          });
          ts.forEachChild(node, visit);
          return;
        }
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const opts = node.arguments[1];
        let isPrivate = false;
        let why = "no options argument";
        if (!opts) {
          // `supabase.channel(topic)` is the exact H1 defect: `private`
          // defaults to false, so an omitted option is a PUBLIC topic.
          why = "called with no options — `private` defaults to false (H1)";
        } else if (!ts.isObjectLiteralExpression(opts)) {
          why = "options are not an object literal, so this check cannot read them";
        } else {
          // Through the SAME reader the server side uses, spreads and all.
          // The first version read this side with a direct-property helper
          // while the message side resolved spreads, so
          // `config: { private: true, ...{ private: false } }` reported
          // private on a client that joins a PUBLIC topic — one rule, two
          // scopes, which is the disagreement this repository keeps paying
          // for. There is one reader now, so there is no sibling to forget.
          const config = effectiveProps(opts, declared).get("config");
          if (config === undefined) why = "options carry no `config`";
          else if (typeof config === "string") why = `\`config\` is ${config}`;
          else if (!ts.isObjectLiteralExpression(config))
            why = "`config` is not an object literal, so this check cannot read it";
          else {
            const priv = effectiveProps(config, declared).get("private");
            if (priv === undefined) why = "`config` carries no `private`";
            else if (isLiteralTrue(priv)) {
              isPrivate = true;
              why = "config.private is true";
            } else why = `config.private is \`${shownAs(priv)}\`, not the literal true`;
          }
        }
        found.push({ file: rel, line, private: isPrivate, why });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

/**
 * The object literals in `file`, indexed by the name they are declared under,
 * so a spread of one can be resolved where it is used.
 *
 * One hop by name is all this needs and all it claims: `const message = {…}`
 * spread into a message literal. A spread of anything else is reported as
 * unresolvable by the caller rather than assumed harmless.
 */
function declaredObjects(sf: ts.SourceFile): Map<string, ts.ObjectLiteralExpression> {
  const out = new Map<string, ts.ObjectLiteralExpression>();
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
      && ts.isObjectLiteralExpression(n.initializer)) {
      out.set(n.name.text, n.initializer);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * The properties an object literal EFFECTIVELY carries, spreads resolved in
 * source order — later wins, exactly as the language does it.
 *
 * Returns a map of name to the value's source text, or to a marker this check
 * cannot read. A spread it cannot follow marks the two names this file asks
 * about, so the literal fails rather than passing by omission.
 *
 * SHORTHAND is why this returns a map rather than a set of names, and the
 * distinction is one this file has already paid for: `broadcast.ts` writes
 * `{ topic, event, payload, private: true }`, where three of the four carry no
 * initializer at all, so a reader asking only for initializers could not find
 * the message literal and the precondition said so. Presence is enough for
 * `topic`; a shorthand `private` is a REFERENCE this check cannot resolve, and
 * is recorded as unreadable rather than as true.
 *
 * This is the fix for the round after the multiple-literal one, and it is the
 * same defect a level down: the scan keyed on a DIRECT `topic` property, so
 * `const message = { topic, event, payload, private: true }` spread into
 * `messages: [{ ...message, private: false }]` left the public literal with no
 * direct `topic`, invisible, while the base literal supplied a reassuring
 * `true` from a line that is not what gets sent. Measured: 6 of 6 green while
 * `broadcast.ts` published a public message.
 */
function effectiveProps(
  obj: ts.ObjectLiteralExpression,
  declared: Map<string, ts.ObjectLiteralExpression>,
  depth = 0,
): Map<string, ts.Expression | string> {
  // The names this file asks about, at any depth: an unreadable spread has to
  // invalidate each of them, since it could carry any of them.
  const ASKED = ["topic", "private", "config"];
  const props = new Map<string, ts.Expression | string>();
  const markAll = (mark: string) => { for (const k of ASKED) props.set(k, mark); };

  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) {
      // A spread of a literal written in place, or of one declared by name.
      const inline = ts.isObjectLiteralExpression(p.expression) ? p.expression : undefined;
      const named = ts.isIdentifier(p.expression) ? declared.get(p.expression.text) : undefined;
      const from = inline ?? named;
      if (from && depth < 8) {
        for (const [k, v] of effectiveProps(from, declared, depth + 1)) props.set(k, v);
      } else {
        // Cannot follow it, so cannot say what it carries — and ORDER is why
        // this has to overwrite rather than merely add a note: a spread AFTER
        // `private: true` can replace it, so leaving the `true` standing would
        // let `{ private: true, ...unknown }` pass on a value that may not
        // survive. A later direct assignment overwrites the mark in turn,
        // exactly as the language would.
        markAll(`<unresolvable spread \`${p.expression.getText()}\`>`);
      }
      continue;
    }
    if (ts.isPropertyAssignment(p)) {
      const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
      if (key !== null) props.set(key, p.initializer);
      // A computed key could be any of the names this file asks about, and
      // there is no way to tell which, so all of them are marked unreadable.
      else markAll("<computed key, unreadable>");
      continue;
    }
    if (ts.isShorthandPropertyAssignment(p)) {
      // A shorthand carries a REFERENCE this check cannot resolve. Fine for
      // `topic`, where presence is the question; not fine for `private`, which
      // is why the value is recorded as unreadable rather than as true.
      props.set(p.name.text, "<shorthand, unreadable>");
    }
  }
  return props;
}

/** The text a reader should print for a resolved property. */
function shownAs(v: ts.Expression | string | undefined): string {
  if (v === undefined) return "<absent>";
  return typeof v === "string" ? v : v.getText();
}

/** Whether a resolved property is the literal `true` and not a marker. */
function isLiteralTrue(v: ts.Expression | string | undefined): boolean {
  return typeof v === "object" && v.kind === ts.SyntaxKind.TrueKeyword;
}

/**
 * `private` in EVERY message literal in the broadcast body, not the last one.
 *
 * The first version kept a single result and each match overwrote it, so a
 * `broadcast.ts` that published a public message and then a private one read
 * as private — measured, green while the server published to the public topic.
 * Every match is collected now and every one has to be the literal `true`.
 */
function serverPrivate(): { found: boolean; values: string[] } {
  const source = parse(BROADCAST);
  const declared = declaredObjects(source);
  const values: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      // `topic` alone is what makes this a message object — NOT `topic` AND
      // `private`. Requiring both excluded exactly the literal that matters:
      // `messages: [{ topic, event, payload }, { topic, event, payload,
      // private: true }]` shipped a PUBLIC message and the sibling satisfied
      // the assertion, measured green. That is review H1's whole point —
      // `private` DEFAULTS to false, so omitting it is not a smaller mistake
      // than writing `false`, it is the same one — so an omitted `private` is
      // recorded as `<absent>` and fails like any other non-`true` value.
      //
      // Read through SPREADS, in source order, because a literal's direct
      // properties are not what it carries: `{ ...message, private: false }`
      // has no direct `topic` and was skipped entirely while its base supplied
      // a `true` from a line that is not what gets sent.
      const props = effectiveProps(node, declared);
      if (props.has("topic")) values.push(shownAs(props.get("private")));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { found: values.length > 0, values };
}

describe("the walk channel is the only channel, and it is private on both sides", () => {
  const files = sourceFiles(APP_SRC);
  const calls = channelCalls(files);

  // The receiver resolver, pinned on fixtures rather than only on the one real
  // call. Both directions matter and they are not the same rule: a resolver
  // that admitted nothing would report every call unresolvable and pass every
  // sabotage of the alias rule for the wrong reason, while one that admitted
  // anything would be back to reading a spelling. So: the client arrives
  // through its import under whatever local name, aliases of it are the same
  // value, and a name that is not the client is not admitted.
  it("resolves the Supabase client through imports and aliases, and nothing else", () => {
    const names = (src: string): string[] =>
      [...clientNames(ts.createSourceFile("f.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS))].sort();

    expect(names('import { supabase } from "@/lib/supabase";')).toEqual(["supabase"]);
    expect(names('import { supabase as db } from "./supabase";')).toEqual(["db"]);
    expect(names('import { supabase } from "./supabase";\nconst realtime = supabase;'))
      .toEqual(["realtime", "supabase"]);
    expect(names('import { supabase } from "./supabase";\nconst a = supabase;\nconst b = (a as never);'))
      .toEqual(["a", "b", "supabase"]);
    // Not the client: a different export, a different module, and a value
    // built by a call rather than handed through.
    expect(names('import { createClient } from "./supabase";')).toEqual([]);
    expect(names('import { supabase } from "./not-supabase-module";')).toEqual([]);
    expect(names('import { supabase } from "./supabase";\nconst c = makeThing(supabase);')).toEqual(["supabase"]);
  });

  // The message reader, pinned on fixtures. `serverPrivate()` reads one real
  // file, so every rule about spreads and ordering would otherwise be proven
  // only under sabotage and by nothing in the committed suite.
  it("reads a message literal through spreads, in source order", () => {
    const read = (src: string): string[] => {
      const sf = ts.createSourceFile("b.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const declared = declaredObjects(sf);
      const out: string[] = [];
      const visit = (n: ts.Node): void => {
        if (ts.isObjectLiteralExpression(n)) {
          const props = effectiveProps(n, declared);
          if (props.has("topic")) out.push(shownAs(props.get("private")));
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
      return out;
    };

    expect(read("send({ topic, event, private: true });")).toEqual(["true"]);
    expect(read("send({ topic, event });")).toEqual(["<absent>"]);
    expect(read("send({ topic, event, private: false });")).toEqual(["false"]);
    // Codex's case: a base literal supplies `topic` and a reassuring `true`
    // from a line that is not what gets sent, while the override goes public.
    // Both literals are read; the sent one reads `false`.
    expect(read("const m = { topic, private: true };\nsend({ ...m, private: false });"))
      .toEqual(["true", "false"]);
    // Later wins the other way too.
    expect(read("const m = { topic, private: false };\nsend({ ...m, private: true });"))
      .toEqual(["false", "true"]);
    // A spread this file cannot follow marks both names, so a `true` written
    // BEFORE it does not stand — the spread could replace it.
    expect(read("send({ topic, private: true, ...extra });"))
      .toEqual(["<unresolvable spread `extra`>"]);
    // …and a direct assignment AFTER such a spread does stand, as JSX's
    // sibling rule does: the language says later wins, and so does this.
    expect(read("send({ topic, ...extra, private: true });")).toEqual(["true"]);
    // A shorthand `private` is a reference this file cannot resolve, and
    // "cannot say" is not "is private".
    expect(read("send({ topic, private });")).toEqual(["<shorthand, unreadable>"]);
    // A spread written in place, and nested — the same reader now serves the
    // CLIENT's `config` object, where Codex found the sibling hole. Note that
    // EVERY object literal in the file is read, so a composed message reports
    // once for the composition and once for each nested literal carrying a
    // `topic` of its own. That is the conservative direction and it is what
    // makes the `const m = …` case above report two values: every literal
    // that could be sent has to clear the bar, not just the outermost.
    expect(read("send({ ...{ topic, private: true } });")).toEqual(["true", "true"]);
    expect(read("send({ topic, private: true, ...{ private: false } });")).toEqual(["false"]);
    expect(read("send({ ...{ ...{ topic, private: false } } });"))
      .toEqual(["false", "false", "false"]);

    // And the precondition on the reader itself: a literal with no `topic` at
    // all is not a message and contributes nothing, so a reader that answered
    // for every object literal would be reporting on code that sends nothing.
    expect(read("const opts = { retries: 3 };")).toEqual([]);
  });

  // Preconditions. "No channel is public" is satisfied by a scanner that finds
  // no channels, so the scan is proven live before it is believed.
  it("reads the source files under app/src", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("finds the real channel call", () => {
    // The FILE, never the line. A precondition pinned to a line number is red
    // the first time somebody edits a comment above it, which is a gate red on
    // a healthy tree — the exact shape the rest of this file is about. The
    // line still appears in every failure message, which is where it helps.
    expect(
      calls.map((c) => c.file),
      "the parser found no supabase.channel() call at all — it is not reading calls",
    ).toContain(CHANNEL_OWNER);
  });

  it("is the only channel in the application", () => {
    expect(
      calls.map((c) => `${c.file}:${c.line}`),
      "every channel needs its own realtime.messages policy (migration 0020 wrote one, " +
        "for `walk:{id}`); add the policy and extend this check rather than opening an " +
        "unauthorized topic",
    ).toHaveLength(1);
  });

  it("opens it privately", () => {
    const public_ = calls.filter((c) => !c.private);
    expect(
      public_.map((c) => `${c.file}:${c.line} — ${c.why}`),
      "a topic opened without config.private is joinable by any holder of the anon key, " +
        "which ships in the bundle (review H1)",
    ).toEqual([]);
  });

  // The server half. A message published as PUBLIC is not delivered to
  // subscribers of the private topic, so this is a correctness rule as much as
  // a security one: the client's "walk ended" signal stops arriving.
  it("publishes privately from the server", () => {
    const server = serverPrivate();
    expect(server.found, "no `{ topic, …, private }` message literal in broadcast.ts").toBe(
      true,
    );
    expect(
      server.values.filter((v) => v !== "true"),
      "every message broadcast.ts publishes must go to the private topic — one public " +
        "message is enough to put a walk's live position on a topic anyone can join",
    ).toEqual([]);
  });
});
