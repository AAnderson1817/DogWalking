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

/**
 * The value of `name` in an object literal, or null when the property is
 * absent, computed, or spread in. Null is "this check cannot say", and every
 * caller treats it as NOT private — refusing is the safe direction for a
 * question about whether a topic is authorized.
 */
function property(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
    if (key === name) return p.initializer;
  }
  return null;
}

/**
 * Whether `name` is written in the literal at all, shorthand included.
 *
 * Separate from `property` on purpose, and the separation is load-bearing:
 * `broadcast.ts` writes `{ topic, event, payload, private: true }`, where
 * three of the four are SHORTHAND and carry no initializer. Asking `property`
 * for `topic` there answers null, and the first version of this file did
 * exactly that — so it could not find the message literal at all and its own
 * precondition said so. A shorthand `private` would likewise be a reference
 * this check cannot resolve, which is why the VALUE still comes from
 * `property` and only the PRESENCE question accepts shorthand.
 */
function has(obj: ts.ObjectLiteralExpression, name: string): boolean {
  return obj.properties.some((p) => {
    if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) return false;
    return (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name;
  });
}

interface ChannelCall {
  file: string;
  line: number;
  private: boolean;
  why: string;
}

function channelCalls(files: string[]): ChannelCall[] {
  const found: ChannelCall[] = [];
  for (const file of files) {
    const source = parse(file);
    const rel = relative(APP_SRC, file).split("\\").join("/");
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "channel" &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "supabase"
      ) {
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
          const config = property(opts, "config");
          if (!config) why = "options carry no `config`";
          else if (!ts.isObjectLiteralExpression(config))
            why = "`config` is not an object literal, so this check cannot read it";
          else {
            const priv = property(config, "private");
            if (!priv) why = "`config` carries no `private`";
            else if (priv.kind === ts.SyntaxKind.TrueKeyword) {
              isPrivate = true;
              why = "config.private is true";
            } else why = `config.private is \`${priv.getText()}\`, not the literal true`;
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
 * `private` in EVERY message literal in the broadcast body, not the last one.
 *
 * The first version kept a single result and each match overwrote it, so a
 * `broadcast.ts` that published a public message and then a private one read
 * as private — measured, green while the server published to the public topic.
 * Every match is collected now and every one has to be the literal `true`.
 */
function serverPrivate(): { found: boolean; values: string[] } {
  const source = parse(BROADCAST);
  const values: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      // `topic` is what makes this the message object rather than some other
      // literal that happens to carry a `private` key. Presence is asked with
      // `has` because `topic` is shorthand here; the VALUE of `private` still
      // has to be a real assignment, since a shorthand one is a reference this
      // check cannot resolve and "cannot say" is not "is private".
      if (has(node, "private") && has(node, "topic")) {
        const priv = property(node, "private");
        values.push(priv ? priv.getText() : "<shorthand, unreadable>");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { found: values.length > 0, values };
}

describe("the walk channel is the only channel, and it is private on both sides", () => {
  const files = sourceFiles(APP_SRC);
  const calls = channelCalls(files);

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
