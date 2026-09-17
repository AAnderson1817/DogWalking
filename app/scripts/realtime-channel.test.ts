import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  calleeCall,
  computedAccess,
  declaredObjects,
  isComputedObjectAccess,
  memberAccess,
  isAssignmentOperator,
  isEscapedObjectAssign,
  isObjectAssignCall,
  memberTarget,
  propertyKey,
  definesWithoutValue,
  holdersOf,
  unwrapTransparent,
} from "./lib/static-object.js";
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
/**
 * The specifier names the client module `lib/supabase` — bare, or with an
 * extension TypeScript resolves to a source file. `allowImportingTsExtensions`
 * is on in `tsconfig.app.json`, so `@/lib/supabase.ts` is a legal spelling
 * of the same module, and bundler resolution reads `./supabase.js` as it.
 * The bare-only matcher recorded no namespace for `import * as sb from
 * "./supabase.ts"`, so a computed `sb.supabase[key]("walk:public")` was
 * missed and a private `sb.supabase.channel(…)` refused as unresolvable
 * (Codex, PR #94, round 67; the named import had the same hole, and both
 * were measured in the real hook). `supabase-admin`, `supabase.config` and
 * `supabase.d.ts` are other modules and stay so.
 */
const SOURCE_EXTENSION = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
function isClientModuleSpecifier(spec: string): boolean {
  const base = spec.slice(spec.lastIndexOf("/") + 1);
  return base.replace(SOURCE_EXTENSION, "") === "supabase";
}

/**
 * The two ways the client module is imported: `supabase` by NAME under some
 * local name, and the whole module as a NAMESPACE — `import * as sb from
 * "./supabase"`, where the client is `sb.supabase`. The second was refused
 * as an unresolvable receiver on the named call and MISSED as a computed
 * member, an alias and a destructuring (measured; the sibling of the
 * `globalThis.Object` finding, Codex, PR #94, round 66): a seed reached as
 * a member of a known base is the seed.
 *
 * An ALIAS of the namespace is the namespace: `const mod = sb;
 * mod.supabase[key]("walk:public")` opened a public topic past the name-only
 * set (Codex, PR #94, round 67 — measured green in the real hook), so the set
 * is closed under the shared `holdersOf`, the reader the client's own aliases
 * already go through. Name-based and file-wide, the reporting direction,
 * stated at `holdersOf`.
 */
function clientModuleImports(sf: ts.SourceFile): { names: Set<string>; namespaces: Set<string> } {
  const names = new Set<string>();
  const namespaces = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteralLike(st.moduleSpecifier)) continue;
    if (!isClientModuleSpecifier(st.moduleSpecifier.text)) continue;
    const bindings = st.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    else for (const el of bindings.elements) {
      if ((el.propertyName ?? el.name).text === "supabase") names.add(el.name.text);
    }
  }
  return { names, namespaces: holdersOf(sf, namespaces) };
}

/** `(receiver, key)` is the client read off a namespace import of its module: `sb.supabase`, `sb["supabase"]`, `const { supabase: db } = sb`. */
function isClientMember(namespaces: ReadonlySet<string>, receiver: ts.Expression, key: string): boolean {
  const base = unwrapTransparent(receiver);
  return key === "supabase" && ts.isIdentifier(base) && namespaces.has(base.text);
}

function clientNames(sf: ts.SourceFile): Set<string> {
  const { names, namespaces } = clientModuleImports(sf);

  // Every name that can come to HOLD the client, through every binding form
  // — a declaration, an assignment in any alias-forming spelling, a parameter
  // or binding-element default, a literal aggregate taken apart — followed by
  // the SHARED `holdersOf`, transitively and through the transparent wrappers.
  // This function used to carry its own fixpoint over declarations alone, a
  // partial copy of the shared module's binding-form list, so `let db: typeof
  // supabase; db = supabase; db[key]("walk:public")` opened a public topic
  // past it — and so did the escaped, destructured, logical-assignment,
  // parameter-default and binding-default spellings, all measured green on
  // the shipped gate (Codex, PR #94, round 64). Name-based and file-wide, so a
  // name rebound away from the client afterwards still counts, which is the
  // reporting direction; a part taken from a non-literal source (`const
  // { data } = await supabase.from(…)`) is NOT the client, and that is what
  // keeps this from turning every query result into a red.
  return holdersOf(sf, names, (receiver, key) => isClientMember(namespaces, receiver, key));
}

/**
 * Classify every `.channel(…)` call in ONE source.
 *
 * Split out from `channelCalls` so the classification can be driven by
 * fixtures at all: it read the real tree only, where there is exactly one
 * call, so every rule about receivers and options was proven by sabotage and
 * by nothing in the committed suite (Codex, PR #94).
 */
function channelCallsIn(source: ts.SourceFile, rel: string): ChannelCall[] {
  const found: ChannelCall[] = [];
  {
    const clients = clientNames(source);
    const { namespaces } = clientModuleImports(source);
    const declared = declaredObjects(source);
    // The client as an EXPRESSION: a name that holds it, or the `supabase`
    // export read off a namespace import of its module. One predicate for the
    // receiver of a named call, the chain a computed member is reached
    // through, and the source of a destructuring, so the three cannot
    // disagree about what the client is.
    const isClient = (e: ts.Expression): boolean => {
      const v = unwrapTransparent(e);
      if (ts.isIdentifier(v)) return clients.has(v.text);
      const m = memberAccess(v);
      return !!m && isClientMember(namespaces, m.receiver, m.name);
    };
    // A chain that passes THROUGH the client at any hop: `supabase.realtime[key]`,
    // `sb.supabase[key]`, `(db as never)[key]`.
    const reachedFromClient = (e: ts.Expression): boolean => {
      let cur = unwrapTransparent(e);
      for (;;) {
        if (isClient(cur)) return true;
        const hop = memberAccess(cur) ?? computedAccess(cur);
        if (!hop) return false;
        cur = unwrapTransparent(hop.receiver);
      }
    };
    const visit = (node: ts.Node): void => {
      // Every reference to `channel` is looked at, and its receiver is then
      // CLASSIFIED — a receiver this file cannot resolve to the client is
      // reported rather than skipped, because "cannot say" is not "not a
      // channel". Measured on the healthy tree: one `.channel` in app/src, on
      // the client, and it is a direct call, so neither refusal below is a red
      // on healthy code. The day something unrelated grows a `.channel`
      // method, somebody decides here rather than the gate quietly stopping
      // looking.
      //
      // A REFERENCE to the method, in any position — the call is then found by
      // walking UP. Keying on the call instead matched the method in exactly
      // one position while every other position still opens a channel:
      // `supabase.channel.call(supabase, "walk:public")` left all 11 tests
      // green (Codex, PR #94), and so did `.bind`, `Reflect.apply`, `.apply`,
      // `const ch = supabase.channel; ch(t)` and a bare `register(
      // supabase.channel)` — five spellings the finding did not name, which is
      // why the fix is the POSITION and not a list of them.
      //
      // `x.channel` and `x["channel"]` are the same member, read by the SHARED
      // helper rather than by a fourth inline spelling of the question — three
      // readers in this family each spelled it differently and each had a
      // different hole (Codex, PR #94).
      const member = memberAccess(node);
      const access = member && member.name === "channel" ? node : null;
      if (access && member) {
        // The receiver goes through the same transparent unwrapping the
        // alias resolver uses. `(supabase).channel(…)` is behaviour-preserving
        // and left the receiver a `ParenthesizedExpression`, so an
        // identifier-only test reported a correctly private call as
        // unresolvable — a gate RED ON A HEALTHY TREE, this log's worst shape
        // (Codex, PR #94). Measured on the real call before the fix.
        const receiver = unwrapTransparent(member.receiver);
        const onClient = isClient(receiver);
        const accessLine = source.getLineAndCharacterOfPosition(access.getStart()).line + 1;
        const call = calleeCall(access);
        if (!onClient) {
          // A bare READ of somebody else's `.channel` opens nothing, and
          // reporting every one of them would turn this gate red the first
          // time an unrelated object grows a property of that name — the
          // worse failure shape. So the refusal stays where HEAD had it, on
          // a CALL, which is the shape that can open a topic.
          //
          // Stated residual, on the precedent `isObjectAssignCall` sets three
          // paragraphs over: a reference that is BOTH on a receiver this file
          // cannot resolve AND escaped is not reported. That needs an alias
          // the resolver missed and an escape in one file, where each refusal
          // above needs only one of the two.
          if (!call) {
            ts.forEachChild(node, visit);
            return;
          }
          found.push({
            file: rel,
            line: accessLine,
            private: false,
            why: `\`${receiver.getText()}.channel(…)\` — this check cannot resolve that receiver to the `
              + `Supabase client, so it cannot say the topic is private. Classify it here.`,
          });
          ts.forEachChild(node, visit);
          return;
        }
        // The client's `channel` handed somewhere rather than invoked here.
        // Whatever receives it can open a topic with whatever options it
        // likes, and none of that is readable from this reference — so it is
        // REPORTED, the same answer an unresolvable receiver gets, rather
        // than passed over because the shape is unfamiliar.
        if (!call) {
          found.push({
            file: rel,
            line: accessLine,
            private: false,
            why: "the client's `channel` method is referenced without being called here, so whatever "
              + "receives it can open a topic this check cannot read — call it directly, or classify it here.",
          });
          ts.forEachChild(node, visit);
          return;
        }
        const opts = call.arguments[1];
        let isPrivate = false;
        let why = "no options argument";
        if (!opts) {
          // `supabase.channel(topic)` is the exact H1 defect: `private`
          // defaults to false, so an omitted option is a PUBLIC topic.
          why = "called with no options — `private` defaults to false (H1)";
        } else if (!ts.isObjectLiteralExpression(unwrapTransparent(opts))) {
          why = "options are not an object literal, so this check cannot read them";
        } else {
          // Through the SAME reader the server side uses, spreads and all.
          // The first version read this side with a direct-property helper
          // while the message side resolved spreads, so
          // `config: { private: true, ...{ private: false } }` reported
          // private on a client that joins a PUBLIC topic — one rule, two
          // scopes, which is the disagreement this repository keeps paying
          // for. There is one reader now, so there is no sibling to forget.
          const config = effectiveProps(
            unwrapTransparent(opts) as ts.ObjectLiteralExpression,
            declared,
          ).props.get("config");
          const configLit = typeof config === "object" ? unwrapTransparent(config) : undefined;
          if (config === undefined) why = "options carry no `config`";
          else if (typeof config === "string") why = `\`config\` is ${config}`;
          else if (!configLit || !ts.isObjectLiteralExpression(configLit))
            why = "`config` is not an object literal, so this check cannot read it";
          else {
            const priv = effectiveProps(configLit, declared).props.get("private");
            if (priv === undefined) why = "`config` carries no `private`";
            else if (isLiteralTrue(priv)) {
              isPrivate = true;
              why = "config.private is true";
            } else why = `config.private is \`${shownAs(priv)}\`, not the literal true`;
          }
        }
        found.push({ file: rel, line: accessLine, private: isPrivate, why });
      }
      // A COMPUTED member reached from the client: `supabase[key](…)`,
      // `supabase[pick()](…)`, `supabase.realtime[key](…)`. `memberAccess`
      // answers null for one and this visitor read that null as "not
      // `channel`" — so `const key: "channel" = "channel";
      // supabase[key]("walk:public")`, which type-checks and opens a second
      // PUBLIC topic, left all 11 tests green planted in the real hook
      // (Codex, PR #94), and so did eight more spellings measured beside it.
      // This check cannot say the member is not `channel`, so it cannot say
      // the topic is private: REPORTED, in every position, on a receiver
      // whose chain passes THROUGH the client — the client itself, an alias,
      // a wrapper, a namespace reached from it, or the client read off a
      // namespace import of its module — and left alone on any other
      // receiver, where a computed member is ordinary code
      // (`handlers[type](payload)`) and reporting it would be red on a
      // healthy tree. Measured: no computed access on the client in app/src.
      // A computed member of the namespace ITSELF is reported too: the client
      // module exports the client and nothing else, so `sb[k]` is a read this
      // check cannot say is not `supabase`.
      const computed = computedAccess(node);
      if (computed) {
        const recv = unwrapTransparent(computed.receiver);
        if (reachedFromClient(recv) || (ts.isIdentifier(recv) && namespaces.has(recv.text))) {
          found.push({
            file: rel,
            line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            private: false,
            why: `\`${node.getText(source)}\` — a computed member reached from the Supabase client or its module; `
              + "this check cannot say whether it is `channel`, so it cannot say the topic is "
              + "private. Name the member, or classify it here.",
          });
        }
      }
      // The client DESTRUCTURED. `const { channel } = supabase; channel(t)`
      // opens a topic with no receiver left for the rule above to resolve, and
      // it too left all 11 tests green on the shipped gate (measured; one of
      // the spellings the finding did not name). It is the same escape one
      // syntactic shape over, so it gets the same answer: reported.
      if (ts.isVariableDeclaration(node) && node.initializer
        && ts.isObjectBindingPattern(node.name)) {
        reportDestructure(node.name.elements, node.initializer,
          source.getLineAndCharacterOfPosition(node.getStart()).line + 1);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isObjectLiteralExpression(node.left)) {
        reportDestructure(node.left.properties, node.right,
          source.getLineAndCharacterOfPosition(node.getStart()).line + 1);
      }
      ts.forEachChild(node, visit);
    };

    // One rule for both spellings of taking `channel` off the client: the
    // declaration form and the assignment form. A REST element carries the
    // method with everything else, so it counts too.
    function reportDestructure(
      elements: ts.NodeArray<ts.BindingElement | ts.ObjectLiteralElementLike>,
      init: ts.Expression,
      line: number,
    ): void {
      const src = unwrapTransparent(init);
      if (!isClient(src)) return;
      for (const el of elements) {
        let takes = false;
        if (ts.isBindingElement(el)) {
          if (el.dotDotDotToken) takes = true;
          else if (el.propertyName) takes = propertyKey(el.propertyName) === "channel";
          else takes = ts.isIdentifier(el.name) && el.name.text === "channel";
        } else if (ts.isSpreadAssignment(el)) takes = true;
        else if (ts.isShorthandPropertyAssignment(el)) takes = el.name.text === "channel";
        else if (ts.isPropertyAssignment(el)) takes = propertyKey(el.name) === "channel";
        if (!takes) continue;
        found.push({
          file: rel,
          line,
          private: false,
          why: "the client's `channel` method is taken off it by a destructuring, so the call that "
            + "follows has no receiver this check can resolve — call `<client>.channel(…)` directly, "
            + "or classify it here.",
        });
        return;
      }
    }

    visit(source);
  }
  return found;
}

function channelCalls(files: string[]): ChannelCall[] {
  const found: ChannelCall[] = [];
  for (const file of files) {
    found.push(...channelCallsIn(parse(file), relative(APP_SRC, file).split("\\").join("/")));
  }
  return found;
}

/**
 * The property mutations in a file — `x.y = …`, `x["y"] = …`, `Object.assign`.
 *
 * A reader of object LITERALS is sound only while the literal it read is what
 * gets sent. `const message = { …, private: true }; message.private = false;
 * messages: [message]` passed 7 of 7 (Codex, PR #94): the scan saw a stale
 * `true` on a line that had been overwritten by the time the POST was built.
 *
 * Modelling mutation is a dataflow analysis; refusing it is a precondition,
 * which is what the enum-catalogue generator settled on for the same class of
 * question. `broadcast.ts` contains no mutation today (measured), so the
 * precondition costs nothing and the day somebody writes one the gate says so
 * rather than reading a value that no longer exists.
 */
function mutations(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node): void => {
    // The TARGET goes through the shared reader, because `(m.private) = false`
    // assigns exactly as the bare spelling does and this branch tested the raw
    // node — so the write went unreported, and this list is the PRECONDITION
    // that makes reading `broadcast.ts`'s literals sound (Codex, PR #94, the
    // callee finding's sibling one position over).
    if (ts.isBinaryExpression(n) && memberTarget(n.left)) {
      if (isAssignmentOperator(n.operatorToken.kind)) {
        out.push(`${n.getText().split("\n")[0]} (line ${at(n)})`);
      }
    }
    // The BUILT-IN `Object.assign` only. Matching any `.assign(…)` made this
    // reject an unrelated `metrics.assign({ topic })` — red on healthy code,
    // and the same defect as the sibling rule in `static-object.ts`, so they
    // share one predicate rather than each carrying a copy of the receiver
    // test (Codex, PR #94).
    if (isObjectAssignCall(n)) {
      out.push(`${n.getText().split("\n")[0]} (line ${at(n)})`);
    }
    // …and a reference to it that is NOT invoked here. `Object.assign.call(
    // null, message, { private: false })` mutates exactly as the direct call
    // does and named no target the reader above could collect, so this file
    // reported no mutation and read a stale literal — the SIBLING of the
    // channel finding, in this file's own predicate (Codex, PR #94; `.apply`,
    // `.bind` and `Reflect.apply` measured the same way).
    if (isEscapedObjectAssign(n)) {
      out.push(`${n.getText().split("\n")[0]} — referenced without being called (line ${at(n)})`);
    }
    // …and a COMPUTED member of it, in any position: `Object[k](m, {…})` may
    // be `assign` (or any other mutator) and `const f = Object[k]` hands one
    // away. Neither was reported — round 55 pinned a computed key as "not a
    // name", which is right, and read it as "not a member", which is not —
    // so a literal survived a mutation the language performed and this file
    // read it stale (Codex, PR #94, round 63; measured with `Object[key](stale,
    // { private: false })` planted in broadcast.ts: 11 of 11 green).
    if (isComputedObjectAccess(n)) {
      out.push(`${n.getText().split("\n")[0]} — a computed member of Object, which this check cannot tell from \`assign\` (line ${at(n)})`);
    }
    if (ts.isDeleteExpression(n)) out.push(`${n.getText()} (line ${at(n)})`);
    // `c.private--` writes to a property exactly as `c.private = 0` does, and
    // the assignment branch above cannot see it because it is a unary
    // expression. The SIBLING rule in `static-object.ts` had the same hole and
    // is fixed in the same commit (Codex, PR #94).
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n))
      && (n.operator === ts.SyntaxKind.PlusPlusToken
        || n.operator === ts.SyntaxKind.MinusMinusToken)
      && memberTarget(n.operand)) {
      out.push(`${n.getText().split("\n")[0]} (line ${at(n)})`);
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
interface EffectiveProps {
  /** Key to the value SENT, or to a marker naming what could not be read. */
  props: Map<string, ts.Expression | string>;
  /**
   * The keys some member of this object explicitly NAMES.
   *
   * A blanket mark is not one of them, and that distinction is the whole
   * point of this set. `markAll` means "an unreadable member could define any
   * of these", which is the right answer for an object already known to be
   * the one being read — and NOT evidence that it is that object. The two
   * whole-file scans below asked `props.has("topic")` and
   * `sent !== undefined`, so any unrelated literal carrying an unfollowable
   * spread or an unreadable computed key — `const opts = { ...imported }` in
   * `broadcast.ts` — answered yes to both and their markers failed the
   * assertion on healthy code (Codex, PR #94; measured, one marker before
   * round 44 and two after, so the literal scan had it first).
   *
   * A followable spread contributes its own names, because `{ ...message }`
   * genuinely carries what `message` names — that rule is what lets the
   * public literal in `messages: [{ ...message, private: false }]` be found
   * at all.
   */
  names: Set<string>;
}

function effectiveProps(
  obj: ts.ObjectLiteralExpression,
  declared: Map<string, ts.ObjectLiteralExpression>,
  path: ReadonlySet<ts.ObjectLiteralExpression> = new Set(),
): EffectiveProps {
  // The names this file asks about, at any depth: an unreadable spread has to
  // invalidate each of them, since it could carry any of them.
  //
  // `messages` is in the list because `messageElements` asks THIS reader for
  // it. It used to walk the properties itself and therefore disagreed with
  // this one about every rule below — a computed key it could not read, an
  // accessor, a spread it could not follow — so a request object could define
  // `messages` twice and the naive reader kept the safe one (Codex, PR #94).
  // One reader, so there is no sibling to forget.
  const ASKED = ["topic", "private", "config", "messages"];
  const props = new Map<string, ts.Expression | string>();
  const names = new Set<string>();
  const markAll = (mark: string) => { for (const k of ASKED) props.set(k, mark); };
  // The literals this walk is already inside — the shared reader's cycle
  // guard, and its termination argument, in the walk this file keeps. A
  // spread that re-enters one (`var m: any = { topic, ...m }` is legal and
  // runs) is followed nowhere and marks what any unfollowable spread marks;
  // the `depth < 8` this replaces refused a spread nested nine deep instead
  // (Codex, PR #94, the `outward` finding's class).
  const inside = new Set(path).add(obj);

  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) {
      // A spread of a literal written in place, or of one declared by name —
      // UNWRAPPED first, because `...({ private: true } as const)` is the same
      // object and reading the wrapper made this gate red on healthy code
      // (Codex, PR #94). The form-error reader had unwrapped here since the
      // round before; the primitives live in one module now so the two cannot
      // disagree about it again.
      const spread = unwrapTransparent(p.expression);
      const inline = ts.isObjectLiteralExpression(spread) ? spread : undefined;
      const byName = ts.isIdentifier(spread) ? declared.get(spread.text) : undefined;
      const from = inline ?? byName;
      if (from && !inside.has(from)) {
        const inner = effectiveProps(from, declared, inside);
        for (const [k, v] of inner.props) props.set(k, v);
        for (const k of inner.names) names.add(k);
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
      // A computed key whose expression is a string literal names exactly one
      // property: `{ ["private"]: true }` is `{ private: true }`. Only a key
      // the reader genuinely cannot resolve marks everything unreadable, since
      // it could be any of the names this file asks about.
      const name = p.name;
      let key: string | null = null;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)
        || ts.isNoSubstitutionTemplateLiteral(name)) key = name.text;
      else if (ts.isComputedPropertyName(name)
        && (ts.isStringLiteral(name.expression) || ts.isNoSubstitutionTemplateLiteral(name.expression))) {
        key = name.expression.text;
      }
      if (key !== null) { props.set(key, p.initializer); names.add(key); }
      else markAll("<computed key, unreadable>");
      continue;
    }
    if (ts.isShorthandPropertyAssignment(p)) {
      // A shorthand carries a REFERENCE this check cannot resolve. Fine for
      // `topic`, where presence is the question; not fine for `private`, which
      // is why the value is recorded as unreadable rather than as true.
      props.set(p.name.text, "<shorthand, unreadable>");
      names.add(p.name.text);
      continue;
    }
    if (definesWithoutValue(p)) {
      // `get private() { … }` DEFINES the property, overriding an earlier
      // spread, and what it answers is a function body. Falling through every
      // branch left the spread's value standing for a key the object no longer
      // carries — a confidently wrong answer (Codex, PR #94).
      const key = propertyKey(p.name);
      if (key !== null) { props.set(key, "<accessor or method, unreadable>"); names.add(key); }
      else markAll("<computed accessor, unreadable>");
    }
  }
  return { props, names };
}

/**
 * What a `private` value should be REPORTED as: the literal `true` for
 * anything that unwraps to it, and its own source text otherwise.
 *
 * The assertions filter for the string `"true"`, so this is where the
 * transparent wrappers have to be unwrapped on the message side — the same
 * rule `isLiteralTrue` applies to the client's `config`, said once so the two
 * halves of this file cannot disagree about what "private" means.
 */
function privateValue(v: ts.Expression | string | undefined): string {
  return isLiteralTrue(v) ? "true" : shownAs(v);
}

/** The text a reader should print for a resolved property. */
function shownAs(v: ts.Expression | string | undefined): string {
  if (v === undefined) return "<absent>";
  return typeof v === "string" ? v : v.getText();
}

/** Whether a resolved property is the literal `true` and not a marker. */
function isLiteralTrue(v: ts.Expression | string | undefined): boolean {
  return typeof v === "object" && unwrapTransparent(v).kind === ts.SyntaxKind.TrueKeyword;
}

/**
 * `private` in EVERY message literal in the broadcast body, not the last one.
 *
 * The first version kept a single result and each match overwrote it, so a
 * `broadcast.ts` that published a public message and then a private one read
 * as private — measured, green while the server published to the public topic.
 * Every match is collected now and every one has to be the literal `true`.
 */
/**
 * Every element of the `messages:` array, as something this file can read —
 * or a marker naming what it could not.
 *
 * The literal scan below is a BACKSTOP and not the rule: it answers "is any
 * `{ topic, … }` literal in this file public?", which says nothing about an
 * element that is not a literal at all. `messages: [{ …, private: true },
 * publicMessage(topic, event, payload)]` passed 8 of 8 while the second
 * message went to a public topic (Codex, PR #94) — the scan found the one
 * literal, it was `true`, and the call was simply not looked at.
 *
 * So the array is read directly and every element must resolve: an object
 * literal written in place, or an identifier naming a module-scope one. A call,
 * a conditional, a spread of an array — anything else is REFUSED by name. That
 * is not a dataflow analysis; it is reading the expression that is actually
 * sent, which is what the rest of this file already does one level in.
 *
 * WHICH `messages` gets sent is `effectiveProps`' question, not this one's.
 * This half used to walk the properties itself, so the two readers disagreed
 * about every rule that one already had — later-wins, spreads, accessors,
 * computed keys — and a request object could define `messages` twice while
 * this one kept the safe array. Asking the shared reader deletes the sibling
 * rather than teaching it the same rules a second time.
 */
function messageElements(sf: ts.SourceFile): { found: boolean; values: string[] } {
  const declared = declaredObjects(sf);
  const values: string[] = [];
  let found = false;
  const visit = (n: ts.Node): void => {
    // `effectiveProps`, not a property walk of this function's own: which
    // property is SENT is the question `effectiveProps` already answers for
    // `private`, and this half asked it differently and got a different
    // answer. Measured on the shipped reader, all four the same class:
    //
    //   { messages: [private], [key]: [publicMessage()] }      -> ["true"]
    //   { messages: [private], get messages() { … } }          -> ["true"]
    //   { messages: [private], messages() { … } }              -> ["true"]
    //   { messages: [private], ...imported }                   -> ["true"]
    //
    // Each of those is a LATER definition of the same key — the language sends
    // it and this reader kept the safe array — so the gate blessed exactly what
    // it forbids. `effectiveProps` resolves later-wins, follows a spread it can
    // and marks the key unreadable when it cannot, and reads a computed key
    // that is a string literal while refusing one it cannot resolve. A marker
    // is pushed as the value, so the caller's filter fails it by name.
    if (ts.isObjectLiteralExpression(n)) {
      // NAMES, not `props.has`: a blanket mark says an unreadable member could
      // define `messages`, which is the right answer for the request object
      // and is not evidence that this IS it. Asking `props` made every
      // unrelated literal carrying an unfollowable spread a request object and
      // pushed its marker into the assertion — red on healthy code (Codex, PR
      // #94). An object that genuinely names `messages` and then cannot be
      // read is still refused, below.
      const { props, names } = effectiveProps(n, declared);
      const sent = names.has("messages") ? props.get("messages") : undefined;
      if (sent === undefined) {
        // Not a request object as far as this reader can tell.
      } else if (typeof sent === "string") {
        // The marker names what could not be read — a computed key, an
        // accessor, a shorthand reference, a spread that could not be
        // followed. Pushed as the value so the caller fails it by name.
        found = true;
        values.push(sent);
      } else {
        found = true;
        // UNWRAPPED, because `messages: ([{ topic, private: true }] as const)`
        // is the same array: `as`, `satisfies`, parentheses and `!` all left
        // this reporting "not an array literal" and failing the gate on healthy
        // code (Codex, PR #94) — the worse direction. The element loop below
        // has unwrapped since the round that taught this file the rule; this
        // was the one position that had not.
        const arr = unwrapTransparent(sent);
        if (!ts.isArrayLiteralExpression(arr)) {
          values.push(`<\`messages\` is not an array literal: ${arr.getText().split("\n")[0]}>`);
        } else {
          for (const el of arr.elements) {
            const e = unwrapTransparent(el);
            const lit = ts.isObjectLiteralExpression(e)
              ? e
              : ts.isIdentifier(e)
                ? declared.get(e.text)
                : undefined;
            if (!lit) {
              values.push(`<unreadable message element: ${el.getText().split("\n")[0]}>`);
              continue;
            }
            values.push(privateValue(effectiveProps(lit, declared).props.get("private")));
          }
          if (arr.elements.length === 0) values.push("<`messages` is empty>");
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { found, values };
}

/**
 * `private`, for every message literal in the file — the BACKSTOP reading.
 *
 * `topic` alone is what makes this a message object — NOT `topic` AND
 * `private`. Requiring both excluded exactly the literal that matters:
 * `messages: [{ topic, event, payload }, { topic, event, payload, private:
 * true }]` shipped a PUBLIC message and the sibling satisfied the assertion,
 * measured green. That is review H1's whole point — `private` DEFAULTS to
 * false, so omitting it is not a smaller mistake than writing `false`, it is
 * the same one — so an omitted `private` is recorded as `<absent>` and fails
 * like any other non-`true` value.
 *
 * Read through SPREADS, in source order, because a literal's direct properties
 * are not what it carries: `{ ...message, private: false }` has no direct
 * `topic` and was skipped entirely while its base supplied a `true` from a
 * line that is not what gets sent.
 *
 * Extracted so `serverPrivate` and the fixtures below run the SAME reader:
 * they were two copies of this loop, which is the divergence this file keeps
 * paying for — and the round that found the `names` defect found it in the
 * copy, where no fixture could have.
 */
function messageLiterals(sf: ts.SourceFile): string[] {
  const declared = declaredObjects(sf);
  const values: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const { props, names } = effectiveProps(node, declared);
      // NAMES, not `props.has`: see `EffectiveProps.names`. This half had the
      // defect first — an unrelated `const opts = { ...imported }` anywhere in
      // the file answered yes here and pushed its marker into the assertion.
      if (names.has("topic")) values.push(privateValue(props.get("private")));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return values;
}

function serverPrivate(): { found: boolean; values: string[]; mutations: string[] } {
  const source = parse(BROADCAST);
  const values = messageLiterals(source);
  // Both readings, unioned. The array is the RULE — it is what gets posted —
  // and the literal scan is the backstop that still catches a public message
  // built somewhere this array reader does not look.
  const sent = messageElements(source);
  return {
    found: values.length > 0 && sent.found,
    values: [...values, ...sent.values],
    mutations: mutations(source),
  };
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
    // An explicit extension names the same module, and an alias of the
    // module's namespace is the namespace (Codex, PR #94, round 67).
    expect(names('import { supabase } from "@/lib/supabase.ts";')).toEqual(["supabase"]);
    expect(names('import { supabase as db } from "./supabase.js";')).toEqual(["db"]);
    expect(names('import * as sb from "./supabase";\nconst mod = sb;\nconst db = mod.supabase;')).toEqual(["db"]);
    expect(names('import { supabase } from "./supabase-admin";')).toEqual([]);
    expect(names('import { supabase } from "./supabase.config";')).toEqual([]);
  });

  // The CLASSIFICATION, pinned on fixtures rather than only on the one real
  // call. Both directions again: a classifier that called everything private
  // would pass the sabotages for the wrong reason, and one that called
  // everything unresolvable would be red on a healthy tree — which is exactly
  // what the identifier-only receiver test was.
  it("reports a computed member reached from the client, in every position (Codex, PR #94)", () => {
    const IMP = 'import { supabase } from "./supabase";\n';
    const OPTS = "{ config: { private: true } }";
    const verdicts = (body: string): string[] => {
      const sf = ts.createSourceFile("f.ts", IMP + body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      return channelCallsIn(sf, "f.ts").map((c) => (c.private ? "private" : c.why));
    };
    const computedMember = /a computed member reached from the Supabase client/;
    // Codex's case: the key is a string-literal TYPE, so this type-checks and
    // opens a second public topic; planted in the real hook it left all 11
    // tests green. Then every other spelling of a key this check cannot read.
    for (const body of [
      'const key: "channel" = "channel"; supabase[key]("walk:public");',
      'const k = "channel"; supabase[k]("walk:public");',
      'supabase[chooseMethod()]("walk:public");',
      'const x = "nel"; supabase[`chan${x}`]("walk:public");',
      'supabase["chan" + "nel"]("walk:public");',
      // …handed away rather than invoked here.
      'const key: "channel" = "channel"; const opener = supabase[key]; opener("walk:public");',
      // …through a transparent wrapper, and through an alias of the client.
      'const key: "channel" = "channel"; (supabase as never)[key]("walk:public");',
      'const key: "channel" = "channel"; const db = supabase; db[key]("walk:public");',
      // …and reached through a namespace: `supabase.realtime.channel` opens a
      // topic exactly as `supabase.channel` does, so a computed member of it
      // is the same question one hop in.
      'const key: "channel" = "channel"; supabase.realtime[key]("walk:public");',
    ]) {
      const got = verdicts(body);
      expect(got, body).toHaveLength(1);
      expect(got[0], body).toMatch(computedMember);
    }
    // The other direction: a computed member of something that is NOT the
    // client is ordinary code (`handlers[type](payload)`), and reporting it
    // would be a gate red on a healthy tree. And a LITERAL key is not
    // computed — `supabase["channel"]` is `supabase.channel`, classified as
    // it always was, in both directions.
    expect(verdicts('handlers[type]("walk:public");')).toEqual([]);
    expect(verdicts('const key: "channel" = "channel"; other[key]("walk:public");')).toEqual([]);
    expect(verdicts(`supabase["channel"](t, ${OPTS});`)).toEqual(["private"]);
    expect(verdicts('supabase["channel"](t);')).toEqual([
      "called with no options — `private` defaults to false (H1)",
    ]);
  });

  it("follows every form of alias to the client, and only those (Codex, PR #94)", () => {
    const IMP = 'import { supabase } from "./supabase";\n';
    const OPTS = "{ config: { private: true } }";
    const verdicts = (body: string): string[] => {
      const sf = ts.createSourceFile("f.ts", IMP + body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      return channelCallsIn(sf, "f.ts").map((c) => (c.private ? "private" : c.why));
    };
    const computedMember = /a computed member reached from the Supabase client/;
    const KEY = 'const key: "channel" = "channel"; ';
    // Codex's case — an alias formed by ASSIGNMENT rather than by a
    // declaration — then every other form a name can come to hold the client
    // by. Each was green on the shipped gate with the computed call planted in
    // the real hook.
    for (const body of [
      `let db: typeof supabase; db = supabase; ${KEY}db[key]("walk:public");`,
      `let db: typeof supabase | undefined; db ??= supabase; ${KEY}db![key]("walk:public");`,
      `let db: typeof supabase | undefined; db ||= supabase; ${KEY}db![key]("walk:public");`,
      `let db: typeof supabase | undefined = supabase; db &&= supabase; ${KEY}db![key]("walk:public");`,
      `let db: typeof supabase; (db) = supabase as never; ${KEY}db[key]("walk:public");`,
      `const open = (db: typeof supabase = supabase) => { ${KEY}db[key]("walk:public"); }; open();`,
      `const { db = supabase } = {} as { db?: typeof supabase }; ${KEY}db[key]("walk:public");`,
      // …an alias of an assignment alias, and an assignment from an alias.
      `let db: typeof supabase; db = supabase; const db2 = db; ${KEY}db2[key]("walk:public");`,
      `const db = supabase; let db2: typeof supabase; db2 = db; ${KEY}db2[key]("walk:public");`,
      // …and the client taken by POSITION out of a literal aggregate.
      `const [db] = [supabase]; ${KEY}db[key]("walk:public");`,
      `const { db } = { db: supabase }; ${KEY}db[key]("walk:public");`,
      `let db: typeof supabase; [db] = [supabase]; ${KEY}db[key]("walk:public");`,
      `let db: typeof supabase; ({ db } = { db: supabase }); ${KEY}db[key]("walk:public");`,
      `for (const db of [supabase]) { ${KEY}db[key]("walk:public"); }`,
      // …including through an inline literal SPREAD, which supplies the
      // part exactly as the literal around it does — and the last definition
      // of a key wins, as the language has it (Codex, PR #94, round 65).
      `const { db } = { ...{ db: supabase } }; ${KEY}db[key]("walk:public");`,
      `const { db } = { ...{ ...{ db: supabase } } }; ${KEY}db[key]("walk:public");`,
      `const { db } = { db: other, ...{ db: supabase } }; ${KEY}db[key]("walk:public");`,
      `const [db] = [...[supabase]]; ${KEY}db[key]("walk:public");`,
      `for (const db of [...[supabase]]) { ${KEY}db[key]("walk:public"); }`,
      // …and where a spread this reader CANNOT expand sits beside the part:
      // a position before it and a key after it are still known, and an
      // iteration binds every readable element whatever the spread holds —
      // `for (const db of [...others, supabase])` was a MISS on the first
      // round-65 reader, which applied the positional rule to a loop (a
      // shape the reader before it got right; measured, both directions).
      `const [db] = [supabase, ...others]; ${KEY}db[key]("walk:public");`,
      `const { db } = { ...others, db: supabase }; ${KEY}db[key]("walk:public");`,
      `const { db } = { [k]: other, db: supabase }; ${KEY}db[key]("walk:public");`,
      `const { db } = { ...{ ...others, db: supabase } }; ${KEY}db[key]("walk:public");`,
      `const { db } = { db: supabase, ...{ x: other } }; ${KEY}db[key]("walk:public");`,
      `for (const db of [supabase, ...others]) { ${KEY}db[key]("walk:public"); }`,
      `for (const db of [...others, supabase]) { ${KEY}db[key]("walk:public"); }`,
      `for (const db of [...[...others, supabase]]) { ${KEY}db[key]("walk:public"); }`,
      // …a loop whose target is a PATTERN, matched against each element in
      // turn rather than the whole element tested against the seed — Codex's
      // `for (const [db] of [[supabase]])` bound nothing (PR #94, round 66) —
      // in the binding and the assignment form, at a later slot, on a later
      // element, and past an unexpandable spread an iteration still reaches.
      `for (const [db] of [[supabase]]) { ${KEY}db[key]("walk:public"); }`,
      `for (const { db } of [{ db: supabase }]) { ${KEY}db[key]("walk:public"); }`,
      `let db: unknown; for ([db] of [[supabase]]) { ${KEY}(db as never)[key]("walk:public"); }`,
      `for (const [x, db] of [[other, supabase]]) { ${KEY}db[key]("walk:public"); }`,
      `for (const [db] of [[other], [supabase]]) { ${KEY}db[key]("walk:public"); }`,
      `for (const [db] of [...others, [supabase]]) { ${KEY}db[key]("walk:public"); }`,
      // …and a NESTED pattern, in either form, matched against the nested
      // literal — a null slot to the one-level reader before it.
      `const [[db]] = [[supabase]]; ${KEY}db[key]("walk:public");`,
      `const { a: { db } } = { a: { db: supabase } }; ${KEY}db[key]("walk:public");`,
      `const { a: [db] } = { a: [supabase] }; ${KEY}db[key]("walk:public");`,
      `let db: unknown; [[db]] = [[supabase]]; ${KEY}(db as never)[key]("walk:public");`,
      `let db: unknown; ({ a: { db } } = { a: { db: supabase } }); ${KEY}(db as never)[key]("walk:public");`,
    ]) {
      const got = verdicts(body);
      expect(got, body).toHaveLength(1);
      expect(got[0], body).toMatch(computedMember);
    }
    // The same alias reaches the other two rules keyed on the client set —
    // the escaped reference and the destructured method — which were misses
    // too (measured, neither named by the review).
    const escaped = verdicts('let db: typeof supabase; db = supabase; const opener = db.channel; opener("walk:public");');
    expect(escaped).toHaveLength(1);
    expect(escaped[0]).toMatch(/referenced without being called/);
    const taken = verdicts('let db: typeof supabase; db = supabase; const { channel: opener } = db; opener("walk:public");');
    expect(taken).toHaveLength(1);
    expect(taken[0]).toMatch(/taken off it by a destructuring/);
    // A NAMED call through the alias was already caught — as an unresolvable
    // receiver. It is classified now, so the sentence names the real defect.
    expect(verdicts('let db: typeof supabase; db = supabase; db.channel("walk:public");')).toEqual([
      "called with no options — `private` defaults to false (H1)",
    ]);
    expect(verdicts(`let db: typeof supabase; db = supabase; db.channel(t, ${OPTS});`)).toEqual(["private"]);
    // The other direction, which is what keeps this from being "every name is
    // the client": an assignment from something ELSE, a part taken from a
    // NON-literal source (every query result in the app is one), and the
    // result of a call on the client.
    expect(verdicts(`let db: unknown; db = other; ${KEY}(db as never)[key]("walk:public");`)).toEqual([]);
    expect(verdicts('const { data } = await supabase.from("walks").select("id"); const row = data[i]; void row;')).toEqual([]);
    expect(verdicts(`const ch = supabase.channel(t, ${OPTS}); ch[k]("x");`)).toEqual(["private"]);
    expect(verdicts('for (const row of rows) { const v = row[k]; void v; }')).toEqual([]);
    // `for…in` binds KEYS, never the values: `db` is the string "0" here, and
    // reading it as the client refused an unrelated computed string access on
    // healthy code (Codex, PR #94, round 65).
    expect(verdicts('for (const db in [supabase]) { const key: keyof string = "length"; void db[key]; }')).toEqual([]);
    expect(verdicts('for (const db in { a: supabase }) { const key: keyof string = "length"; void db[key]; }')).toEqual([]);
    // A later definition REPLACES the part: `db` holds `other`, not the client.
    expect(verdicts(`const { db } = { ...{ db: supabase }, db: other }; ${KEY}(db as never)[key]("walk:public");`)).toEqual([]);
    expect(verdicts(`const { db } = { db: supabase, get db() { return other; } }; ${KEY}(db as never)[key]("walk:public");`)).toEqual([]);
    // A spread this reader cannot expand, or a key it cannot read, makes
    // UNKNOWN every part it could affect — every position after it in an
    // array, every key before it in an object — and not knowing is not
    // evidence that the name holds the client. The stated miss direction,
    // pinned so that changing it is a decision; each row is one the plausible
    // wrong reading answers with confidence: a zero-width spread puts
    // `supabase` at slot 0, and a skipped one leaves `db` standing.
    expect(verdicts(`const [db] = [...others, supabase]; ${KEY}(db as never)[key]("walk:public");`)).toEqual([]);
    expect(verdicts(`const [db] = [...[...others], supabase]; ${KEY}(db as never)[key]("walk:public");`)).toEqual([]);
    expect(verdicts(`const [db] = [...[...others, supabase]]; ${KEY}(db as never)[key]("walk:public");`)).toEqual([]);
    expect(verdicts(`for (const db of [...others]) { ${KEY}(db as never)[key]("walk:public"); }`)).toEqual([]);
    expect(verdicts(`const { db } = { db: supabase, ...others }; ${KEY}(db as never)[key]("walk:public");`)).toEqual([]);
    expect(verdicts(`const { db } = { db: supabase, ...{ ...others } }; ${KEY}(db as never)[key]("walk:public");`)).toEqual([]);
    expect(verdicts(`const { db } = { db: supabase, [k]: other }; ${KEY}(db as never)[key]("walk:public");`)).toEqual([]);
    expect(verdicts(`const { db } = { db: supabase, get [k]() { return other; } }; ${KEY}(db as never)[key]("walk:public");`)).toEqual([]);
    // A pattern reads its OWN slots: the second of one element, a whole
    // element that is an array, a nested slot past the nested literal's
    // end, and a position after a spread INSIDE the element.
    expect(verdicts(`for (const [x, db] of [[supabase]]) { ${KEY}(db as never)[key]("walk:public"); }`)).toEqual([]);
    expect(verdicts(`for (const db of [[supabase]]) { ${KEY}(db as never)[key]("walk:public"); }`)).toEqual([]);
    expect(verdicts(`const [[x, db]] = [[supabase]]; ${KEY}(db as never)[key]("walk:public");`)).toEqual([]);
    expect(verdicts(`for (const [db] of [[...others, supabase]]) { ${KEY}(db as never)[key]("walk:public"); }`)).toEqual([]);
    // A REST binds an array or an object of what remains, never the seed.
    expect(verdicts(`const [...rest] = [supabase]; ${KEY}(rest as never)[key]("walk:public");`)).toEqual([]);
    expect(verdicts(`const { ...rest } = { db: supabase }; ${KEY}(rest as never)[key]("walk:public");`)).toEqual([]);
  });

  it("resolves the client through a namespace import of its module (round 66)", () => {
    // `import * as sb from "./supabase"` makes the client `sb.supabase`: a
    // seed reached as a member of a known base, the sibling of the
    // `globalThis.Object` finding. Measured on the shipped gate with each
    // planted in the real hook: the named call was REFUSED as an
    // unresolvable receiver (the safe direction), while the computed
    // member, the alias and the destructuring were misses.
    const IMP = 'import * as sb from "./supabase";\n';
    const OPTS = "{ config: { private: true } }";
    const KEY = 'const key: "channel" = "channel"; ';
    const verdicts = (body: string): string[] => {
      const sf = ts.createSourceFile("f.ts", IMP + body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      return channelCallsIn(sf, "f.ts").map((c) => (c.private ? "private" : c.why));
    };
    const computedMember = /a computed member reached from the Supabase client/;
    expect(verdicts('sb.supabase.channel("walk:public");')).toEqual([
      "called with no options — `private` defaults to false (H1)",
    ]);
    expect(verdicts(`sb.supabase.channel(t, ${OPTS});`)).toEqual(["private"]);
    expect(verdicts(`sb["supabase"].channel(t, ${OPTS});`)).toEqual(["private"]);
    expect(verdicts(`const db = sb.supabase; db.channel(t, ${OPTS});`)).toEqual(["private"]);
    for (const body of [
      `${KEY}sb.supabase[key]("walk:public");`,
      `const db = sb.supabase; ${KEY}db[key]("walk:public");`,
      `const { supabase: db } = sb; ${KEY}db[key]("walk:public");`,
      `${KEY}sb.supabase.realtime[key]("walk:public");`,
      // The module exports the client alone, so a computed member of the
      // NAMESPACE is one this check cannot say is not `supabase`.
      `${KEY}sb[key]("walk:public");`,
    ]) {
      const got = verdicts(body);
      expect(got, body).toHaveLength(1);
      expect(got[0], body).toMatch(computedMember);
    }
    const escaped = verdicts('const opener = sb.supabase.channel; opener("walk:public");');
    expect(escaped).toHaveLength(1);
    expect(escaped[0]).toMatch(/referenced without being called/);
    const taken = verdicts('const { channel: opener } = sb.supabase; opener("walk:public");');
    expect(taken).toHaveLength(1);
    expect(taken[0]).toMatch(/taken off it by a destructuring/);
    // The other direction: a namespace of ANOTHER module, and another
    // export's computed member (which `sb` does not carry, and which is
    // ordinary code wherever it is written).
    expect(verdicts(`import * as other from "./other";\n${KEY}other.supabase[key]("walk:public");`)).toEqual([]);
    expect(verdicts(`${KEY}sb.other[key]("walk:public");`)).toEqual([]);
  });

  it("recognises the client module under an explicit extension, and follows aliases of its namespace (Codex, PR #94, round 67)", () => {
    const OPTS = "{ config: { private: true } }";
    const KEY = 'const key: "channel" = "channel"; ';
    const verdicts = (imp: string, body: string): string[] => {
      const sf = ts.createSourceFile("f.ts", imp + "\n" + body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      return channelCallsIn(sf, "f.ts").map((c) => (c.private ? "private" : c.why));
    };
    const computedMember = /a computed member reached from the Supabase client/;
    const H1 = "called with no options — `private` defaults to false (H1)";
    // Codex's case: `./supabase.ts` is a legal spelling of the module under
    // `allowImportingTsExtensions`, and the bare-only matcher recorded no
    // namespace for it — the computed call was missed and the private named
    // call refused as unresolvable. Measured in the real hook: `import * as
    // sbx from "@/lib/supabase.ts"` and `import { supabase as sby } from
    // "@/lib/supabase.ts"` each turned a PRIVATE call red.
    for (const ext of [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"]) {
      const ns = `import * as sb from "./supabase${ext}";`;
      const named = `import { supabase } from "@/lib/supabase${ext}";`;
      expect(verdicts(ns, `${KEY}sb.supabase[key]("walk:public");`)[0], ext).toMatch(computedMember);
      expect(verdicts(ns, `sb.supabase.channel(t, ${OPTS});`), ext).toEqual(["private"]);
      expect(verdicts(named, `supabase.channel(t, ${OPTS});`), ext).toEqual(["private"]);
      expect(verdicts(named, `${KEY}supabase[key]("walk:public");`)[0], ext).toMatch(computedMember);
    }
    // Another module is another module: a different name, a suffix that is
    // not a source extension, a declaration file.
    for (const spec of ["./supabase-admin.ts", "./supabase.config", "./supabase.d.ts", "@/lib/supabaseClient"]) {
      expect(verdicts(`import * as sb from "${spec}";`, `${KEY}sb.supabase[key]("walk:public");`), spec).toEqual([]);
      expect(verdicts(`import { supabase } from "${spec}";`, `supabase.channel(t, ${OPTS});`)[0], spec).toMatch(/cannot resolve that receiver/);
    }
    // Codex's second case: an ALIAS of the namespace is the namespace, and
    // the name-only set let `mod.supabase[key]("walk:public")` open a public
    // topic (measured green in the real hook). By declaration, by assignment,
    // transitively, through a wrapper, in a logical assignment, and as the
    // base of a destructuring; an alias of ANOTHER module's namespace, or of
    // anything else, is not.
    const NS = 'import * as sb from "./supabase";';
    for (const alias of [
      "const mod = sb;",
      "let mod; mod = sb;",
      "const a = sb; const mod = a;",
      "const mod = (sb as never);",
      "let mod = other; mod ??= sb;",
    ]) {
      expect(verdicts(NS, `${alias} ${KEY}mod.supabase[key]("walk:public");`)[0], alias).toMatch(computedMember);
      expect(verdicts(NS, `${alias} ${KEY}mod[key]("walk:public");`)[0], alias).toMatch(computedMember);
      expect(verdicts(NS, `${alias} mod.supabase.channel(t, ${OPTS});`), alias).toEqual(["private"]);
      expect(verdicts(NS, `${alias} mod.supabase.channel("walk:public");`), alias).toEqual([H1]);
      expect(verdicts(NS, `${alias} const { supabase: db } = mod; ${KEY}db[key]("walk:public");`)[0], alias).toMatch(computedMember);
    }
    expect(verdicts(`${NS}\nimport * as other from "./other";`, `const mod = other; ${KEY}mod.supabase[key]("walk:public");`)).toEqual([]);
    expect(verdicts(NS, `const mod = other; ${KEY}mod.supabase[key]("walk:public");`)).toEqual([]);
  });

  it("classifies a channel call through every transparent receiver spelling", () => {
    const IMP = 'import { supabase } from "./supabase";\n';
    const OPTS = "{ config: { private: true } }";
    const verdicts = (body: string): string[] => {
      const sf = ts.createSourceFile("f.ts", IMP + body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      return channelCallsIn(sf, "f.ts").map((c) => (c.private ? "private" : c.why));
    };

    // Transparent wrappers hand the same client through; React and Realtime
    // both receive it, so the gate must too.
    expect(verdicts(`supabase.channel(t, ${OPTS});`)).toEqual(["private"]);
    expect(verdicts(`(supabase).channel(t, ${OPTS});`)).toEqual(["private"]);
    expect(verdicts(`(supabase as never).channel(t, ${OPTS});`)).toEqual(["private"]);
    expect(verdicts(`supabase!.channel(t, ${OPTS});`)).toEqual(["private"]);
    expect(verdicts(`(supabase satisfies object).channel(t, ${OPTS});`)).toEqual(["private"]);
    // …and so does an alias of one, wrapped or not.
    expect(verdicts(`const db = supabase;\n(db).channel(t, ${OPTS});`)).toEqual(["private"]);
    // Depth is not a rule: nine wrappers hand the client through as one does.
    // `unwrapTransparent` stopped at eight, so this receiver "cannot resolve",
    // these options "are not an object literal" and this `true` is "not the
    // literal true" — three reds on a healthy tree (Codex, PR #94, the class
    // of the `outward` finding).
    const nine = (x: string) => "(".repeat(9) + x + ")".repeat(9);
    expect(verdicts(`${nine("supabase")}.channel(t, ${OPTS});`)).toEqual(["private"]);
    expect(verdicts(`supabase.channel(t, ${nine(OPTS)});`)).toEqual(["private"]);
    expect(verdicts(`supabase.channel(t, { config: { private: ${nine("true")} } });`)).toEqual(["private"]);
    // A receiver this file cannot resolve is REPORTED, never skipped.
    expect(verdicts(`other.channel(t, ${OPTS});`)[0]).toMatch(/cannot resolve that receiver/);
    expect(verdicts(`makeThing().channel(t, ${OPTS});`)[0]).toMatch(/cannot resolve that receiver/);
    // The H1 defect itself, and the two ways of writing it.
    expect(verdicts("supabase.channel(t);")).toEqual([
      "called with no options — `private` defaults to false (H1)",
    ]);
    expect(verdicts("supabase.channel(t, { config: { private: false } });")).toEqual([
      "config.private is `false`, not the literal true",
    ]);
    expect(verdicts("supabase.channel(t, { config: {} });")).toEqual(["`config` carries no `private`"]);

    // The method INVOKED through every other spelling. Each of these opens a
    // channel and each left all 11 tests green on the shipped gate, because it
    // matched the method in one position only (Codex, PR #94, and five
    // spellings the finding did not name).
    for (const escaped of [
      'supabase.channel.call(supabase, "walk:public");',
      'supabase.channel.apply(supabase, ["walk:public"]);',
      'const f = supabase.channel.bind(supabase); f("walk:public");',
      'Reflect.apply(supabase.channel, supabase, ["walk:public"]);',
      'const ch = supabase.channel; ch("walk:public");',
      "register(supabase.channel);",
      "[1].forEach(supabase.channel);",
      'new supabase.channel("walk:public");',
      'supabase["channel"].call(supabase, "walk:public");',
      'const ch = supabase["channel"]; ch("walk:public");',
      'const ch = supabase[`channel`]; ch("walk:public");',
    ]) {
      expect(verdicts(escaped), escaped).toEqual([
        "the client's `channel` method is referenced without being called here, so whatever "
          + "receives it can open a topic this check cannot read — call it directly, or classify it here.",
      ]);
    }

    // …and the DESTRUCTURING spelling, which takes the method off the client
    // and leaves the call that follows with no receiver to resolve.
    for (const taken of [
      'const { channel } = supabase; channel("walk:public");',
      'const { channel: ch } = supabase; ch("walk:public");',
      'const { ["channel"]: ch } = supabase; ch("walk:public");',
      'const { ...rest } = supabase; rest.channel("walk:public");',
      'let channel; ({ channel } = supabase); channel("walk:public");',
      'let ch; ({ channel: ch } = supabase); ch("walk:public");',
    ]) {
      expect(verdicts(taken)[0], taken).toMatch(/taken off it by a destructuring/);
    }

    // The OTHER direction, which is what stops either rule becoming "refuse
    // anything unfamiliar": every spelling that really does invoke it here.
    for (const ok of [
      `supabase["channel"](t, ${OPTS});`,
      // A no-substitution TEMPLATE is the same member, and the shared reader
      // is what makes the three gates in this family agree about that.
      "supabase[`channel`](t, " + OPTS + ");",
      `supabase.channel?.(t, ${OPTS});`,
      `(supabase.channel)(t, ${OPTS});`,
      `(supabase.channel as never)(t, ${OPTS});`,
      `(supabase.channel!)(t, ${OPTS});`,
    ]) {
      expect(verdicts(ok), ok).toEqual(["private"]);
    }

    // …and a bare READ of somebody else's `.channel` opens nothing. Reporting
    // it would turn this gate red the first time an unrelated object grows a
    // property of that name, so the unresolvable-receiver refusal stays on the
    // CALL, where it was. The two halves are separate assertions because they
    // are separate rules.
    expect(verdicts("const port = { channel: 2 }; void port.channel;")).toEqual([]);
    expect(verdicts("const other = { channel: 1 }; const { channel } = other; void channel;")).toEqual([]);
    expect(verdicts(`other.channel(t, ${OPTS});`)[0]).toMatch(/cannot resolve that receiver/);
  });

  // The message reader, pinned on fixtures. `serverPrivate()` reads one real
  // file, so every rule about spreads and ordering would otherwise be proven
  // only under sabotage and by nothing in the committed suite.
  it("reads a message literal through spreads, in source order", () => {
    const read = (src: string): string[] =>
      messageLiterals(ts.createSourceFile("b.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));

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
    // Nested NINE deep: this file's own walk followed a spread to depth eight
    // and marked the ninth unresolvable, and the shared `aliasLiteral` stopped
    // at sixteen hops — the same count, in two walks (Codex, PR #94, the
    // `outward` finding's class). Ten literals carry `topic`, so ten values,
    // each the innermost `true`; the alias row reads the source and the sent
    // literal.
    expect(read(`send(${"{ ...".repeat(9)}{ topic, private: true }${" }".repeat(9)});`)).toEqual(Array(10).fill("true"));
    const chain = Array.from({ length: 17 }, (_, i) => `const m${i + 1} = m${i};`).join("\n");
    expect(read(`const m0 = { topic, private: true };\n${chain}\nsend({ ...m17 });`)).toEqual(["true", "true"]);
    // A CYCLE terminates, and is unresolvable rather than resolved: `var m:
    // any = { topic, private: true, ...m }` is legal and runs. After the
    // `true` it marks, exactly as an unfollowable spread does; BEFORE it, the
    // later member overwrites the mark, as the language does it.
    expect(read("var m: any = { topic, private: true, ...m };")).toEqual(["<unresolvable spread `m`>"]);
    expect(read("var m: any = { ...m, topic, private: true };")).toEqual(["true"]);
    // `true as const` is the ordinary way to preserve a literal type and is
    // the same value — reporting it as non-private is a gate red on healthy
    // code, which this repository calls the worse of the two failure shapes.
    expect(read("send({ topic, private: true as const });")).toEqual(["true"]);
    expect(read("send({ topic, private: (true) satisfies boolean });")).toEqual(["true"]);
    // …and the wrappers do not launder a `false`.
    expect(read("send({ topic, private: false as const });")).toEqual(["false as const"]);

    // And the precondition on the reader itself: a literal with no `topic` at
    // all is not a message and contributes nothing, so a reader that answered
    // for every object literal would be reporting on code that sends nothing.
    expect(read("const opts = { retries: 3 };")).toEqual([]);

    // A name declared twice is UNRESOLVABLE, not "whichever the walk saw
    // last" — resolving it to the wrong literal is worse than resolving it to
    // none, since it answers confidently and wrongly.
    expect(read("const c = { private: true };\nfunction f() { const c = { private: false }; return c; }\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    // …while a name declared once still resolves.
    expect(read("const c = { private: true };\nsend({ topic, ...c });")).toEqual(["true"]);
    // Every BINDING form shadows, not only `const`. A parameter was the one
    // that got through: the reader resolved to the module-scope literal while
    // the value actually spread came from the argument.
    expect(read("const c = { private: true };\nfunction f(c) { return send({ topic, ...c }); }"))
      .toEqual(["<unresolvable spread `c`>"]);
    expect(read("const c = { private: true };\nfunction c() {}\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    expect(read("const c = { private: true };\ntry { x(); } catch (c) { send({ topic, ...c }); }"))
      .toEqual(["<unresolvable spread `c`>"]);
    expect(read("const c = { private: true };\nconst { c: renamed } = o;\nsend({ topic, ...renamed });"))
      .toEqual(["<unresolvable spread `renamed`>"]);
    // A name that is ASSIGNED anywhere is unresolvable whatever it started as:
    // a stale initializer is the same defect as a mutated literal.
    expect(read("let c = { private: true };\nc = buildPublic();\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    expect(read("let c = { private: true };\n({ c } = o);\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    // …while a `let` nothing assigns to still resolves, so the rule is about
    // the assignment and not about the keyword.
    expect(read("let c = { private: true };\nsend({ topic, ...c });")).toEqual(["true"]);
    // MUTATING what a name holds is changing the answer, exactly as rebinding
    // it is: the caller reads the object, not the binding.
    expect(read("const c = { private: true };\nc.private = false;\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    expect(read('const c = { private: true };\nc["private"] = false;\nsend({ topic, ...c });'))
      .toEqual(["<unresolvable spread `c`>"]);
    expect(read("const c = { private: true };\ndelete c.private;\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    expect(read("const c = { private: true };\nObject.assign(c, { private: false });\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    // …and the computed spelling reaches the same consumer, which is the half
    // that decides whether a public message passes (Codex, PR #94).
    expect(read('const c = { private: true };\nObject["assign"](c, { private: false });\nsend({ topic, ...c });'))
      .toEqual(["<unresolvable spread `c`>"]);
    expect(read('const c = { private: true };\nObject["assign"].call(null, other, {});\nsend({ topic, ...c });'))
      .toEqual(["<unresolvable spread `c`>"]);
    // An escaped `Object.assign` names no target at all, so the conservative
    // answer is that NO literal in the file is known to be current — the
    // reader cannot say which object was written (Codex, PR #94, sibling).
    expect(read("const c = { private: true };\nObject.assign.call(null, other, {});\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    expect(read("const c = { private: true };\nconst f = Object.assign;\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    // `++`/`--` writes too, and its operand decides what it writes: a member
    // or element access mutates the object, where an identifier rebinds the
    // name. The rule read identifiers only, so `c.private--` recorded neither
    // and `c` kept a literal the program no longer holds (Codex, PR #94).
    expect(read("const c: any = { private: true };\nc.private--;\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    expect(read("const c: any = { private: true };\n++c.private;\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    expect(read("const c: any = { private: true };\nc[\"private\"]++;\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    expect(read("const c: any = { n: { private: true } };\nc.n.private--;\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    // …and it travels the alias graph exactly as every other mutation does.
    expect(read("const c: any = { private: true };\nconst a: any = c;\na.private--;\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    expect(read("const c = { private: true };\nglobalThis.Object.assign(c, {});\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    // …but an unrelated method that happens to be called `assign` is not
    // `Object.assign`, and reading it as one was red on healthy code.
    expect(read("const c = { private: true };\nregistry.assign(c);\nsend({ topic, ...c });"))
      .toEqual(["true"]);
    // …and neither is a call on a LOCAL `Object`. The receiver rule above was
    // still matched by NAME, so a module that binds the global — which
    // TypeScript accepts in every form, unlike `undefined` — had an unchanged
    // literal invalidated by a call that reaches no global at all: red on a
    // healthy tree (Codex, PR #94). Every binding branch of the scan is pinned
    // here, because each one is what makes its own form resolve.
    expect(read("const Object = { assign(_v: unknown) {} };\nconst c = { private: true };\nObject.assign(c);\nsend({ topic, ...c });"))
      .toEqual(["true"]);
    expect(read("class Object { static assign(_v: unknown) {} }\nconst c = { private: true };\nObject.assign(c);\nsend({ topic, ...c });"))
      .toEqual(["true"]);
    expect(read("const c = { private: true };\ntry { use(c); } catch (Object) { Object.assign(c); }\nsend({ topic, ...c });"))
      .toEqual(["true"]);
    // The `globalThis.Object` spelling is the same defect one identifier over,
    // and its OWN binding is what decides it: a local `Object` cannot shadow a
    // property of the global object.
    expect(read("const globalThis = { Object: { assign(_v: unknown) {} } };\nconst c = { private: true };\nglobalThis.Object.assign(c);\nsend({ topic, ...c });"))
      .toEqual(["true"]);
    // …while a local `Object` leaves `globalThis.Object` alone, so the two
    // resolutions are not one rule wearing two names.
    expect(read("const Object = { assign(_v: unknown) {} };\nconst c = { private: true };\nglobalThis.Object.assign(c, {});\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    // A TYPE-ONLY import binds a name for the CHECKER and emits nothing, so the
    // runtime `Object` is still the global and this IS the built-in mutation.
    // Reading it as a shadow left the literal reading `private: true` while the
    // program had already made it false — the gate blessing what it forbids,
    // and `import type` appears throughout the trees these gates read (Codex,
    // PR #94). Both spellings: `isTypeOnly` sits on the clause in the first and
    // on the specifier in the second.
    expect(read('import type { Helper as Object } from "./dep.ts";\nconst c = { private: true };\nObject.assign(c, { private: false });\nsend({ topic, ...c });'))
      .toEqual(["<unresolvable spread `c`>"]);
    expect(read('import { type Helper as Object } from "./dep.ts";\nconst c = { private: true };\nObject.assign(c, { private: false });\nsend({ topic, ...c });'))
      .toEqual(["<unresolvable spread `c`>"]);
    // `declare` is the same class, found by checking the sibling rather than
    // the site reported: it emits nothing, so the call reaches the global.
    // Measured by compiling and RUNNING a module that carries one.
    expect(read("declare const Object: { assign(t: unknown, s: unknown): void };\nconst c = { private: true };\nObject.assign(c, { private: false });\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    // …while a VALUE import still binds, so the rule did not become
    // "an import never shadows".
    expect(read('import { helper as Object } from "./dep.ts";\nconst c = { private: true };\nObject.assign(c);\nsend({ topic, ...c });'))
      .toEqual(["true"]);
    // A SECOND residual, pinned rather than modelled: a namespace whose body
    // declares only types emits nothing either (measured — it compiles away,
    // while one carrying a function emits a real binding), and this still
    // reads it as a shadow, so the mutation below is MISSED. The direction is
    // named rather than called conservative. Deciding otherwise means
    // implementing TypeScript's instantiated-module rule for a form that
    // occurs nowhere in the trees these gates read (measured: zero
    // `namespace`/`module`/`declare` in app/src and supabase/functions).
    expect(read("namespace Object { export type A = 1; }\nconst c = { private: true };\nObject.assign(c, { private: false });\nsend({ topic, ...c });"))
      .toEqual(["true"]);
    // The RESIDUAL, pinned so that changing it is a decision somebody makes.
    // The scan is file-wide, so a NESTED binding beside a genuine built-in
    // call under-reports the mutation. Closing it needs a scope model this
    // module deliberately does not have, and it is the narrower hazard: the
    // red above needs only a shadow, this needs a shadow AND a real call.
    expect(read("function f(Object: { assign(v: unknown): void }) { Object.assign(1); }\nconst c = { private: true };\nObject.assign(c, { private: false });\nsend({ topic, ...c });"))
      .toEqual(["true"]);
    // A mutation through an ALIAS is a mutation of the same object, whichever
    // name it was written through, and transitively along a chain of them.
    expect(read("const c = { private: true };\nconst a = c;\na.private = false;\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    expect(read("const c = { private: true };\nconst a = c;\nconst b = a;\nObject.assign(b, {});\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    expect(read("const c = { private: true };\nconst a = c;\ndelete a.private;\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    // …while an alias nobody mutates leaves the original alone, so aliasing by
    // itself is not a refusal.
    expect(read("const c = { private: true };\nconst a = c;\nuse(a);\nsend({ topic, ...c });"))
      .toEqual(["true"]);
    // An alias formed by an ASSIGNMENT is an alias too — a declaration is not
    // the only way to make two names one object.
    expect(read("const c = { private: true };\nlet a;\na = c;\na.private = false;\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    // REBINDING a name is not mutating the object it held, so it costs that
    // name its literal and leaves every other name for the object alone.
    // Closing rebinding over the alias graph would refuse `c` here, which
    // nothing has touched.
    expect(read("const c = { private: true };\nlet a = c;\na = other;\nsend({ topic, ...c });"))
      .toEqual(["true"]);
    expect(read("let a = { private: true };\na = other;\nsend({ topic, ...a });"))
      .toEqual(["<unresolvable spread `a`>"]);
    // A destructuring assignment forms an alias too, and the link is made
    // conservatively (every target to every identifier the right side
    // mentions) rather than by matching positions, because the right side can
    // be any expression.
    expect(read("const c = { private: true };\nlet a;\n[a] = [c];\na.private = false;\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    expect(read("const c = { private: true };\nlet a;\n({ a } = { a: c });\na.private = false;\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    // A destructuring DECLARATION forms an alias exactly as the assignment
    // form does — the same rule, one binding form later.
    expect(read("const c = { private: true };\nconst [a] = [c];\na.private = false;\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    expect(read("const c = { private: true };\nconst { x: a } = { x: c };\na.private = false;\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    // The rest of the binding forms that carry a SOURCE expression. These are
    // enumerated from the language rather than from the cases in front of me,
    // after four rounds of "one more form": a parameter default, a binding
    // element's default, and a `for…of` that declares its own variable (a
    // fresh binding, so it shadows nothing — but it holds the same object).
    expect(read("const c = { private: true };\nfunction m(a = c) { a.private = false; }\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    expect(read("const c = { private: true };\nconst { x: a = c } = o;\na.private = false;\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    expect(read("const c = { private: true };\nfor (const a of [c]) a.private = false;\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    // …and none of them refuses anything on its own: only a mutation does.
    expect(read("const c = { private: true };\nfor (const a of [c]) use(a);\nsend({ topic, ...c });"))
      .toEqual(["true"]);
    expect(read("const c = { private: true };\nfunction m(a = c) { use(a); }\nsend({ topic, ...c });"))
      .toEqual(["true"]);
    // A LOGICAL assignment assigns the right side when it runs, so it forms
    // the same alias — while deliberately not counting as a definite
    // rebinding, which is a different question about the same statement.
    expect(read("const c = { private: true };\nlet a;\na ??= c;\na.private = false;\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    expect(read("const c = { private: true };\nlet a;\na ||= c;\na.private = false;\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    // An enum and a namespace introduce a VALUE binding, so either shadows an
    // outer object — the confident-wrong-answer hazard the shadow rule is for.
    // So does the NAME of a function or class EXPRESSION, inside its own body.
    expect(read("const c = { private: true };\nfunction f() { enum c { x } ; return c; }\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    expect(read("const c = { private: true };\nconst F = function c() { return c; };\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    expect(read("const c = { private: true };\nconst K = class c {};\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    // `??=` and `||=` cannot assign to a name this map holds, because it only
    // ever holds names initialised to an OBJECT LITERAL — non-nullish and
    // truthy — so treating them as a definite rebinding threw away a literal
    // the program still holds. `&&=` is the mirror and does rebind.
    expect(read("let c = { private: true };\nc ??= other;\nsend({ topic, ...c });"))
      .toEqual(["true"]);
    expect(read("let c = { private: true };\nc ||= other;\nsend({ topic, ...c });"))
      .toEqual(["true"]);
    expect(read("let c = { private: true };\nc &&= other;\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    // An accessor or a method DEFINES the property and answers a function
    // body, so it must override a spread rather than fall through it.
    expect(read("const b = { private: true };\nsend({ topic, ...b, get private() { return false; } });"))
      .toEqual(["<accessor or method, unreadable>"]);
    expect(read("const b = { private: true };\nsend({ topic, ...b, set private(v) {} });"))
      .toEqual(["<accessor or method, unreadable>"]);
    expect(read("const b = { private: true };\nsend({ topic, ...b, private() { return false; } });"))
      .toEqual(["<accessor or method, unreadable>"]);
    // …and one whose NAME is computed could be any of them.
    expect(read("const b = { private: true };\nsend({ topic, ...b, get [k]() { return false; } });"))
      .toEqual(["<computed accessor, unreadable>"]);
    // An accessor on an unrelated key leaves the answer alone.
    expect(read("send({ topic, private: true, get other() { return 1; } });")).toEqual(["true"]);
    // PINNED REFUSAL, not an accident: an alias rebound BEFORE it is mutated
    // still invalidates the original. Dropping the stale edge needs to know
    // which assignment ran first — flow sensitivity — and the mirror of this
    // case (`a.private = false;` then `a = other;`) is a real mutation a
    // lifetime-aware graph would MISS. Over-refusing is legible and its remedy
    // is obvious; missing is silent. Changing this should be a decision.
    expect(read("const c = { private: true };\nlet a = c;\na = other;\na.private = false;\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    // A loop variable is assigned on every iteration and produces no
    // assignment expression at all.
    expect(read("let c = { private: true };\nfor (c of xs) {}\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    expect(read("let c = { private: true };\nfor (c in xs) {}\nsend({ topic, ...c });"))
      .toEqual(["<unresolvable spread `c`>"]);
    // …while a loop that DECLARES its own variable is a different binding and
    // leaves the outer one alone, so this is not red on healthy code.
    expect(read("const c = { private: true };\nfor (const x of xs) {}\nsend({ topic, ...c });"))
      .toEqual(["true"]);
    // A spread of a WRAPPED literal is the same object. Reading the wrapper
    // made this gate red on healthy code.
    expect(read("send({ topic, ...({ private: true } as const) });")).toEqual(["true"]);

    // An UNRELATED literal is not a message literal. A blanket mark says an
    // unreadable member could define `topic`, which is not evidence that this
    // object is one — and asking `props.has` made every such literal a message
    // whose marker then failed the assertion on healthy code (Codex, PR #94).
    for (const unrelated of [
      "const opts = { ...imported };",
      "const opts = { [key]: 1 };",
      "const opts = { get [k]() { return 1; } };",
      "fetch(url, { ...imported, method: 'POST' });",
    ]) {
      expect(read(unrelated + "\nsend({ topic, private: true });"), unrelated).toEqual(["true"]);
    }
    // …and the other direction, which is what stops that becoming "a marker
    // never refuses": an object that NAMES `topic` and then cannot be read is
    // still reported, because there the blanket mark is about the very object
    // being read.
    expect(read("send({ topic, private: true, ...imported });"))
      .toEqual(["<unresolvable spread `imported`>"]);
  });

  it("reads every element of the messages array, and refuses what it cannot", () => {
    const sent = (src: string) =>
      messageElements(ts.createSourceFile("b.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));

    expect(sent("post({ messages: [{ topic, private: true }] });").values).toEqual(["true"]);
    expect(sent("post({ messages: [{ topic, private: false }] });").values).toEqual(["false"]);
    // An identifier naming a module-scope literal resolves.
    expect(sent("const m = { topic, private: true };\npost({ messages: [m] });").values).toEqual(["true"]);
    // Codex's case: a literal that clears the bar, beside a call that does not
    // get looked at. The element is refused by name rather than passed over.
    expect(sent("post({ messages: [{ topic, private: true }, publicMessage(topic)] });").values)
      .toEqual(["true", "<unreadable message element: publicMessage(topic)>"]);
    // A conditional, a spread of an array, and an identifier naming nothing.
    expect(sent("post({ messages: [flag ? a : b] });").values).toHaveLength(1);
    expect(sent("post({ messages: [...others] });").values).toHaveLength(1);
    expect(sent("post({ messages: [nowhere] });").values).toEqual(["<unreadable message element: nowhere>"]);
    // `messages` that is not an array literal at all.
    expect(sent("post({ messages: buildMessages(topic) });").values).toHaveLength(1);
    expect(sent("post({ messages: buildMessages(topic) });").values[0]).toContain("not an array literal");
    // An EMPTY array is reported rather than passing by having nothing to fail.
    expect(sent("post({ messages: [] });").values).toEqual(["<`messages` is empty>"]);
    // And the precondition: a file with no `messages:` at all is not read, so
    // `found` is false and the caller fails rather than reporting agreement.
    expect(sent("post({ other: 1 });").found).toBe(false);

    // A TRANSPARENT WRAPPER around the array is the same array. All four of
    // these reported "not an array literal" and failed the gate on healthy
    // code (Codex, PR #94) — the worse direction, since a gate red on a
    // correct tree is the one somebody deletes to ship something unrelated.
    for (const wrapped of [
      "post({ messages: ([{ topic, private: true }] as const) });",
      "post({ messages: ([{ topic, private: true }]) });",
      "post({ messages: ([{ topic, private: true }] satisfies unknown[]) });",
      "post({ messages: ([{ topic, private: true }]!) });",
    ]) {
      expect(sent(wrapped).values, wrapped).toEqual(["true"]);
    }

    // A LATER definition of the same key is what gets sent. Each of these read
    // `["true"]` on the shipped reader while the language sent the override —
    // the gate blessing what it forbids (Codex, PR #94, and three siblings it
    // did not name). The rules are `effectiveProps`' and are shared with the
    // `private` half now, so the two cannot disagree about them again.
    const OVERRIDES: Array<[string, string]> = [
      ["computed key", "const key = 'messages';\npost({ messages: [{ topic, private: true }], [key]: [publicMessage(t)] });"],
      ["accessor", "post({ messages: [{ topic, private: true }], get messages() { return 1; } });"],
      ["method", "post({ messages: [{ topic, private: true }], messages() { return 1; } });"],
      ["computed accessor", "post({ messages: [{ topic, private: true }], get ['mess'+'ages']() { return 1; } });"],
      ["unfollowable spread", "post({ messages: [{ topic, private: true }], ...imported });"],
    ];
    for (const [label, code] of OVERRIDES) {
      const r = sent(code);
      expect(r.found, label).toBe(true);
      expect(r.values.filter((v) => v === "true"), label).toEqual([]);
    }

    // …and the other direction, which is what stops that becoming "refuse any
    // computed key" or "refuse any spread". A computed key that is a string
    // literal names exactly one property and the override IS read, so the
    // public array is caught rather than the file being refused wholesale…
    expect(sent("post({ messages: [{ topic, private: true }], ['messages']: [{ topic, private: false }] });").values)
      .toEqual(["false"]);
    // …and a spread this reader CAN follow carries a real array through.
    expect(sent("const o = { messages: [{ topic, private: true }] };\npost({ ...o });").values
      .filter((v) => v !== "true")).toEqual([]);

    // A SHORTHAND `messages` is a reference to an array, which this reader has
    // no machinery to resolve — refused BY NAME rather than left to fail the
    // caller's precondition, whose message says the file carries no `messages`
    // at all. A red that misdescribes itself is its own defect.
    const short = sent("const messages = [{ topic, private: false }];\npost({ messages });");
    expect(short.found).toBe(true);
    expect(short.values).toEqual(["<shorthand, unreadable>"]);

    // An UNRELATED literal is not a request object either — the same rule one
    // reader over, and the one that round 44 introduced by putting `messages`
    // in `ASKED`. Each of these reported its marker beside the healthy
    // `["true"]`, so the assertion failed on correct code (Codex, PR #94).
    for (const unrelated of [
      "const opts = { ...imported };",
      "const opts = { [key]: 1 };",
      "const opts = { get [k]() { return 1; } };",
    ]) {
      const r = sent(unrelated + "\npost({ messages: [{ topic, private: true }] });");
      expect(r.found, unrelated).toBe(true);
      expect(r.values, unrelated).toEqual(["true"]);
    }
  });

  it("sees a mutation that would make reading literals unsound", () => {
    const muts = (src: string): string[] =>
      mutations(ts.createSourceFile("b.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));

    expect(muts("const m = { private: true };\nm.private = false;")).toHaveLength(1);
    expect(muts('const m = { private: true };\nm["private"] = false;')).toHaveLength(1);
    expect(muts("const m = { private: true };\nObject.assign(m, { private: false });")).toHaveLength(1);
    // …and a reference to it that is NOT invoked here. Each of these mutates
    // exactly as the direct call does while naming no target the root
    // collector could see, so `mutations()` reported nothing and the reader
    // above kept a stale literal — the SIBLING of the channel finding, in
    // this file's own predicate (Codex, PR #94).
    for (const escaped of [
      "const m = { private: true };\nObject.assign.call(null, m, { private: false });",
      "const m = { private: true };\nObject.assign.apply(null, [m, { private: false }]);",
      "const m = { private: true };\nconst f = Object.assign.bind(null); f(m, {});",
      "const m = { private: true };\nReflect.apply(Object.assign, null, [m, {}]);",
      "const m = { private: true };\nconst assign = Object.assign; assign(m, {});",
      "const m = { private: true };\nrun(Object.assign);",
    ]) {
      expect(muts(escaped), escaped).toHaveLength(1);
    }
    // …and the other direction: a module that BINDS the name calls its own,
    // so neither the call nor a reference to it is the built-in. Reporting it
    // would be red on healthy code, which is why the receiver is resolved
    // rather than matched — one predicate, both positions.
    expect(muts("const Object = { assign(_v: unknown) {} };\nconst m = { private: true };\nrun(Object.assign);")).toEqual([]);
    expect(muts("const m = { private: true };\nrun(registry.assign);")).toEqual([]);
    // The receiver decides. `metrics.assign({…})` is somebody else's method.
    expect(muts("const m = { private: true };\nmetrics.assign({ topic });")).toEqual([]);
    // `x.m` and `x["m"]` are the same member. The predicate knew only the
    // property spelling, so `Object["assign"](message, { private: false })`
    // was neither a direct mutation nor an escaped one and the stale literal
    // survived (Codex, PR #94; five more spellings measured beyond the one
    // reported).
    for (const computed of [
      'const m = { private: true };\nObject["assign"](m, { private: false });',
      "const m = { private: true };\nObject[`assign`](m, { private: false });",
      'const m = { private: true };\nglobalThis["Object"].assign(m, { private: false });',
      'const m = { private: true };\nglobalThis["Object"]["assign"](m, { private: false });',
      'const m = { private: true };\nObject["assign"].call(null, m, { private: false });',
      'const m = { private: true };\nconst f = Object["assign"];',
    ]) {
      expect(muts(computed), computed).toHaveLength(1);
    }
    // …and the other direction, which is what stops that becoming "any
    // subscript is the built-in": a bound name, a bound `globalThis` and
    // somebody else's method.
    expect(muts('const Object = { assign(_v: unknown) {} };\nconst m = { private: true };\nObject["assign"](m, {});')).toEqual([]);
    expect(muts('const globalThis = { Object: { assign(_v: unknown) {} } };\nconst m = { private: true };\nglobalThis["Object"]["assign"](m, {});')).toEqual([]);
    expect(muts('const m = { private: true };\nregistry["assign"](m);')).toEqual([]);
    // A key this reader cannot resolve on the RESOLVED built-in is reported,
    // which REVERSES round fifty-five's pin: `const k: "assign" = "assign";
    // Object[k](m, { private: false })` mutates exactly as the direct call
    // does and left this list empty and the literal stale (Codex, PR #94,
    // round 63 — the client's `supabase[key]` finding, in this predicate).
    // "A computed key is not a name" still holds: the row whose key VARIABLE
    // is itself called `assign` is reported as a COMPUTED member, not as the
    // built-in's `assign`, because the program calls whatever the variable
    // holds — and that is exactly why it cannot be read as no member either.
    for (const computedKey of [
      'const m = { private: true };\nObject[k](m, { private: false });',
      'const m = { private: true };\nconst k: "assign" = "assign"; Object[k](m, { private: false });',
      'const m = { private: true };\nObject[pick()](m, { private: false });',
      'const m = { private: true };\nObject[assign](m, { private: false });',
      'const m = { private: true };\nconst f = Object[k];',
      'const m = { private: true };\nglobalThis["Object"][k](m, { private: false });',
    ]) {
      expect(muts(computedKey), computedKey).toEqual([expect.stringContaining("a computed member of Object")]);
    }
    // The built-in reached through an ALIAS, in every form a name can come to
    // hold it: `const O = Object; O.assign(m, …)` mutates `m` exactly as the
    // direct call does, and a receiver matched by its spelling alone reported
    // nothing and kept the literal readable — for the declaration, the
    // assignment, the computed, the escaped and the `globalThis` spellings
    // alike (measured; Codex, PR #94, round 64, the channel gate's
    // assignment-alias finding in this predicate).
    expect(muts('const O = Object;\nconst m = { private: true };\nO.assign(m, { private: false });')).toHaveLength(1);
    expect(muts('let O: typeof Object;\nO = Object;\nconst m = { private: true };\nO.assign(m, { private: false });')).toHaveLength(1);
    expect(muts('const O = Object;\nconst m = { private: true };\nconst k: "assign" = "assign"; O[k](m, { private: false });'))
      .toEqual([expect.stringContaining("a computed member of Object")]);
    expect(muts('const O = Object;\nconst m = { private: true };\nconst f = O.assign;'))
      .toEqual([expect.stringContaining("referenced without being called")]);
    expect(muts('const g = globalThis;\nconst m = { private: true };\ng.Object.assign(m, { private: false });')).toHaveLength(1);
    // …and an alias of the built-in's OTHER spelling, `globalThis.Object`,
    // which is a member access rather than an identifier and so was not a
    // source the holders set could read (Codex, PR #94, round 65).
    expect(muts('const O = globalThis.Object;\nconst m = { private: true };\nO.assign(m, { private: false });')).toHaveLength(1);
    expect(muts('const O = globalThis["Object"];\nconst m = { private: true };\nO.assign(m, { private: false });')).toHaveLength(1);
    expect(muts('const g = globalThis;\nconst O = g.Object;\nconst m = { private: true };\nO.assign(m, { private: false });')).toHaveLength(1);
    expect(muts('let O: typeof Object;\nO = globalThis.Object;\nconst m = { private: true };\nO.assign(m, { private: false });')).toHaveLength(1);
    expect(muts('const O = globalThis.Object;\nconst m = { private: true };\nconst k: "assign" = "assign"; O[k](m, { private: false });'))
      .toEqual([expect.stringContaining("a computed member of Object")]);
    expect(muts('const O = globalThis.Object;\nconst m = { private: true };\nconst f = O.assign;'))
      .toEqual([expect.stringContaining("referenced without being called")]);
    // …and the built-in taken OFF the global by a DESTRUCTURING, which is the
    // member read one syntactic shape over: `const { Object: O } = globalThis`
    // went through the pattern branch, met a non-literal source and bound
    // nothing (Codex, PR #94, round 66) — with the alias-of-`globalThis`,
    // assignment, literal-key and loop spellings beside it, and the SHORTHAND,
    // which binds the name `Object` itself to the global it names.
    for (const src of [
      'const { Object: O } = globalThis;\nconst m = { private: true };\nO.assign(m, { private: false });',
      'const g = globalThis;\nconst { Object: O } = g;\nconst m = { private: true };\nO.assign(m, { private: false });',
      'let O: typeof Object;\n({ Object: O } = globalThis);\nconst m = { private: true };\nO.assign(m, { private: false });',
      'const { ["Object"]: O } = globalThis;\nconst m = { private: true };\nO.assign(m, { private: false });',
      'const { Object } = globalThis;\nconst m = { private: true };\nObject.assign(m, { private: false });',
      'for (const [O] of [[globalThis.Object]]) {\nconst m = { private: true };\nO.assign(m, { private: false });\n}',
    ]) expect(muts(src), src).toHaveLength(1);
    expect(muts('const { Object: O } = globalThis;\nconst m = { private: true };\nconst k: "assign" = "assign"; O[k](m, { private: false });'))
      .toEqual([expect.stringContaining("a computed member of Object")]);
    expect(muts('const { Object: O } = globalThis;\nconst m = { private: true };\nconst f = O.assign;'))
      .toEqual([expect.stringContaining("referenced without being called")]);
    // …and not another key, another source, a bound `globalThis`, or a
    // spread of the global, which is unfollowable and stays the stated miss.
    expect(muts('const { Reflect: O } = globalThis;\nconst m = { private: true };\nO.assign(m, { private: false });')).toEqual([]);
    expect(muts('const { Object: O } = registry;\nconst m = { private: true };\nO.assign(m, { private: false });')).toEqual([]);
    expect(muts('const globalThis = { Object: { assign(_a: unknown, _b: unknown) {} } };\nconst { Object: O } = globalThis;\nconst m = { private: true };\nO.assign(m, { private: false });')).toEqual([]);
    expect(muts('const { Object: O } = { ...globalThis };\nconst m = { private: true };\nO.assign(m, { private: false });')).toEqual([]);
    // …through an iteration, which binds every readable element whatever an
    // unexpandable spread beside it holds — and NOT through a key an
    // unfollowable spread after it may replace: not knowing is not evidence
    // that `O` is the built-in, the same rule the client set follows.
    expect(muts('for (const O of [...others, Object]) {\nconst m = { private: true };\nO.assign(m, { private: false });\n}')).toHaveLength(1);
    expect(muts('const { O } = { O: Object, ...others };\nconst m = { private: true };\nO.assign(m, { private: false });')).toEqual([]);
    // …and not `.Object` on something that is NOT the global `globalThis`.
    expect(muts('const g = { Object: { assign(_a: unknown, _b: unknown) {} } };\nconst O = g.Object;\nconst m = { private: true };\nO.assign(m, { private: false });')).toEqual([]);
    expect(muts('const globalThis = { Object: { assign(_a: unknown, _b: unknown) {} } };\nconst O = globalThis.Object;\nconst m = { private: true };\nO.assign(m, { private: false });')).toEqual([]);
    // …and not on a receiver that is NOT the built-in: a bound `Object`, a
    // bound `globalThis`, somebody else's object. A computed member of those
    // is ordinary code.
    expect(muts('const Object = { assign(_v: unknown) {} };\nconst m = { private: true };\nObject[k](m, {});')).toEqual([]);
    expect(muts('const globalThis = { Object: {} };\nconst m = { private: true };\nglobalThis["Object"][k](m, {});')).toEqual([]);
    expect(muts('const m = { private: true };\nregistry[k](m);')).toEqual([]);
    // …and so does what the receiver's NAME refers to: a module that binds
    // `Object` calls its own, and reading that as the built-in made this
    // reader refuse a file it has no business refusing (Codex, PR #94). The
    // SIBLING reader in `static-object.ts` shares the predicate, so one fix
    // covers both — which is why it is a predicate and not a copy of the test.
    expect(muts("const Object = { assign(_v: unknown) {} };\nconst m = { private: true };\nObject.assign(m);")).toEqual([]);
    expect(muts("const globalThis = { Object: { assign(_v: unknown) {} } };\nconst m = { private: true };\nglobalThis.Object.assign(m);")).toEqual([]);
    // …and a TYPE-ONLY alias of the name binds nothing at runtime, so the
    // call is the built-in and this reader must still report it. The SIBLING
    // reader in `static-object.ts` shares the predicate, so one fix covers
    // both — which is why it is a predicate and not a copy of the test.
    expect(muts('import type { Helper as Object } from "./dep.ts";\nconst m = { private: true };\nObject.assign(m, { private: false });')).toHaveLength(1);
    expect(muts("declare const Object: { assign(t: unknown, s: unknown): void };\nconst m = { private: true };\nObject.assign(m, { private: false });")).toHaveLength(1);
    expect(muts("const m = { private: true };\ndelete m.private;")).toHaveLength(1);
    expect(muts("let n = 0;\nn += 1;\nconst m = { private: true };\nm.count += 1;")).toHaveLength(1);
    // The sibling hole, fixed in the same commit: `++`/`--` on a member is a
    // property write the assignment branch above cannot see.
    expect(muts("const m: any = { private: true };\nm.private--;")).toHaveLength(1);
    expect(muts("const m: any = { private: true };\n++m.private;")).toHaveLength(1);
    expect(muts('const m: any = { private: true };\nm["private"]++;')).toHaveLength(1);
    // …while the same operator on a NAME rebinds it and mutates no object, so
    // this reader — which reports property writes — stays silent.
    expect(muts("let n = 0;\nn++;")).toEqual([]);
    // A read is not a mutation, and neither is declaring one.
    expect(muts("const m = { private: true };\nif (m.private) send(m);")).toEqual([]);

    // A TRANSPARENT WRAPPER around the CALLEE is the same call, and one around
    // a write TARGET is the same write. Every row below read as no mutation at
    // all on the shipped reader, so this list — the PRECONDITION that makes
    // reading `broadcast.ts`'s literals sound — reported agreement while the
    // object was being written (Codex, PR #94, and six spellings measured
    // beyond the two reported).
    for (const wrapped of [
      "const m = { private: true };\n(Object.assign)(m, { private: false });",
      "const m = { private: true };\n(Object.assign as typeof Object.assign)(m, { private: false });",
      "const m = { private: true };\n(Object.assign satisfies typeof Object.assign)(m, { private: false });",
      "const m = { private: true };\nObject.assign!(m, { private: false });",
      "const m = { private: true };\n((Object.assign))(m, { private: false });",
      'const m = { private: true };\n(Object["assign"])(m, { private: false });',
      "const m = { private: true };\n(globalThis.Object.assign)(m, { private: false });",
      "const m: any = { private: true };\n(m.private) = false;",
      'const m: any = { private: true };\n(m["private"]) = false;',
      "const m: any = { private: true };\n(m.private)--;",
    ]) {
      expect(muts(wrapped), wrapped).toHaveLength(1);
    }
    // …and the other direction, which is what stops the fix becoming "unwrap
    // until something matches": the receiver is still RESOLVED through the
    // wrapper, so a bound name and somebody else's method stay silent.
    expect(muts("const Object = { assign(_v: unknown) {} };\nconst m = { private: true };\n(Object.assign)(m, {});")).toEqual([]);
    expect(muts("const m = { private: true };\n(registry.assign)(m);")).toEqual([]);
    // A wrapped computed member of the built-in is the computed-member case,
    // reported as such (round 63 reversed the silence this row used to pin).
    expect(muts("const m = { private: true };\n(Object[k])(m, { private: false });"))
      .toEqual([expect.stringContaining("a computed member of Object")]);
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
    expect(
      server.found,
      "broadcast.ts must carry both a `{ topic, …, private }` message literal and a `messages:` array "
        + "for this check to have read anything — a reader that finds neither reports agreement",
    ).toBe(true);
    // Reading a LITERAL is sound only while the literal is what gets sent.
    // `const message = { …, private: true }; message.private = false;` left a
    // stale `true` on a line the POST no longer used, and this read it (7 of 7
    // green, measured). Refused rather than modelled: a dataflow analysis is
    // more than one 30-line file earns, and a mutation here should be a
    // deliberate act somebody argues for, not a silent one.
    expect(
      server.mutations,
      "broadcast.ts mutates an object after it is written, so reading its literals no longer says "
        + "what is published — rebuild the message rather than mutating it, or teach this check to follow it",
    ).toEqual([]);
    expect(
      server.values.filter((v) => v !== "true"),
      "every message broadcast.ts publishes must go to the private topic — one public " +
        "message is enough to put a walk's live position on a topic anyone can join",
    ).toEqual([]);
  });

  // `isObjectAssignCall` RESOLVES its receiver rather than matching the name,
  // and this is the measurement that makes that worth doing: unlike
  // `undefined`, whose declaration forms the compiler refuses outright,
  // TypeScript accepts every ordinary way of binding `Object` and
  // `globalThis`. So the shadow is REACHABLE in the very files these gates
  // read, and a name-only test invalidates an unchanged literal there — red on
  // a healthy tree.
  //
  // If a future compiler starts refusing one of these, the resolution is
  // carrying weight it no longer needs for that form and whoever notices
  // decides; it fails here rather than going quietly stale.
  it("tsc ACCEPTS every form of binding `Object` and `globalThis`", () => {
    const dir = mkdtempSync(join(tmpdir(), "objshadow-"));
    writeFileSync(
      join(dir, "dep.ts"),
      "export type Helper = { assign(v: unknown): void };\n"
        + "export const helper = { assign(_v: unknown) {} };\n"
        + "export default helper;\n",
    );

    const forms: Record<string, string> = {
      constDecl: "const Object = { assign(_v: unknown) {} };",
      letDecl: "let Object = { assign(_v: unknown) {} };",
      varDecl: "var Object = { assign(_v: unknown) {} };",
      funcDecl: "function Object(_v: unknown) {}",
      classDecl: "class Object { static assign(_v: unknown) {} }",
      enumDecl: "enum Object { A }",
      namespaceDecl: "namespace Object { export function assign(_v: unknown) {} }",
      importAlias: 'import { helper as Object } from "./dep.ts";',
      paramDecl: "export function f(Object: { assign(v: unknown): void }) { Object.assign(1); }",
      catchClause: "export function g(): void { try { f0(); } catch (Object) { Object; } }",
      globalThisDecl: "const globalThis = { Object: { assign(_v: unknown) {} } };",
      // Type-only and ambient forms typecheck too, which is what makes the
      // OTHER half of the rule reachable: these bind a name for the checker
      // and emit nothing, so the runtime name is still the global.
      typeOnlyClause: 'import type { Helper as Object } from "./dep.ts";',
      typeOnlySpecifier: 'import { type Helper as Object } from "./dep.ts";',
      typeOnlyDefault: 'import type Object from "./dep.ts";',
      typeOnlyNamespace: 'import type * as Object from "./dep.ts";',
      ambientConst: "declare const Object: { assign(v: unknown): void };",
      ambientFunction: "declare function Object(v?: unknown): void;",
    };

    const files = Object.entries(forms).map(([name, binding]) => {
      const file = join(dir, `${name}.ts`);
      writeFileSync(file, `declare function f0(): void;\n${binding}\nexport const used = 1;\n`);
      return file;
    });

    let status = 0;
    let output = "";
    try {
      output = execFileSync(
        join(APP_SRC, "..", "node_modules", ".bin", "tsc"),
        [
          "--noEmit", "--ignoreConfig", "--target", "es2022", "--module", "esnext",
          "--moduleResolution", "bundler", "--allowImportingTsExtensions", "--strict",
          ...files,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      status = e.status ?? -1;
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }

    expect(
      status,
      "tsc now refuses one of the shadow forms `isObjectAssignCall` resolves. Re-measure before "
        + `trusting the rest of that comment — the compiler said:\n${output}`,
    ).toBe(0);
  }, 30_000);
});
