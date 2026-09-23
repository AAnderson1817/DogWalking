import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * There is one Realtime channel in this application, the walk channel, and it
 * is private — on both sides.
 *
 * The topic `walk:{id}` carries the live position of a named person at a
 * named residential address. `private` defaults to FALSE in realtime-js, so
 * omitting the option is the same mistake as writing `private: false`, and
 * it is invisible in review. Migration 0020 authorizes exactly this topic
 * through `realtime.messages` policies; a second channel has no policy, and a
 * public one needs none (review H1).
 *
 * This replaces a CI grep that passed for the wrong reasons (spec-drift
 * audit): it checked that the only FILE calling `supabase.channel(` was
 * `useWalkChannel.ts`, then that the file contained ONE private call — so a
 * second, public `supabase.channel(` in the same file passed; and its server
 * half grepped `_lib/broadcast.ts` for the literal `private: false`, which
 * deleting the option (the default, and just as public) also passes. This
 * reads the calls instead of the text:
 *
 *   - client: every `.channel(` call in `app/src` is counted, wherever its
 *     receiver came from (`supabase.realtime.channel(` included). There must
 *     be exactly one, in `hooks/useWalkChannel.ts`, whose options carry a
 *     literal `config: { private: true }`. A config the scan cannot read is
 *     refused, and so is a bare reference to `.channel` (`const ch =
 *     supabase.channel`), which is how a call leaves the scan's sight.
 *   - server: the edge functions publish through `_lib/broadcast.ts` only,
 *     whose `private: true` is pinned by `broadcast_test.ts`. So no function
 *     may open a channel, and no file but that one may name the broadcast
 *     endpoint.
 *
 * A second channel is a decision, not an accident: it needs its own policy
 * in a migration, and this test changed in the same commit.
 */

const APP_SRC = join(import.meta.dirname, "..", "src");
const FUNCTIONS = join(import.meta.dirname, "..", "..", "supabase", "functions");
const THE_CHANNEL_FILE = "hooks/useWalkChannel.ts";
const THE_PUBLISHER = "_lib/broadcast.ts";
const BROADCAST_ENDPOINT = "/realtime/v1/api/broadcast";

interface Site {
  file: string;
  line: number;
  problem: string | null; // null: a private channel call
}

function parse(file: string, text: string): ts.SourceFile {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

function propertyNamed(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined | null {
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) return null; // a spread could carry anything
    if (!ts.isPropertyAssignment(p)) continue;
    const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : undefined;
    if (key === name) return p.initializer;
  }
  return undefined;
}

/** Why this call's options do not make the channel private, or null if they do. */
function privateProblem(call: ts.CallExpression): string | null {
  const options = call.arguments[1];
  if (!options) return "no options, so `private` defaults to false";
  if (!ts.isObjectLiteralExpression(options)) return "options the scan cannot read";
  const config = propertyNamed(options, "config");
  if (config === null) return "options spread from elsewhere";
  if (config === undefined) return "no `config`, so `private` defaults to false";
  if (!ts.isObjectLiteralExpression(config)) return "a `config` the scan cannot read";
  const flag = propertyNamed(config, "private");
  if (flag === null) return "a `config` spread from elsewhere";
  if (flag === undefined) return "no `private`, which defaults to false";
  if (flag.kind !== ts.SyntaxKind.TrueKeyword) return `\`private: ${flag.getText()}\``;
  return null;
}

const isChannelAccess = (n: ts.Node): n is ts.PropertyAccessExpression | ts.ElementAccessExpression =>
  (ts.isPropertyAccessExpression(n) && n.name.text === "channel")
  || (ts.isElementAccessExpression(n) && ts.isStringLiteral(n.argumentExpression)
    && n.argumentExpression.text === "channel");

/** Every `.channel` in a file: a call is judged on its options, anything else is refused. */
function channelSites(file: string, text: string): Site[] {
  const sf = parse(file, text);
  const sites: Site[] = [];
  const visit = (node: ts.Node) => {
    if (isChannelAccess(node)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const call = node.parent;
      if (ts.isCallExpression(call) && call.expression === node) {
        sites.push({ file, line, problem: privateProblem(call) });
      } else {
        sites.push({ file, line, problem: "`.channel` referenced without being called, so the scan cannot see its options" });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

/** Strings in a file that name the broadcast endpoint (comments are not strings). */
function endpointMentions(file: string, text: string): number[] {
  const sf = parse(file, text);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    const isString = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
    if (isString && (node as ts.LiteralLikeNode).text.includes(BROADCAST_ENDPOINT)) {
      lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "_tests" || e.name === "node_modules" ? [] : sources(p);
    return /\.tsx?$/.test(e.name) && !/(\.test|_test)\.tsx?$/.test(e.name) ? [p] : [];
  });
}

const rel = (root: string, path: string) => relative(root, path).split("\\").join("/");

/** The client rule, over a set of files: `file -> text`. */
function clientProblems(files: Map<string, string>): { sites: Site[]; problems: string[] } {
  const sites = [...files].flatMap(([file, text]) => channelSites(file, text));
  const problems: string[] = [];
  for (const s of sites) {
    if (s.file !== THE_CHANNEL_FILE) problems.push(`${s.file}:${s.line} opens a channel outside ${THE_CHANNEL_FILE}`);
    if (s.problem) problems.push(`${s.file}:${s.line} is not private: ${s.problem}`);
  }
  if (sites.length !== 1) {
    problems.push(`expected exactly one channel call, found ${sites.length}: `
      + sites.map((s) => `${s.file}:${s.line}`).join(", "));
  }
  return { sites, problems };
}

/** The server rule, over a set of files. */
function serverProblems(files: Map<string, string>): { publisherNamesEndpoint: boolean; problems: string[] } {
  const problems: string[] = [];
  let publisherNamesEndpoint = false;
  for (const [file, text] of files) {
    for (const s of channelSites(file, text)) {
      problems.push(`${s.file}:${s.line} opens a Realtime channel on the server — publish through ${THE_PUBLISHER}`);
    }
    const mentions = endpointMentions(file, text);
    if (file === THE_PUBLISHER) publisherNamesEndpoint = mentions.length > 0;
    else for (const line of mentions) problems.push(`${file}:${line} calls the broadcast endpoint directly — use ${THE_PUBLISHER}`);
  }
  return { publisherNamesEndpoint, problems };
}

const read = (root: string) =>
  new Map(sources(root).map((p) => [rel(root, p), readFileSync(p, "utf8")] as [string, string]));

describe("the walk channel is private, and is the only channel", () => {
  it("holds in the app", () => {
    const { sites, problems } = clientProblems(read(APP_SRC));
    expect(problems, problems.join("\n")).toEqual([]);
    // Belt and braces for the count above: the one site the scan found is
    // the real call, not something that merely happens to be counted.
    expect(sites.map((s) => s.file)).toEqual([THE_CHANNEL_FILE]);
  });

  it("holds in the edge functions", () => {
    const { publisherNamesEndpoint, problems } = serverProblems(read(FUNCTIONS));
    // Precondition: the scan sees the one publish path, or a scan that read
    // nothing would report that nothing publishes.
    expect(publisherNamesEndpoint, `${THE_PUBLISHER} no longer names ${BROADCAST_ENDPOINT} — the scan is blind`).toBe(true);
    expect(problems, problems.join("\n")).toEqual([]);
  });
});

describe("what the channel scan refuses and admits", () => {
  const client = (entries: Record<string, string>) => clientProblems(new Map(Object.entries(entries))).problems;
  const PRIVATE = "supabase.channel(`walk:${id}`, { config: { private: true } });";

  it("admits the one private channel in its file", () => {
    expect(client({ [THE_CHANNEL_FILE]: PRIVATE })).toEqual([]);
  });

  it("refuses a second channel in the same file — the shape the grep passed", () => {
    const problems = client({ [THE_CHANNEL_FILE]: `${PRIVATE}\nsupabase.channel("walk-debug");` });
    expect(problems.join("\n")).toMatch(/:2 is not private: no options/);
    expect(problems.join("\n")).toMatch(/exactly one channel call, found 2/);
  });

  it("refuses a second channel even when it is private — it has no policy", () => {
    // Only the count can see this one: each call is private on its own.
    expect(client({ [THE_CHANNEL_FILE]: `${PRIVATE}\n${PRIVATE}` }))
      .toEqual([expect.stringMatching(/exactly one channel call, found 2/)]);
  });

  it("refuses every way of not saying private: true", () => {
    const one = (call: string) => client({ [THE_CHANNEL_FILE]: call }).join("\n");
    expect(one("supabase.channel(`walk:${id}`);")).toMatch(/no options/);
    expect(one("supabase.channel(t, { config: { private: false } });")).toMatch(/`private: false`/);
    expect(one("supabase.channel(t, { config: { broadcast: { self: true } } });")).toMatch(/no `private`/);
    expect(one("supabase.channel(t, { config: cfg });")).toMatch(/a `config` the scan cannot read/);
    expect(one("supabase.channel(t, opts);")).toMatch(/options the scan cannot read/);
    expect(one("supabase.channel(t, { ...opts });")).toMatch(/spread from elsewhere/);
    expect(one("supabase.channel(t, { config: { private: isPrivate } });")).toMatch(/`private: isPrivate`/);
  });

  it("refuses a channel in any other file, and a receiver the grep did not know", () => {
    expect(client({ "screens/Other.tsx": PRIVATE }).join("\n")).toMatch(/outside hooks\/useWalkChannel\.ts/);
    expect(client({ [THE_CHANNEL_FILE]: "supabase.realtime.channel(t);" }).join("\n")).toMatch(/no options/);
    expect(client({ [THE_CHANNEL_FILE]: 'supabase["channel"](t);' }).join("\n")).toMatch(/no options/);
  });

  it("refuses `.channel` taken without a call, where its options would be out of sight", () => {
    expect(client({ [THE_CHANNEL_FILE]: "const open = supabase.channel;\nopen(t);" }).join("\n"))
      .toMatch(/referenced without being called/);
  });

  it("does not count a comment", () => {
    expect(client({ [THE_CHANNEL_FILE]: `// supabase.channel(t) is public by default\n${PRIVATE}` })).toEqual([]);
  });

  it("refuses a server-side channel, and a second publisher", () => {
    const server = (entries: Record<string, string>) =>
      serverProblems(new Map(Object.entries(entries))).problems.join("\n");
    const publisher = { [THE_PUBLISHER]: "fetch(`${url}/realtime/v1/api/broadcast`);" };
    expect(server(publisher)).toBe("");
    expect(server({ ...publisher, "complete-walk/index.ts": "client.channel(t).send(m);" }))
      .toMatch(/opens a Realtime channel on the server/);
    expect(server({ ...publisher, "complete-walk/index.ts": "await fetch(`${u}/realtime/v1/api/broadcast`);" }))
      .toMatch(/calls the broadcast endpoint directly/);
    // Prose is not a call.
    expect(server({ ...publisher, "complete-walk/index.ts": "// posts to /realtime/v1/api/broadcast" })).toBe("");
  });
});
