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
 *     receiver came from (`supabase.realtime.channel(` included) and however
 *     the member is spelled (`["channel"]`, `` [`channel`] ``). There must be
 *     exactly one, in `hooks/useWalkChannel.ts`, whose options carry a
 *     literal `config: { private: true }` — read as the LAST definition of
 *     each key, since that is the one that holds. A config the scan cannot
 *     read is refused, and so are a bare reference to `.channel` (`const ch =
 *     supabase.channel`), a call through a member it cannot read
 *     (`supabase[name](…)`), and a member taken by destructuring (`const {
 *     channel } = supabase`, or under a key it cannot read), which are how a
 *     call leaves the scan's sight.
 *   - server: the edge functions publish through `_lib/broadcast.ts` only,
 *     whose `private: true` is pinned by `broadcast_test.ts`. So no function
 *     may open a channel, and no file but that one may name the broadcast
 *     endpoint — in a literal, or assembled by `+` or a template (`base +
 *     "/realtime/v1/api/" + "broadcast"` named it in no single literal, Codex
 *     on #97). The pieces are folded through the constants the scan can read,
 *     what it cannot compute is a hole, and the text either side of a hole is
 *     read as it runs; a red is reported once, where the string is formed.
 *
 * Both halves catch a mistake made in good faith and refuse what they cannot
 * read. They do not model every way a string or a call can be assembled at
 * run time, and are not meant to stop code written to get past them.
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

/** A name only running the code would tell: a computed key, `obj[expr]`. */
const UNREADABLE = Symbol("unreadable");

const literalText = (e: ts.Expression): string | undefined =>
  ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isNumericLiteral(e) ? e.text : undefined;

/** The name a key spells however it is spelled — `a`, `"a"`, `["a"]`, `` [`a`] `` — or UNREADABLE. */
function keyOf(name: ts.PropertyName): string | typeof UNREADABLE {
  if (ts.isComputedPropertyName(name)) return literalText(name.expression) ?? UNREADABLE;
  return name.text;
}

type Member = { value: ts.Expression } | { absent: true } | { unknown: string };

/**
 * What an object literal gives `name`. The LAST definition is the one that
 * holds at run time, so the properties are read from the end, and anything
 * after the last definition that could also define `name` — a spread, a key
 * the scan cannot read — makes the answer unknown rather than the earlier
 * value. Reading from the front took `{ config: { private: true }, ...extra }`
 * as private while `extra` could replace it.
 */
function member(obj: ts.ObjectLiteralExpression, name: string): Member {
  for (const p of [...obj.properties].reverse()) {
    if (ts.isSpreadAssignment(p)) return { unknown: "spread from elsewhere" };
    const key = keyOf(p.name);
    if (key === UNREADABLE) return { unknown: "with a key the scan cannot read" };
    if (key !== name) continue;
    if (ts.isPropertyAssignment(p)) return { value: p.initializer };
    if (ts.isShorthandPropertyAssignment(p)) return { value: p.name };
    return { unknown: `with \`${name}\` defined by an accessor or a method` };
  }
  return { absent: true };
}

/** Why this call's options do not make the channel private, or null if they do. */
function privateProblem(call: ts.CallExpression): string | null {
  const options = call.arguments[1];
  if (!options) return "no options, so `private` defaults to false";
  if (!ts.isObjectLiteralExpression(options)) return "options the scan cannot read";
  const config = member(options, "config");
  if ("unknown" in config) return `options ${config.unknown}`;
  if ("absent" in config) return "no `config`, so `private` defaults to false";
  if (!ts.isObjectLiteralExpression(config.value)) return "a `config` the scan cannot read";
  const flag = member(config.value, "private");
  if ("unknown" in flag) return `a \`config\` ${flag.unknown}`;
  if ("absent" in flag) return "no `private`, which defaults to false";
  if (flag.value.kind !== ts.SyntaxKind.TrueKeyword) return `\`private: ${flag.value.getText()}\``;
  return null;
}

/** The member an access names — `a.b`, `a["b"]`, `` a[`b`] `` — or UNREADABLE. */
function memberOf(e: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | typeof UNREADABLE {
  return ts.isPropertyAccessExpression(e) ? e.name.text : literalText(e.argumentExpression) ?? UNREADABLE;
}

/**
 * An object literal written where a value is ASSIGNED TO rather than built:
 * the left of `=`, nested in another such literal (or an array one), or the
 * variable of a `for … of`/`for … in`.
 */
function isAssignmentTarget(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isBinaryExpression(parent)) return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === node;
  if (ts.isParenthesizedExpression(parent)) return isAssignmentTarget(parent);
  if ((ts.isPropertyAssignment(parent) && parent.initializer === node) || ts.isSpreadAssignment(parent)
    || ts.isSpreadElement(parent)) return isAssignmentTarget(parent.parent);
  if (ts.isArrayLiteralExpression(parent)) return isAssignmentTarget(parent);
  if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) return parent.initializer === node;
  return false;
}

/**
 * Every `.channel` in a file: a call is judged on its options, anything else
 * is refused. The member is read however it is spelled — the shipped scan
 * knew `a["channel"]` and not `` a[`channel`] `` (Codex, on #97) — and a CALL
 * through a member the scan cannot read (`a[name](…)`) could be `.channel(`,
 * so it is refused too. Indexing that is not called is ordinary code and is
 * not counted; a member taken that way and called later is outside the scan.
 */
function channelSites(file: string, text: string): Site[] {
  const sf = parse(file, text);
  const sites: Site[] = [];
  const visit = (node: ts.Node) => {
    // Destructuring takes the member without an access expression at all:
    // `const { channel } = supabase; channel.call(supabase, t)` (Codex, on
    // #97). A `channel` key in an object binding pattern, or in an object
    // literal that is being assigned to, is refused like a bare reference —
    // and so is a key the scan cannot read there, `const { [key]: open } =
    // supabase` (Codex again), since it could be `channel`. That costs nothing
    // today: the tree destructures with no computed key at all (measured, 623
    // object binding elements). An array pattern takes by position and a rest
    // element takes what is left, so neither names a member, and the shipped
    // rule refused `const [channel] = pair` as though it did. An object
    // literal that is merely BUILT with a `channel` field — the notification
    // delivery channel in send-notification — is data, not a member taken.
    const taken = ts.isBindingElement(node)
      ? ts.isObjectBindingPattern(node.parent) && !node.dotDotDotToken
        ? node.propertyName ? keyOf(node.propertyName) : ts.isIdentifier(node.name) ? node.name.text : undefined
        : undefined
      : (ts.isShorthandPropertyAssignment(node) || ts.isPropertyAssignment(node)) && isAssignmentTarget(node.parent)
        ? keyOf(node.name)
        : undefined;
    if (taken === "channel" || taken === UNREADABLE) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      sites.push({
        file,
        line,
        problem: taken === "channel"
          ? "`.channel` taken by destructuring, so the scan cannot see its options"
          : "a member taken by destructuring under a key the scan cannot read, which could be `channel`",
      });
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = memberOf(node);
      const call = ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : undefined;
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      if (name === "channel" && call) {
        sites.push({ file, line, problem: privateProblem(call) });
      } else if (name === "channel") {
        sites.push({ file, line, problem: "`.channel` referenced without being called, so the scan cannot see its options" });
      } else if (name === UNREADABLE && call) {
        sites.push({ file, line, problem: "a call through a member the scan cannot read, which could be `.channel(`" });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  noLib: true,
  noResolve: true,
  target: ts.ScriptTarget.Latest,
  skipLibCheck: true,
  types: [],
};

/**
 * One file, parsed and bound, so a `const` can be followed to its binding —
 * the FormError scan's shape. Imports are not resolved: a constant from
 * another file is a hole.
 */
function checked(file: string, text: string): { sf: ts.SourceFile; checker: ts.TypeChecker } {
  const sf = parse(file, text);
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === file ? sf : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (f) => f === file,
    readFile: (f) => (f === file ? text : undefined),
    directoryExists: () => true,
    getDirectories: () => [],
  };
  return { sf, checker: ts.createProgram([file], COMPILER_OPTIONS, host).getTypeChecker() };
}

/** The initializer a `const` identifier is bound to, by the checker's symbol; undefined for anything else. */
function constOf(id: ts.Identifier, checker: ts.TypeChecker): ts.Expression | undefined {
  const symbol = checker.getSymbolAtLocation(id);
  const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer || !ts.isIdentifier(decl.name)) return undefined;
  const list = decl.parent;
  return ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0 ? decl.initializer : undefined;
}

/** A part of an assembled string the scan cannot compute: a parameter, a call, a `let`, an import. */
const HOLE = Symbol("hole");
type Piece = string | typeof HOLE;

/** Past this many alternatives (ternaries multiply) a fold gives up, and reads as a hole. */
const FOLD_LIMIT = 64;

interface Fold {
  alts: Piece[][]; // every assembly the expression can take, as pieces
  literals: string[]; // every literal it read, wherever that is written
  combiners: ts.Node[]; // every `+` or template it passed through, itself included
}

const isCombiner = (node: ts.Node): boolean =>
  ts.isTemplateExpression(node) || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken);

/**
 * How a string expression is assembled: literals, `+`, templates, either arm
 * of a ternary, through parentheses and assertions and a `const` followed to
 * its binding. What the scan cannot compute is a HOLE rather than the end of
 * the fold, because the endpoint is usually appended to a base URL nobody
 * can read: `base + "/realtime/v1/api/" + "broadcast"` is [HOLE,
 * "/realtime/v1/api/", "broadcast"].
 */
function foldOf(node: ts.Node, checker: ts.TypeChecker, path: Set<ts.Node> = new Set()): Fold {
  const piece = (p: Piece): Fold => ({ alts: [[p]], literals: typeof p === "string" ? [p] : [], combiners: [] });
  const join = (a: Fold, b: Fold): Fold => ({
    alts: a.alts.length * b.alts.length > FOLD_LIMIT ? [[HOLE]] : a.alts.flatMap((x) => b.alts.map((y) => [...x, ...y])),
    literals: [...a.literals, ...b.literals],
    combiners: [...a.combiners, ...b.combiners],
  });
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return piece(node.text);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
    || ts.isNonNullExpression(node)) return foldOf(node.expression, checker, path);
  if (ts.isConditionalExpression(node)) {
    const a = foldOf(node.whenTrue, checker, path);
    const b = foldOf(node.whenFalse, checker, path);
    return {
      alts: a.alts.length + b.alts.length > FOLD_LIMIT ? [[HOLE]] : [...a.alts, ...b.alts],
      literals: [...a.literals, ...b.literals],
      combiners: [...a.combiners, ...b.combiners],
    };
  }
  if (ts.isIdentifier(node)) {
    // The path, not every node visited: a constant used twice is read twice,
    // and only one that leads back to itself (which parses) stops the fold.
    const init = constOf(node, checker);
    return init && !path.has(init) ? foldOf(init, checker, new Set([...path, init])) : piece(HOLE);
  }
  let folded: Fold | undefined;
  if (ts.isTemplateExpression(node)) {
    folded = piece(node.head.text);
    for (const span of node.templateSpans) {
      folded = join(join(folded, foldOf(span.expression, checker, path)), piece(span.literal.text));
    }
  } else if (isCombiner(node)) {
    const bin = node as ts.BinaryExpression;
    folded = join(foldOf(bin.left, checker, path), foldOf(bin.right, checker, path));
  }
  return folded ? { ...folded, combiners: [...folded.combiners, node] } : piece(HOLE);
}

/** Some assembly names the endpoint: the text between holes is read as it runs. */
function namesEndpoint(fold: Fold): boolean {
  return fold.alts.some((alt) => {
    let run = "";
    for (const p of [...alt, HOLE]) {
      if (typeof p === "string") run += p;
      else if (run.includes(BROADCAST_ENDPOINT)) return true;
      else run = "";
    }
    return false;
  });
}

/**
 * Where a file names the broadcast endpoint (comments are not strings): a
 * literal that carries it, and a concatenation that assembles it — reported
 * once, at the innermost `+` or template that forms it, never again at a
 * literal that already carries it or at a concatenation built on one that
 * formed it.
 */
function endpointMentions(file: string, text: string): number[] {
  const { sf, checker } = checked(file, text);
  const lines: number[] = [];
  const at = (node: ts.Node) => lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
  const literals = (node: ts.Node) => {
    const isString = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
    if (isString && (node as ts.LiteralLikeNode).text.includes(BROADCAST_ENDPOINT)) at(node);
    ts.forEachChild(node, literals);
  };
  literals(sf);
  const folds = new Map<ts.Node, Fold>();
  const fold = (n: ts.Node): Fold => {
    if (!folds.has(n)) folds.set(n, foldOf(n, checker));
    return folds.get(n)!;
  };
  const forms = (n: ts.Node): boolean =>
    namesEndpoint(fold(n)) && !fold(n).literals.some((l) => l.includes(BROADCAST_ENDPOINT));
  const combiners = (node: ts.Node) => {
    if (isCombiner(node) && forms(node) && !fold(node).combiners.some((c) => c !== node && forms(c))) at(node);
    ts.forEachChild(node, combiners);
  };
  combiners(sf);
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
      // Say what was seen: a site is not always a call (a destructuring, a
      // member the scan cannot read), and a red that misdescribes itself
      // sends the reader after the wrong thing.
      const seen = s.problem ? ` (${s.problem})` : "";
      problems.push(`${s.file}:${s.line} opens a Realtime channel on the server${seen} — publish through ${THE_PUBLISHER}`);
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

  it("counts a member however it is spelled, and refuses a call through one it cannot read (Codex, on #97)", () => {
    // A template literal is a spelling of the name, not an expression: the
    // shipped scan read only a string literal, so this second, public channel
    // left the count at one.
    const second = client({ [THE_CHANNEL_FILE]: `${PRIVATE}\nsupabase[\`channel\`](t);` }).join("\n");
    expect(second).toMatch(/:2 is not private: no options/);
    expect(second).toMatch(/exactly one channel call, found 2/);
    // A call through a member the scan cannot read could be `.channel(`.
    expect(client({ [THE_CHANNEL_FILE]: `${PRIVATE}\nsupabase[method](t);` }).join("\n"))
      .toMatch(/:2 is not private: a call through a member the scan cannot read/);
    // Indexing that is not called is ordinary code, and is not counted.
    expect(client({ [THE_CHANNEL_FILE]: `${PRIVATE}\nconst row = rows[i];\nconst v = row[\`id\`];` })).toEqual([]);
  });

  it("refuses `channel` taken by destructuring, which needs no access expression (Codex, on #97)", () => {
    const one = (code: string) => client({ [THE_CHANNEL_FILE]: `${PRIVATE}\n${code}` }).join("\n");
    // The shape it missed: the second channel is opened with no `.channel`
    // in sight, and the private call still satisfied the count.
    const destructured = one("const { channel } = supabase;\nchannel.call(supabase, t);");
    expect(destructured).toMatch(/:2 is not private: `\.channel` taken by destructuring/);
    expect(destructured).toMatch(/exactly one channel call, found 2/);
    expect(one("const { channel: open } = supabase;")).toMatch(/taken by destructuring/);
    expect(one('const { ["channel"]: open } = supabase;')).toMatch(/taken by destructuring/);
    expect(one("const { realtime: { channel } } = supabase;")).toMatch(/taken by destructuring/);
    expect(one("let channel;\n({ channel } = supabase);")).toMatch(/taken by destructuring/);
    expect(one("export function open({ channel }: typeof supabase) { return channel; }")).toMatch(/taken by destructuring/);
    // An object BUILT with a `channel` field is data — the delivery channel
    // send-notification records — and destructuring anything else is too.
    expect(one("const claim = { notification_id: id, channel };")).toBe("");
    expect(one("const out = { channel: \"email\" };")).toBe("");
    expect(one('const { data, error } = await supabase.from("walks").select("id");')).toBe("");
  });

  it("refuses a member taken under a key it cannot read, which could be `channel` (Codex, on #97)", () => {
    const one = (code: string) => client({ [THE_CHANNEL_FILE]: `${PRIVATE}\n${code}` }).join("\n");
    // The shape it missed: the key is a constant, so no `channel` is written
    // at the site, and the private call still satisfied the count.
    const computed = one('const key = "channel" as const;\nconst { [key]: open } = supabase;\nopen(t);');
    expect(computed).toMatch(/:3 is not private: a member taken by destructuring under a key the scan cannot read/);
    expect(computed).toMatch(/exactly one channel call, found 2/);
    expect(one("let open;\n({ [key]: open } = supabase);")).toMatch(/under a key the scan cannot read/);
    expect(one("function open({ [key]: fn }: typeof supabase) { return fn; }")).toMatch(/under a key the scan cannot read/);
    // A key it CAN read is judged by what it spells, however it is written.
    expect(one("const { [`channel`]: open } = supabase;")).toMatch(/`\.channel` taken by destructuring/);
    expect(one('const { ["from"]: from } = supabase;')).toBe("");
    // A position or a rest names no member, so `channel` there is just a name.
    expect(one("const [channel, other] = pair;")).toBe("");
    expect(one("const { ...channel } = rest;")).toBe("");
  });

  it("reads the definition that wins — the last one — and refuses what could override it", () => {
    const one = (call: string) => client({ [THE_CHANNEL_FILE]: call }).join("\n");
    // A spread after the definition may replace it at run time.
    expect(one("supabase.channel(t, { config: { private: true }, ...extra });")).toMatch(/options spread from elsewhere/);
    expect(one("supabase.channel(t, { config: { private: true, ...flags } });")).toMatch(/a `config` spread from elsewhere/);
    // A later definition of the same key is the one that counts.
    expect(one('supabase.channel(t, { config: { private: true }, ["config"]: { private: false } });'))
      .toMatch(/`private: false`/);
    expect(one("supabase.channel(t, { config: { private: true }, [key]: x });"))
      .toMatch(/options with a key the scan cannot read/);
    expect(one("supabase.channel(t, { get config() { return { private: true }; } });"))
      .toMatch(/`config` defined by an accessor or a method/);
    // And the healthy direction: what comes before the definition is overridden by it,
    // and a key spelled some other way is still the key.
    expect(one("supabase.channel(t, { ...base, [key]: x, config: { private: true } });")).toBe("");
    expect(one('supabase.channel(t, { "config": { ["private"]: true } });')).toBe("");
    expect(one("supabase.channel(t, { [`config`]: { [`private`]: true } });")).toBe("");
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
    expect(server({ ...publisher, "complete-walk/index.ts": "const { [k]: open } = client;" }))
      .toMatch(/on the server \(a member taken by destructuring under a key the scan cannot read/);
    expect(server({ ...publisher, "complete-walk/index.ts": "await fetch(`${u}/realtime/v1/api/broadcast`);" }))
      .toMatch(/calls the broadcast endpoint directly/);
    // Prose is not a call.
    expect(server({ ...publisher, "complete-walk/index.ts": "// posts to /realtime/v1/api/broadcast" })).toBe("");
  });

  it("reads the endpoint however the string is assembled (Codex, on #97)", () => {
    const server = (entries: Record<string, string>) =>
      serverProblems(new Map(Object.entries(entries))).problems.join("\n");
    const publisher = { [THE_PUBLISHER]: "fetch(`${url}/realtime/v1/api/broadcast`);" };
    const direct = /calls the broadcast endpoint directly/;
    // The shape it missed: no single literal names the endpoint.
    expect(server({ ...publisher, "complete-walk/index.ts": `fetch(base + "/realtime/v1/api/" + "broadcast");` }))
      .toMatch(direct);
    // Through a constant, a template and a ternary.
    expect(server({ ...publisher, "complete-walk/index.ts": "const API = \"/realtime/v1/api\";\nfetch(`${url}${API}/broadcast`);" }))
      .toMatch(direct);
    expect(server({ ...publisher, "complete-walk/index.ts": `fetch(url + "/realtime/v1/api/" + (quiet ? "noop" : "broadcast"));` }))
      .toMatch(direct);
    // Reported once, where it is formed — not again by what uses it.
    expect(server({ ...publisher, "complete-walk/index.ts": `const P = "/realtime/v1/api/" + "broadcast";\nfetch(url + P);` })
      .split("\n")).toEqual(["complete-walk/index.ts:1 calls the broadcast endpoint directly — use _lib/broadcast.ts"]);
    // What it cannot compute stays unread, and another endpoint is not this one.
    expect(server({ ...publisher, "complete-walk/index.ts": "fetch(base + path);" })).toBe("");
    // The scan does not guess what a hole holds: text either side of one is
    // read as it runs, and a string split by one is outside it, as the header
    // says. Joining across the hole would call every URL with a hole in it a
    // guess at the endpoint.
    expect(server({ ...publisher, "complete-walk/index.ts": `fetch("/realtime/v1/api" + part + "/broadcast");` })).toBe("");
    expect(server({ ...publisher, "complete-walk/index.ts": `fetch(url + "/rest/v1/" + "walks");` })).toBe("");
    // The publisher still names it when it assembles the string itself.
    expect(serverProblems(new Map([[THE_PUBLISHER, `fetch(url + "/realtime/v1/api/" + "broadcast");`]])).publisherNamesEndpoint)
      .toBe(true);
  });
});
