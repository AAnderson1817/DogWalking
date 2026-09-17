import ts from "typescript";

/**
 * Reading STATIC OBJECT SHAPES out of TypeScript, for the gates that need to
 * know what a literal actually carries.
 *
 * Two gates ask that question — `form-error.test.ts` about a JSX attribute,
 * `realtime-channel.test.ts` about a broadcast message and a channel's
 * `config` — and they kept diverging. Three consecutive Codex rounds on PR #94
 * were the same finding: a rule present in one reader and absent from the
 * other, once in each direction (a declared identifier the JSX side would not
 * follow; a transparent `as const` the channel side would not unwrap; then a
 * `let` reassignment neither refused). Patching whichever side is pointed at
 * is the per-site disease this repository's log records more than any other,
 * so the PRIMITIVES live here, in one implementation, and there is no sibling
 * to forget.
 *
 * What stays in each gate is the part that genuinely differs: the shape of an
 * answer. The JSX reader distinguishes "absent" (leave an earlier answer
 * standing) from "present but dynamic" (replace it with no answer); the
 * channel reader carries nodes and markers so it can recurse into `config`
 * and print what it could not read. Those are different questions and share
 * nothing but these building blocks.
 *
 * Stated limit, on the stopping rule the enum-catalogue generator writes down:
 * this catches the mistake, not the adversary. Nothing here follows a value
 * across a module boundary, through a function call, or into a computed
 * member, and a value it cannot read is reported as unreadable rather than
 * guessed at.
 */

/**
 * The five nodes that hand the same value through: `(e)`, `e as T`,
 * `e satisfies T`, `e!` and `<T>e`.
 *
 * ONE predicate, because a reader that spells the set out for itself knows
 * only the wrappers its author happened to think of. Six copies in
 * `discarded-errors.test.ts` each omitted the `<T>e` assertion, and two of
 * them were gates RED ON A HEALTHY TREE — `(<SupabaseClient>db).from(…)` with
 * its error handled read as an unrecognised receiver (Codex, PR #94,
 * measured). `await` is deliberately NOT one: `(await f)(x)` is a call whose
 * callee is the await and not `f`, so stepping through it would read a
 * different program.
 */
export function isTransparentWrapper(
  n: ts.Node,
): n is ts.ParenthesizedExpression | ts.AsExpression | ts.SatisfiesExpression
  | ts.NonNullExpression | ts.TypeAssertion {
  return ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isParenthesizedExpression(n)
    || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n);
}

/**
 * A value with its transparent wrappers stripped.
 *
 * React receives the same literal through every one of them and so does
 * Realtime, so a reader that stops at the wrapper either calls a static value
 * dynamic (a miss) or calls a private option non-private (a gate red on a
 * healthy tree, which is the worse of the two).
 *
 * UNBOUNDED, and the bound it used to carry is the finding: a wrapper's DEPTH
 * is not a rule — nine parentheses hand a value through exactly as one does —
 * and a loop that stopped after eight was not a termination guard but a wrong
 * answer at nine. A descent through `.expression` ends at a leaf because the
 * tree is finite, so it needs no count; with one, a receiver wrapped nine deep
 * read as "unrecognised" (a gate red on a healthy tree) and a callee wrapped
 * nine deep read as no call at all, so a discarded error behind it was blessed
 * (Codex, PR #94 — measured, the downward sibling of the `outward` finding).
 */
export function unwrapTransparent(e: ts.Expression): ts.Expression {
  let cur = e;
  while (isTransparentWrapper(cur)) cur = cur.expression;
  return cur;
}

/**
 * The call this node is the DIRECT CALLEE of — `x.m(…)` — or null when the
 * reference is handed somewhere else instead.
 *
 * A method matched by its immediate callee is a method matched in exactly ONE
 * position, and every other position still invokes it.
 * `supabase.channel.call(supabase, "walk:public")` opens a channel and
 * `Object.assign.call(null, c, {})` mutates an object; neither is a call whose
 * callee is the method, so a reader keyed on that position sees neither and
 * the gate BLESSES what it forbids (Codex, PR #94 — with `.bind`,
 * `Reflect.apply`, `.apply`, a plain alias and a bare callback measured the
 * same way, so the hole is the position and not the three spellings named).
 *
 * Transparent wrappers are climbed on the way UP, because `(x.m)(…)` invokes
 * exactly as `x.m(…)` does and reading the wrapper would be a gate red on
 * healthy code — the same rule `unwrapTransparent` applies going down.
 *
 * Everything else is the function ESCAPING into a value this module does not
 * follow: an argument, an initialiser, a `new x.m()`, a tagged template. The
 * caller reports it rather than skipping it, because "cannot say" is not "not
 * a call" — which is the posture the rest of these gates already take.
 */
export function calleeCall(node: ts.Node): ts.CallExpression | null {
  const outer = outward(node);
  const parent: ts.Node | undefined = outer.parent;
  if (!parent || !ts.isCallExpression(parent)) return null;
  return parent.expression === outer ? parent : null;
}

/**
 * This node with the transparent wrappers around it climbed — the UPWARD
 * inverse of `unwrapTransparent`, and what a reader must ask before it looks
 * at `.parent`.
 *
 * `unwrapTransparent` answers "what value is this", so a reader that goes
 * DOWN through a wrapper was fixed once (Codex, PR #94). The parent side is
 * the same rule facing the other way: `(x.m)(…)` invokes `x.m` and
 * `(r).error` reads `r.error`, so a check written against the SYNTACTIC
 * parent sees a wrapper where the language sees the consumer — which read an
 * invoked builder method as uncalled and a handled `.error` as never read,
 * both gates red on a healthy tree, while a wrapped `.auth` hop went
 * unclassified and its discarded error was missed entirely. One helper, so
 * the five readers that ask about a parent cannot answer it five ways.
 *
 * `parent.expression === cur` is defence in depth and NO behavioural row
 * pins it, which is measured rather than assumed: walking every node of the
 * five wrapper kinds, the only child for which it is false is the TypeNode
 * of an `as`, `satisfies` or `<T>x` — and none of the readers here ever
 * holds one, since an identifier inside a type has the TypeReference as its
 * parent. It stays because this is a general helper in a shared module and
 * the next caller may pass a type node.
 *
 * UNBOUNDED, for the reason `unwrapTransparent` is: climbing `.parent` ends at
 * the source file because the tree is finite, so the walk needs no count. The
 * eight this shipped with reported a named closure invoked through nine
 * wrappers as never called, and its envelope as never read — a gate red on a
 * healthy tree, in the helper that replaced a `while` loop which had climbed
 * every wrapper (Codex, PR #94).
 */
export function outward(n: ts.Node): ts.Node {
  let cur: ts.Node = n;
  for (;;) {
    const parent: ts.Node | undefined = cur.parent;
    if (parent && isTransparentWrapper(parent) && parent.expression === cur) {
      cur = parent;
      continue;
    }
    return cur;
  }
}

/**
 * The CALLEE of this call, transparent wrappers stripped — the exact inverse
 * of `calleeCall`, which climbs from a reference to the call it is the callee
 * of.
 *
 * `(Object.assign)(m, { private: false })` invokes the built-in exactly as the
 * bare spelling does, and a reader that tests `call.expression` directly sees
 * a wrapper node where the member is. So the call is not a direct mutation —
 * and the inner reference is not ESCAPED either, because `calleeCall`
 * correctly climbs the wrapper and finds the call. Neither branch fires and
 * the stale literal survives (Codex, PR #94). Six further spellings measured
 * beyond the two reported — `satisfies`, `!`, `<T>x`, a nested paren, and a
 * wrapper combined with each of the computed and `globalThis` receivers — and
 * the same hole in three readers of `discarded-errors.test.ts`, where
 * `(db.from)("walks")` with a discarded error left 68 of 68 green.
 */
export function calleeOf(n: ts.Node): ts.Expression | null {
  return ts.isCallExpression(n) ? unwrapTransparent(n.expression) : null;
}

/**
 * The member a write TARGETS — `m.private = false`, `m["private"]--`,
 * `delete m.private` — wrappers stripped, or null when the target is not a
 * member at all.
 *
 * `(m.private) = false` is legal and assigns exactly as the bare spelling
 * does, and `mutations()` in `realtime-channel.test.ts` tested the raw node:
 * three write spellings went unreported (measured). That list is the
 * PRECONDITION which makes reading `broadcast.ts`'s literals sound, so a write
 * it cannot see is one where the gate reads a stale `private: true` and calls
 * a public message private — the callee finding's sibling, one position over
 * (Codex, PR #94).
 *
 * Deliberately looser than `memberAccess`: a dynamic key still names a member,
 * and the question here is whether an object was written rather than which
 * property.
 */
export function memberTarget(e: ts.Expression): ts.Expression | null {
  const cur = unwrapTransparent(e);
  return ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur) ? cur : null;
}

/**
 * `x.m` and `x["m"]` are the SAME member, read one way.
 *
 * Three gates in this family each asked this question and each spelled it
 * differently, so each had a different hole (Codex, PR #94): this module's
 * `Object.assign` predicate knew only the property form, so
 * `Object["assign"](message, { private: false })` was neither a direct
 * mutation nor an escaped one and the stale literal survived; the query scan
 * in `discarded-errors.test.ts` read a string literal and not a
 * NO-SUBSTITUTION TEMPLATE, so `db[`from`]("walks")` with a discarded error
 * was invisible (measured, 68 of 68 green). One implementation, so there is no
 * sibling to forget.
 *
 * The key goes through `literalText`, which unwraps the transparent wrappers
 * and accepts both literal spellings; a genuinely computed key (`x[k]`) is not
 * a member this module can name, so it answers null rather than guessing.
 * `token` is the node a caller reports a line from — the name for a property
 * access, the subscript for an element one.
 */
export function memberAccess(
  n: ts.Node | null | undefined,
): { receiver: ts.Expression; name: string; token: ts.Node } | null {
  if (!n) return null;
  if (ts.isPropertyAccessExpression(n)) {
    return { receiver: n.expression, name: n.name.text, token: n.name };
  }
  if (ts.isElementAccessExpression(n)) {
    const name = literalText(n.argumentExpression);
    if (name !== null) return { receiver: n.expression, name, token: n.argumentExpression };
  }
  return null;
}

/**
 * `x[k]`, `x[f()]`, `` x[`a${b}`] `` — a member this module cannot NAME.
 *
 * `memberAccess` answers null for one, and every caller read that null as
 * "not a member". That was the hole: `const key: "channel" = "channel";
 * supabase[key]("walk:public")` type-checks, opens a second PUBLIC topic, and
 * left all 11 realtime-channel tests green with it planted in the real hook
 * (Codex, PR #94) — and so did `supabase[k]`, `supabase[pick()]`, a template,
 * a concatenation, the escaped, wrapped and aliased spellings, and the
 * namespace hop `supabase.realtime[key]`; a `db[key]("walks")` query whose
 * error is discarded was equally invisible one gate over, and `Object[k](m,
 * …)` mutated a literal the readers then read stale. A computed member is not
 * "no member": on a receiver a gate has RESOLVED it may be the very member
 * the gate asks about, so the conservative answer is to report it by name —
 * and this is the one reader each gate asks, so they cannot disagree about
 * what a computed member is.
 */
export function computedAccess(
  n: ts.Node | null | undefined,
): { receiver: ts.Expression; token: ts.Node } | null {
  if (!n || !ts.isElementAccessExpression(n)) return null;
  if (literalText(n.argumentExpression) !== null) return null;
  return { receiver: n.expression, token: n.argumentExpression };
}

/**
 * The expression a member chain is rooted at — `a.b["c"][k].d` is rooted at
 * `a` — with the transparent wrappers unwrapped at every hop. Stops at
 * anything that is not a member access (a call, a literal, an identifier),
 * which is then the root a caller classifies: `supabase.realtime[key]` and
 * `db.auth[key]` are computed members reached FROM a client, and the client
 * is what decides whether they are reported.
 */
export function memberRoot(e: ts.Expression): ts.Expression {
  let cur = unwrapTransparent(e);
  for (;;) {
    const hop = memberAccess(cur) ?? computedAccess(cur);
    if (!hop) return cur;
    cur = unwrapTransparent(hop.receiver);
  }
}

/** The text of a statically readable string, or null for a dynamic one. */
export function literalText(e: ts.Expression): string | null {
  const cur = unwrapTransparent(e);
  if (ts.isStringLiteral(cur) || ts.isNoSubstitutionTemplateLiteral(cur)) return cur.text;
  return null;
}

/**
 * A property's name when the compiler can read it, or null when it cannot.
 *
 * A COMPUTED key whose expression is a string literal is fully static and
 * names exactly one property: `{ ["role"]: "alert" }` is the same object as
 * `{ role: "alert" }`. A key that is genuinely an expression stays null, which
 * every caller must read as "could be the name I am asking about".
 */
export function propertyKey(name: ts.PropertyName): string | null {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) return literalText(name.expression);
  return null;
}

/**
 * The object literals a name reliably holds, for a spread to resolve.
 *
 * Two rules, each arrived at the hard way:
 *
 *  - a name bound MORE THAN ONCE, anywhere and by any binding form, is
 *    unresolvable. A file-global map does not merely miss a shadowed binding,
 *    it answers confidently and WRONGLY, which is worse — and the first
 *    version of that rule counted variable declarations alone, so the very
 *    first binding form that is not `const` (a function parameter) walked past
 *    it;
 *  - a name that is ASSIGNED anywhere is unresolvable, whatever it was
 *    initialised to. `let attrs = { role: "status" }; attrs = { role: "alert" }`
 *    is a stale initializer, the same shape as reading a literal that has
 *    since been mutated. "Assigned" means every form, not the one spelling
 *    that came first: `x = …`, every compound operator, `x++`, a destructuring
 *    target, a `for (x of …)` or `for (x in …)` loop variable, AND a mutation
 *    of what it holds — `x.y = …`, `x["y"] = …`, `delete x.y`,
 *    `Object.assign(x, …)`. The object is what the caller reads, so changing
 *    the object is changing the answer just as much as rebinding the name —
 *    and a mutation through an ALIAS is a mutation of the same object, so
 *    `const alias = config; alias.private = false;` invalidates `config` too.
 *    Without that the rule read the name it was written through rather than
 *    the object it reached, which is one indirection short of the point. An
 *    alias is formed by a declaration OR an assignment (`let a; a = config;`),
 *    which the first version of the graph missed — the same one-binding-form
 *    -short shape as the shadow rule two rounds earlier.
 *
 * REBINDING and MUTATING are tracked separately, and that separation is what
 * keeps the graph from over-refusing: `let a = config; a = other;` rebinds the
 * NAME `a` and leaves `config`'s object untouched, so only `a` loses its
 * literal, while `a.private = false` reaches the object every alias names and
 * invalidates all of them.
 *
 * ALIAS EDGES ARE PERMANENT, and that is a decision rather than an oversight.
 * An alias that is rebound and THEN mutated — `let a = config; a = other;
 * a.private = false;` — still invalidates `config`, which nothing touched.
 * Codex reported that as a false red on PR #94 and it is one. Removing the
 * stale edge requires knowing which assignment happened first, i.e. flow
 * sensitivity, and the trade is not free in either direction: the mirror,
 * `let a = config; a.private = false; a = other;`, is a real mutation of
 * `config` that a lifetime-aware graph would MISS. For a gate that decides
 * whether a walk's live position goes to a public topic, an over-refusal is
 * legible and its remedy is obvious (rename, or use `const`), while a miss is
 * silent. The refusal is therefore deliberate and PINNED as a test, so that
 * changing it is a decision somebody makes rather than a regression. Neither
 * file these gates read aliases anything today (measured), so the cost is
 * currently zero.
 *
 * Both are refusals rather than analyses, which is the stopping rule this
 * repository settled on: an ambiguous name never gets a confident answer, and
 * the remedy — rename one, or use `const` — is cheaper than a Program over
 * the whole app for this question.
 */
export function declaredObjects(sf: ts.SourceFile): Map<string, ts.ObjectLiteralExpression> {
  const seen = new Map<string, ts.ObjectLiteralExpression | null>();
  // Rebinding a NAME costs that name its literal; MUTATING an object costs it
  // to every name for that object. Two sets, because closing the first over
  // the alias graph would make `let a = config; a = other;` refuse `config`,
  // which nothing has touched.
  const rebound = new Set<string>();
  const mutated = new Set<string>();
  // A reference to `Object.assign` that is not invoked HERE names no target,
  // so there is no root to collect: `Object.assign.call(null, c, {})` writes
  // into `c` and `const f = Object.assign` hands the mutator away entirely.
  // Nothing here can say which object, so nothing here may claim a literal is
  // still current (Codex, PR #94 — the sibling of the channel finding, in the
  // predicate this module shares with the channel gate).
  let escapedMutator = false;
  // `const b = a` makes the two names one object, so a mutation of either is a
  // mutation of both. Undirected, and closed transitively below.
  const aliases = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    if (!aliases.has(a)) aliases.set(a, new Set());
    if (!aliases.has(b)) aliases.set(b, new Set());
    aliases.get(a)!.add(b);
    aliases.get(b)!.add(a);
  };
  // `const attrs = base` — the name holds whatever `base` holds. Recorded
  // here and resolved after the walk, because the source may be declared
  // later in the file; `null` marks a name bound twice, which is unresolvable
  // whichever binding carried the literal.
  const aliasSource = new Map<string, string | null>();

  const bind = (
    name: string,
    lit: ts.ObjectLiteralExpression | null,
    aliasOf: string | null = null,
  ) => {
    if (seen.has(name)) {
      seen.set(name, null);
      aliasSource.set(name, null);
      return;
    }
    seen.set(name, lit);
    if (aliasOf) aliasSource.set(name, aliasOf);
  };
  const bindPattern = (nm: ts.BindingName): void => {
    if (ts.isIdentifier(nm)) {
      bind(nm.text, null);
      return;
    }
    for (const el of nm.elements) if (ts.isBindingElement(el)) bindPattern(el.name);
  };

  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n)) {
      if (ts.isIdentifier(n.name)) {
        const init = n.initializer ? unwrapTransparent(n.initializer) : undefined;
        const lit = init && ts.isObjectLiteralExpression(init) ? init : null;
        const aliasOf = init && ts.isIdentifier(init) ? init.text : null;
        bind(n.name.text, lit, aliasOf);
      } else bindPattern(n.name);
    } else if (ts.isParameter(n) || ts.isBindingElement(n)) {
      bindPattern(n.name);
    } else if (
      (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) ||
        ts.isEnumDeclaration(n) || ts.isModuleDeclaration(n) ||
        ts.isFunctionExpression(n) || ts.isClassExpression(n)) &&
      n.name && ts.isIdentifier(n.name)
    ) {
      // An enum and a namespace introduce a VALUE binding, so either can
      // shadow an outer object and make this map answer confidently and
      // wrongly — the hazard the shadow rule exists for. So does the NAME of a
      // function or class EXPRESSION, which binds inside its own body:
      // `const C = function attrs() { … attrs … }` refers to the function
      // there, not to an outer `attrs`.
      bind(n.name.text, null);
    } else if (ts.isImportSpecifier(n) || ts.isImportClause(n) || ts.isNamespaceImport(n)) {
      if (n.name && ts.isIdentifier(n.name)) bind(n.name.text, null);
    } else if (ts.isCatchClause(n) && n.variableDeclaration) {
      bindPattern(n.variableDeclaration.name);
    }

    // Rebinding the NAME: `x = …`, every compound form, and `x++`. A
    // destructuring assignment target counts too.
    if (ts.isBinaryExpression(n) && isDefiniteRebinding(n.operatorToken.kind)) {
      collectAssignmentTargets(n.left, rebound);
    }
    // ALIASING is a separate question from rebinding: `let a; a ??= config;
    // a.private = false;` must still invalidate `config`, and the first
    // version of this rule nested one predicate inside the other and lost
    // exactly that (caught by this file's own fixtures). The alias edges are
    // no longer formed here at all — they come from `bindingSources`, the one
    // enumeration of every form that binds a name to a value, consumed below
    // after the walk (round 64: the channel gate's own alias resolver had a
    // partial copy of this list and missed every form but a declaration).
    if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      // `++`/`--` writes, and WHAT it writes depends on its operand. An
      // identifier is rebound; a member or element access mutates the object
      // the chain roots at, exactly as `c.private = 0` would. The rule was
      // identifier-only, so `const c: any = { private: true }; c.private--;`
      // recorded neither — `c` stayed resolvable to its original literal and a
      // later `{ config: { ...c } }` read as private while Realtime receives
      // the falsey `0` (measured, Codex on PR #94).
      const operand = unwrapTransparent(n.operand);
      if (ts.isIdentifier(operand)) rebound.add(operand.text);
      else collectMutatedRoots(operand, mutated);
    }
    // A loop variable is assigned on every iteration and produces no
    // BinaryExpression at all, so `for (x of […])` slipped past the rule above.
    // Only the bare-identifier form matters: `for (const x of …)` declares a
    // fresh binding, which the declaration branch already sees.
    // (`for (const alias of [config])` declares a FRESH binding, which the
    // declaration branch already sees; the alias edge for either loop form is
    // formed by `bindingSources` below.)
    if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && !ts.isVariableDeclarationList(n.initializer)) {
      collectAssignmentTargets(n.initializer, rebound);
    }
    // And MUTATING what the name holds. The caller reads the object, so
    // `channelConfig.private = false` changes the answer exactly as rebinding
    // the name would — and the first version of this rule watched only the
    // rebinding, which is the same half-a-rule the property-mutation check in
    // the channel gate had before it (Codex, PR #94).
    if (ts.isBinaryExpression(n) && isAssignmentOperator(n.operatorToken.kind)) {
      collectMutatedRoots(n.left, mutated);
    }
    if (ts.isDeleteExpression(n)) collectMutatedRoots(n.expression, mutated);
    if (isObjectAssignCall(n)) {
      // `Object.assign(target, …)` writes into its FIRST argument.
      const target = n.arguments[0];
      if (target) collectMutatedRoots(target, mutated, true);
    }
    if (isEscapedObjectAssign(n)) escapedMutator = true;
    // …and a COMPUTED member of the built-in, which may be `assign` or any
    // other mutator: `Object[k](m, …)` kept `m`'s literal readable and stale
    // (measured, every computed spelling; Codex, PR #94, round 63).
    if (isComputedObjectAccess(n)) escapedMutator = true;

    ts.forEachChild(n, visit);
  };
  visit(sf);

  // The alias graph, from the ONE enumeration of binding forms. Every target
  // is linked to every identifier its source mentions — `[a] = [config]` and
  // `({ a } = { a: config })` are not matched positionally, because the right
  // side can be any expression and the matching is not always possible. That
  // OVER-links, which is the conservative direction for THIS question: it can
  // refuse a name nothing touched, never miss one that was mutated.
  // (`holdersOf`, the directed consumer of the same list, is the precise one,
  // because its consumers report on a positive answer.)
  for (const b of bindingSources(sf)) {
    const sources = new Set<string>();
    collectIdentifiers(b.source, sources);
    for (const target of b.targets) for (const source of sources) link(target, source);
  }

  // Close MUTATION over the alias graph: whichever name it was written
  // through, every name for the same object loses its literal. Rebinding is
  // deliberately not closed — see the note above.
  const queue = [...mutated];
  while (queue.length) {
    const name = queue.pop() as string;
    for (const other of aliases.get(name) ?? []) {
      if (!mutated.has(other)) {
        mutated.add(other);
        queue.push(other);
      }
    }
  }

  // An ALIAS carries the object, so it carries the literal: `const base = {…};
  // const attrs = base; <span {...attrs} />` bound `attrs` to null, the spread
  // was skipped as unresolvable and the JSX gate MISSED the element — the
  // ordinary composition pattern, one hop longer (Codex, PR #94).
  //
  // The source must be resolvable in its own right. Following a REBOUND one
  // would answer confidently and wrongly: `let base = {a}; base = {b}; const
  // attrs = base;` gives `attrs` the second object while `seen` still holds
  // the first, which is the hazard this whole map exists to avoid. Mutation is
  // already closed over the alias graph, so a mutated source has already cost
  // every name for that object its literal; the test is kept here so the rule
  // reads as one rule rather than two halves in different places.
  //
  // The guard set is the whole termination argument — a cycle is refused on
  // its second visit — so the walk carries no count. The sixteen it used to
  // stop at was not a guard but a wrong answer at seventeen: a seventeen-hop
  // alias chain resolved to nothing, which is a MISS in `form-error`'s
  // direction and a refusal in the other two (measured; Codex, PR #94, the
  // `outward` finding's class).
  const aliasLiteral = (name: string): ts.ObjectLiteralExpression | undefined => {
    const guard = new Set<string>([name]);
    let cur = aliasSource.get(name) ?? null;
    while (cur) {
      if (guard.has(cur)) return undefined;
      guard.add(cur);
      if (rebound.has(cur) || mutated.has(cur)) return undefined;
      const lit = seen.get(cur);
      if (lit) return lit;
      cur = aliasSource.get(cur) ?? null;
    }
    return undefined;
  };

  const out = new Map<string, ts.ObjectLiteralExpression>();
  if (escapedMutator) return out;
  for (const [name, lit] of seen) {
    if (rebound.has(name) || mutated.has(name)) continue;
    const resolved = lit ?? aliasLiteral(name);
    if (resolved) out.set(name, resolved);
  }
  return out;
}

/**
 * Every place a name receives a value from an in-file expression.
 *
 * This is the one place that answers "what can this name come to hold?", and
 * it is deliberately the COMPLETE set of TypeScript constructs that bind a
 * name together with a value expression, because four consecutive review
 * rounds found this rule one form short — a parameter, then an assignment,
 * then a destructuring declaration, then a parameter DEFAULT — and a fifth
 * then found the channel gate's alias resolver carrying a PARTIAL copy of it
 * (declarations only), so `let db; db = supabase; db[key](…)` opened a public
 * topic past it (Codex, PR #94, round 64). The set is:
 *
 *   VariableDeclaration   `const a = …`         initializer
 *   Parameter             `(a = …)`             initializer (the default)
 *   BindingElement        `{ a = … }`           initializer (the default)
 *   ForOf / ForIn         `for (a of …)`        the iterable
 *   assignment            `a = …`, `a ??= …`,   the right-hand side
 *                         `a ||= …`, `a &&= …`  (`isAliasFormingAssignment`)
 *
 * Nothing else in the language introduces a binding with an in-file source
 * expression: a class field, a catch clause and an import bind a name with
 * nothing here to link it to.
 *
 * Two consumers, two readings of the same list. `declaredObjects` links every
 * target to every identifier the source mentions (conservative: it may refuse
 * a name nothing touched, never miss a mutated one). `holdersOf` is directed
 * and precise, because its consumers REPORT on a positive answer and a false
 * positive there is a gate red on healthy code.
 */
export type BindingSource = {
  /** The names bound. A `whole` binding has exactly one. */
  targets: Set<string>;
  /** The expression the value comes from. */
  source: ts.Expression;
  /**
   * true when the one target holds the VALUE of `source` — `const a = e`,
   * `a = e`, a default `a = e` — and false when the targets hold PARTS of it
   * (a destructuring pattern) or its ELEMENTS (a loop).
   */
  whole: boolean;
  /**
   * The pattern, for a destructuring binding, so a consumer can match it
   * against a literal — and for a LOOP whose target is one, so each element
   * can be matched against it: `for (const [db] of [[supabase]])` binds `db`
   * to the client, which a loop entry carrying only its names could not say
   * (Codex, PR #94, round 66).
   */
  pattern?: ts.BindingName | ts.Expression;
  /**
   * A loop binding. `for…of` targets hold ELEMENTS of `source`; `for…in`
   * targets hold its KEYS — the indices of an array, the names of an object
   * — which is never a value the source carries.
   */
  loop?: "of" | "in";
  /**
   * The target identifier NODE of a whole binding, or of a loop whose target
   * is one identifier — so a consumer that resolves by SYMBOL can ask which
   * binding is this one, where the name alone cannot (`boundValues`).
   */
  node?: ts.Identifier;
};

export function bindingSources(sf: ts.SourceFile): BindingSource[] {
  const out: BindingSource[] = [];
  const add = (name: ts.BindingName, source: ts.Expression | undefined) => {
    if (!source) return;
    const targets = new Set<string>();
    bindPatternNames(name, targets);
    if (targets.size === 0) return;
    out.push(ts.isIdentifier(name) ? { targets, source, whole: true, node: name } : { targets, source, whole: false, pattern: name });
  };
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) {
      add(n.name, n.initializer);
    } else if (ts.isBinaryExpression(n) && isAliasFormingAssignment(n.operatorToken.kind)) {
      const targets = new Set<string>();
      collectAssignmentTargets(n.left, targets);
      const left = unwrapTransparent(n.left);
      if (targets.size > 0) {
        out.push(ts.isIdentifier(left)
          ? { targets, source: n.right, whole: true, node: left }
          : { targets, source: n.right, whole: false, pattern: n.left });
      }
    } else if (ts.isForOfStatement(n) || ts.isForInStatement(n)) {
      const targets = new Set<string>();
      let pattern: ts.BindingName | ts.Expression | undefined;
      let node: ts.Identifier | undefined;
      if (ts.isVariableDeclarationList(n.initializer)) {
        for (const d of n.initializer.declarations) {
          bindPatternNames(d.name, targets);
          if (ts.isIdentifier(d.name)) node = d.name;
          else pattern = d.name;
        }
      } else {
        collectAssignmentTargets(n.initializer, targets);
        const init = unwrapTransparent(n.initializer);
        if (ts.isIdentifier(init)) node = init;
        else pattern = n.initializer;
      }
      if (targets.size > 0) {
        const loop = ts.isForOfStatement(n) ? "of" : "in";
        out.push(pattern
          ? { targets, source: n.expression, whole: false, loop, pattern }
          : { targets, source: n.expression, whole: false, loop, node });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * The names that can come to HOLD one of `seeds` — the client, the global
 * `Object` — followed through every binding form, directed and transitive.
 *
 * A name holds the seed when it is bound to the seed's identifier (through the
 * transparent wrappers) by a WHOLE binding: a declaration, an assignment in
 * any alias-forming spelling, a parameter default or a binding-element
 * default. A pattern's names hold PARTS of the source and a `for…of`
 * variable holds ELEMENTS, so those are followed only where the part is
 * visible — a literal aggregate written in place, matched by position or by
 * key, with an inline literal SPREAD expanded in place (`{ ...{ db: supabase }
 * }` supplies `db`, and the last definition of a key wins, as the language
 * has it): `const [db] = [supabase]`, `({ db } = { db: supabase })`, `for
 * (const db of [...[supabase]])`. A part taken from anything else — `const {
 * data } = await supabase.from(…)` — is NOT the seed, and saying otherwise
 * would put every query result on the client's side of a gate that reports;
 * a spread of a NAME is not expanded either, stated rather than modelled,
 * since following it needs the literal map this module builds one level up
 * and would make the two readers each other's input. Such a spread — or a
 * key this reader cannot read — makes UNKNOWN every part it could affect,
 * and not knowing is not evidence that a name holds the seed: every position
 * AFTER it in an array (`const [db] = [...others, supabase]` puts `supabase`
 * at slot 0 only when `others` is empty) and every key BEFORE it in an
 * object (`{ db: supabase, ...others }` may replace `db`), at whatever depth
 * of inline literal the spread sits. An ITERATION is different in kind: `for
 * (const db of [...others, supabase])` binds `supabase` on some pass whatever
 * `others` holds, so a `for…of` variable holds every readable element and
 * only an unreadable one is passed over. A `for…in` variable holds KEYS and
 * never the seed (Codex, PR #94, round 65 — three findings in this reader,
 * each one of those rules).
 *
 * `memberHolds(receiver, key)` names a seed reached as a MEMBER of a known
 * base — `globalThis.Object` for the global `Object`, the `supabase` export
 * of a namespace import of the client module for the client — and it is
 * consulted for both spellings of that read: a member access (`const O =
 * globalThis.Object`) and a key taken off the base by a pattern (`const {
 * Object: O } = globalThis`). The first version knew the member access alone,
 * so the destructured spelling went through the pattern branch, met a
 * non-literal source and was skipped (Codex, PR #94, round 66).
 *
 * Name-based and file-wide, like `declaredObjects`: a name bound to the seed
 * anywhere in the file holds it everywhere, which over-includes a name that
 * is later rebound or shadowed. That is the reporting direction — a computed
 * member on such a name is refused rather than blessed — and every reader
 * that consumes this set states it.
 */
export function holdersOf(
  sf: ts.SourceFile,
  seeds: Iterable<string>,
  memberHolds?: MemberHolds,
): Set<string> {
  const names = new Set(seeds);
  const bound = boundValues(sf);
  const holds = (e: ts.Expression): boolean => {
    const v = unwrapTransparent(e);
    if (ts.isIdentifier(v)) return names.has(v.text);
    const m = memberAccess(v);
    return !!m && (memberHolds?.(m.receiver, m.name) ?? false);
  };
  for (let grew = true; grew;) {
    grew = false;
    for (const b of bound) {
      if (names.has(b.target.text)) continue;
      const yes = b.key === undefined ? holds(b.value) : (memberHolds?.(b.value, b.key) ?? false);
      if (yes) {
        names.add(b.target.text);
        grew = true;
      }
    }
  }
  return names;
}

/** `(receiver, key)` is a spelling of the seed — see `holdersOf`. */
export type MemberHolds = (receiver: ts.Expression, key: string) => boolean;

/**
 * One binding's hand-over: `target` receives `value` — or, with `key` set,
 * receives `value[key]`, a part taken by KEY off a NON-literal source
 * (`const { adminClient } = admin`, `const { Object: O } = globalThis`), which
 * is a member read of that source one syntactic shape over.
 */
export type BoundValue = { target: ts.Identifier; value: ts.Expression; key?: string };

/**
 * Every binding in the file as (target NODE, value), through every binding
 * form `bindingSources` enumerates and every literal-reading rule stated at
 * `holdersOf`: a whole binding hands its source over; a destructuring
 * against a literal hands each name the part at its position or key, at any
 * depth, with the spread and erasure rules of `literalElements` and
 * `literalEntries`; a `for…of` over an array literal hands its variable every
 * readable element, and a pattern target takes each element apart; a key
 * taken off a non-literal source is a member read of it (`key` set); a
 * position taken off one, and a `for…in` variable, hand nothing readable.
 *
 * The target is the identifier NODE rather than its name, so a reader that
 * resolves by SYMBOL can ask "is this binding the one I hold?" —
 * `holdersOf` consumes the same list by name. The two used to be one reader
 * and two partial copies: `discarded-errors.test.ts` followed a declaration
 * initializer and the plain assignments and nothing else, so `const [a] =
 * [admin]; a.adminClient()` with its error handled was "declared as neither
 * a client nor a value", a refusal on healthy code (Codex, PR #94, round 68)
 * — and the object, loop, parameter-default and nested spellings, and a
 * destructured client VALUE in the sibling reader, were refused the same way
 * (measured). One enumeration now, and no reader keeps its own list.
 */
export function boundValues(sf: ts.SourceFile): BoundValue[] {
  const out: BoundValue[] = [];
  for (const b of bindingSources(sf)) {
    if (b.loop) {
      // `for…in` binds KEYS — `for (const db in [supabase])` gives `db` the
      // string "0" — so nothing it binds is a value the source carries;
      // reading it as the client refused an unrelated `db[key]` on healthy
      // code (Codex, PR #94). Only `for…of` yields the elements, and an inline
      // literal spread among them is expanded like any other. A pattern
      // target takes each element APART: `for (const [db] of [[supabase]])`
      // binds `db` to the client on its one pass, and the first reader tested
      // the whole element against the seed and never matched it against the
      // pattern (Codex, PR #94, round 66) — so each element goes through the
      // same reader a declaration's source does.
      const src = unwrapTransparent(b.source);
      if (b.loop !== "of" || !ts.isArrayLiteralExpression(src)) continue;
      for (const el of literalElements(src, false)) {
        if (b.pattern) patternValues(b.pattern, el, out);
        else if (b.node) out.push({ target: b.node, value: el });
      }
    } else if (b.whole) {
      if (b.node) out.push({ target: b.node, value: b.source });
    } else if (b.pattern) {
      patternValues(b.pattern, b.source, out);
    }
  }
  return out;
}

/**
 * The parts of `source` a PATTERN hands its names, at any depth: `const
 * [[db]] = [[supabase]]` and `const { a: { db } } = { a: { db: supabase } }`
 * reach `db` through a nested pattern matched against the nested literal,
 * where the one-level reader before it bound nothing (a nested pattern was a
 * null slot). A part is read off a LITERAL source by position or by key,
 * through `literalElements` and `literalEntries` with their spread and
 * erasure rules; a key taken off a NON-literal source is a member READ of it
 * and is handed over with the key (`const { Object: O } = globalThis` is
 * `globalThis.Object` one syntactic shape over). A position taken off a
 * non-literal source has no such spelling and is not followed.
 */
function patternValues(pat: ts.BindingName | ts.Expression, source: ts.Expression, out: BoundValue[]): void {
  const src = unwrapTransparent(source);
  const elements = ts.isArrayLiteralExpression(src) ? literalElements(src, true) : null;
  const keyed = ts.isObjectLiteralExpression(src) ? literalEntries(src) : null;
  for (const entry of patternEntries(pat)) {
    let value: ts.Expression | undefined;
    if (entry.index !== undefined) {
      if (!elements) continue;
      value = elements[entry.index];
    } else if (keyed) {
      const v = keyed.get(entry.key);
      if (!v) continue;
      value = v;
    } else {
      if (ts.isIdentifier(entry.target)) out.push({ target: entry.target, value: src, key: entry.key });
      continue;
    }
    if (!value) continue;
    if (ts.isIdentifier(entry.target)) out.push({ target: entry.target, value });
    else patternValues(entry.target, value, out);
  }
}

/** One slot of a pattern: a position or a key, bound to a name or to a nested pattern. */
type PatternEntry =
  | { index: number; key?: undefined; target: ts.BindingName | ts.Expression }
  | { index?: undefined; key: string; target: ts.BindingName | ts.Expression };

/**
 * The slots of a destructuring pattern in either form — a binding pattern
 * (`const [a, { b }] = …`) or an assignment pattern (`[a, { b }] = …`, whose
 * elements are expressions, `a = d` carrying a default on the left). A hole
 * is skipped; a REST binds an array or an object of what remains, never the
 * seed, so an array rest ends the positions and an object rest is skipped;
 * a target that is a member (`[o.x] = …`) lands on an object this reader does
 * not follow and is skipped too.
 */
function patternEntries(pat: ts.BindingName | ts.Expression): PatternEntry[] {
  const out: PatternEntry[] = [];
  // A target is handed over as its NODE — an identifier, or a nested pattern
  // — so a consumer can resolve the identifier by symbol; `boundValues` is
  // the one reader, and `ts.isIdentifier` tells the two apart.
  const bindingTarget = (name: ts.BindingName): ts.BindingName => name;
  const assignmentTarget = (el: ts.Expression): ts.Expression | null => {
    const v = unwrapTransparent(el);
    const t = ts.isBinaryExpression(v) && v.operatorToken.kind === ts.SyntaxKind.EqualsToken ? unwrapTransparent(v.left) : v;
    if (ts.isIdentifier(t)) return t;
    if (ts.isArrayLiteralExpression(t) || ts.isObjectLiteralExpression(t)) return t;
    return null;
  };
  if (ts.isArrayBindingPattern(pat)) {
    pat.elements.forEach((el, index) => {
      if (!ts.isBindingElement(el) || el.dotDotDotToken) return;
      out.push({ index, target: bindingTarget(el.name) });
    });
  } else if (ts.isObjectBindingPattern(pat)) {
    for (const el of pat.elements) {
      if (el.dotDotDotToken) continue;
      const key = el.propertyName ? propertyKey(el.propertyName) : ts.isIdentifier(el.name) ? el.name.text : null;
      if (key === null) continue;
      out.push({ key, target: bindingTarget(el.name) });
    }
  } else if (ts.isArrayLiteralExpression(pat)) {
    for (let index = 0; index < pat.elements.length; index++) {
      const el = pat.elements[index]!;
      if (ts.isOmittedExpression(el)) continue;
      if (ts.isSpreadElement(el)) break;
      const target = assignmentTarget(el);
      if (target !== null) out.push({ index, target });
    }
  } else if (ts.isObjectLiteralExpression(pat)) {
    for (const p of pat.properties) {
      if (ts.isShorthandPropertyAssignment(p)) out.push({ key: p.name.text, target: p.name });
      else if (ts.isPropertyAssignment(p)) {
        const key = propertyKey(p.name);
        const target = assignmentTarget(p.initializer);
        if (key !== null && target !== null) out.push({ key, target });
      }
    }
  }
  return out;
}

/**
 * The readable elements of an array literal in order, with an inline literal
 * spread expanded in place (`[...[supabase]]` has one element, `supabase`).
 *
 * Two questions, one collector. Read POSITIONALLY — for a pattern, where a
 * name takes the element at its slot — the list ENDS at a spread this reader
 * cannot expand: every position after `[...others, supabase]` depends on how
 * many elements `others` has, and reading the spread as zero-width would put
 * `supabase` at slot 0 with confidence (the plausible wrong reading, which
 * the first version of this collector took one nesting level down: an inline
 * literal that met such a spread returned what it had and the OUTER walk
 * carried on, so `[...[...others], supabase]` still read `supabase` at 0).
 * The end propagates out of every nested literal now. Read as an ITERATION
 * — for `for…of`, where the variable takes EVERY element in turn — an
 * unexpandable spread is passed over and the elements after it are still
 * reached, because `for (const db of [...others, supabase])` binds
 * `supabase` on some pass whatever `others` holds; the positional rule
 * applied there was a MISS on a shape the pre-round-65 reader got right
 * (measured, both directions).
 */
function literalElements(arr: ts.ArrayLiteralExpression, positional: boolean): ts.Expression[] {
  const out: ts.Expression[] = [];
  collectElements(arr, positional, out);
  return out;
}

/** Appends `arr`'s readable elements to `out`; false once positions stopped being knowable. */
function collectElements(arr: ts.ArrayLiteralExpression, positional: boolean, out: ts.Expression[]): boolean {
  for (const el of arr.elements) {
    if (ts.isSpreadElement(el)) {
      const inner = unwrapTransparent(el.expression);
      if (ts.isArrayLiteralExpression(inner)) {
        if (!collectElements(inner, positional, out)) return false;
      } else if (positional) return false;
    } else out.push(el);
  }
  return true;
}

/**
 * The readable entries of an object literal, LAST definition winning, with an
 * inline literal spread expanded in place — `{ ...{ db: supabase } }` supplies
 * `db` (Codex, PR #94, round 65). An accessor or a method defines its key with
 * a function body, so it overrides an earlier value with nothing this reader
 * can hold. A spread of anything but an inline literal, or a member whose key
 * this reader cannot read, may define ANY key, so it ERASES every entry before
 * it — `{ db: supabase, ...others }` and `{ db: supabase, [k]: other }` hold
 * nothing readable, while `{ ...others, db: supabase }` still holds `db`,
 * the last definition winning as the language has it. That is the mirror of
 * the positional rule in `literalElements`: an unreadable member makes
 * unknown whatever it could affect, which for an array is every position
 * after it and for an object every key before it. The first version of this
 * reader left the earlier entries standing, the over-inclusion direction,
 * which disagreed with the array reader one function up and with
 * `resolveProperty`'s own erasing rule for the same question.
 *
 * One map, shared down the recursion, so an erasure inside a nested inline
 * literal (`{ db: supabase, ...{ ...others } }`) reaches the entries the
 * outer literal had already read.
 */
function literalEntries(obj: ts.ObjectLiteralExpression): Map<string, ts.Expression | null> {
  const entries = new Map<string, ts.Expression | null>();
  collectEntries(obj, entries);
  return entries;
}

function collectEntries(obj: ts.ObjectLiteralExpression, entries: Map<string, ts.Expression | null>): void {
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) {
      const inner = unwrapTransparent(p.expression);
      if (ts.isObjectLiteralExpression(inner)) collectEntries(inner, entries);
      else entries.clear();
      continue;
    }
    if (ts.isShorthandPropertyAssignment(p)) {
      entries.set(p.name.text, p.name);
      continue;
    }
    const key = propertyKey(p.name);
    if (key === null) {
      entries.clear();
      continue;
    }
    if (ts.isPropertyAssignment(p)) entries.set(key, p.initializer);
    else if (definesWithoutValue(p)) entries.set(key, null);
  }
}

/** The names a binding pattern introduces. */
function bindPatternNames(nm: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(nm)) {
    into.add(nm.text);
    return;
  }
  for (const el of nm.elements) if (ts.isBindingElement(el)) bindPatternNames(el.name, into);
}

/** Every identifier an expression mentions, however deeply. */
function collectIdentifiers(e: ts.Expression, into: Set<string>): void {
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) into.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(e);
}

/**
 * The assignments that make two names one object: `=` and the LOGICAL forms.
 *
 * `a ??= config` assigns `config` when it runs, so it forms an alias exactly as
 * `a = config` does. It is not, however, a definite REBINDING — see
 * `isDefiniteRebinding`, which is why the two questions have different
 * predicates. The first version of this said so in a comment and then used one
 * predicate for both, which is the defect the comment described (Codex,
 * PR #94).
 */
export function isAliasFormingAssignment(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken
  );
}

/**
 * The assignments that definitely REPLACE what a name holds.
 *
 * `??=` and `||=` are excluded, and the reason is a property of this map
 * rather than a guess about control flow: a name is only ever IN it when its
 * declaration initializer is an OBJECT LITERAL, which is both non-nullish and
 * truthy — so neither of those operators can assign to such a name, and
 * treating them as a rebinding threw away a literal the program still holds.
 * `&&=` is the mirror: a truthy left side means it ALWAYS assigns, so it is a
 * definite rebinding. Every other compound operator (`+=` and friends)
 * replaces the value with something that is not the object, and counts.
 */
function isDefiniteRebinding(kind: ts.SyntaxKind): boolean {
  if (
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken
  ) {
    return false;
  }
  return isAssignmentOperator(kind);
}

/**
 * An object-literal member that DEFINES a property without a readable value:
 * `get x() {…}`, `set x(v) {…}`, `x() {…}`.
 *
 * A getter overrides whatever a spread before it supplied, and what it returns
 * is a function body rather than a literal — so a reader that skips these
 * reports the SPREAD's value for a key the object no longer carries, which is
 * a confidently wrong answer rather than an absent one (Codex, PR #94:
 * `{ ...base, get private() { return false; } }` read as private).
 *
 * The two gates differ only in how they say "no answer", so this names the
 * shape and each records its own marker.
 */
export function definesWithoutValue(
  p: ts.ObjectLiteralElementLike,
): p is ts.GetAccessorDeclaration | ts.SetAccessorDeclaration | ts.MethodDeclaration {
  return ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p) || ts.isMethodDeclaration(p);
}

/**
 * The effective value of `name` on an object literal, resolved in SOURCE
 * ORDER — the last member that defines the key wins, exactly as the language
 * does it.
 *
 *   undefined   no member defines it
 *   null        a member may define it and this reader cannot say what
 *   Expression  the last readable definition
 *
 * THE ORDER IS THE POINT. A reader that collects uncertainty in a flag and
 * consults it at the end answers the same thing for `{ ...shared, methods: [
 * "POST"] }` and `{ methods: ["POST"], ...shared }`, and only the second of
 * those is uncertain — measured in node, the first really does carry
 * `["POST"]`. `verify-deployment.test.ts`'s `refusesGet` was the last reader
 * in this family doing that, and it refused six healthy shapes: an earlier
 * spread, an earlier computed key, an earlier accessor on another key, and a
 * shorthand naming another key (Codex, PR #94 — a gate red on a healthy tree,
 * the worst shape these files record). Its two siblings already resolved in
 * order, which is what said the defect was confined to one of them, and this
 * is the walk they now share so there is no third copy to forget.
 *
 * `spreadErases` is the one genuine difference between the callers and it is
 * a difference of DIRECTION, not of order. A spread this reader cannot follow
 * could define anything:
 *
 *   - Asking "does this refuse GET?", not knowing is not evidence of POST-only,
 *     so it must erase an earlier answer (true, the default).
 *   - Asking "is this a raw live region?", not knowing must not UN-FLAG an
 *     element already carrying `role="alert"` — refusing to un-flag is the
 *     safe direction there (false, which `form-error.test.ts` passes).
 *
 * A member that NAMES the key is uncertain for both callers whichever way
 * that knob is set: a shorthand carries a reference, an accessor answers a
 * function body, and a computed key this reader cannot read could BE this
 * name. Only the blanket case differs.
 *
 * `realtime-channel.test.ts` keeps its own walk and is the stated residual:
 * `effectiveProps` answers four keys at once, tracks which of them a member
 * NAMED, and carries a typed marker per cause into its failure messages, so
 * it is a different question rather than a second copy of this one. It has
 * resolved in source order since the round that gave it spreads, and both
 * files pin that with fixtures.
 */
export function resolveProperty(
  obj: ts.ObjectLiteralExpression,
  name: string,
  declared: Map<string, ts.ObjectLiteralExpression> = new Map(),
  spreadErases = true,
  path: ReadonlySet<ts.ObjectLiteralExpression> = new Set(),
): ts.Expression | null | undefined {
  // The literals this walk is already inside. A spread that re-enters one is
  // a CYCLE — `var a: any = { ...a, methods: ["POST"] }` is legal and runs
  // (the hoisted name is still `undefined` when the literal is evaluated, so
  // the spread contributes nothing) — and is followed nowhere: it is
  // unresolvable, the answer an unfollowable spread already gets. This set is
  // the termination argument. The `depth < 8` it replaces was not one: a
  // spread nested nine deep was refused here and MISSED in `form-error`'s
  // direction, and a cycle terminated only by the accident of the count
  // (measured; Codex, PR #94, the `outward` finding's class).
  const inside = new Set(path).add(obj);
  let value: ts.Expression | null | undefined;
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) {
      const inner = unwrapTransparent(p.expression);
      const from = ts.isObjectLiteralExpression(inner)
        ? inner
        : ts.isIdentifier(inner)
          ? declared.get(inner.text)
          : undefined;
      if (from && !inside.has(from)) {
        const nested = resolveProperty(from, name, declared, spreadErases, inside);
        if (nested !== undefined) value = nested;
      } else if (spreadErases) value = null;
      continue;
    }
    if (ts.isShorthandPropertyAssignment(p)) {
      // `{ methods }` carries a reference this reader cannot resolve — and
      // one naming ANOTHER key does not touch this one, which the flag-based
      // reader could not say.
      if (p.name.text === name) value = null;
      continue;
    }
    if (definesWithoutValue(p)) {
      const key = propertyKey(p.name);
      if (key === null || key === name) value = null;
      continue;
    }
    if (!ts.isPropertyAssignment(p)) continue;
    const key = propertyKey(p.name);
    if (key === name) value = p.initializer;
    // A key this reader cannot resolve could BE this name, so it replaces the
    // answer with "no answer" rather than being passed over.
    else if (key === null) value = null;
  }
  return value;
}

/**
 * Does this expression statically evaluate to `undefined`?
 *
 * An optional parameter with a DEFAULT INITIALIZER treats an explicit
 * `undefined` exactly as an omitted argument, and `??` treats an `undefined`
 * property exactly as an absent one. So both of these are byte-for-byte the
 * POST-only default that makes `serveFunction` read-only:
 *
 *     serveFunction(handle, undefined)        // _lib/http.ts:258, `= {}`
 *     serveFunction(handle, { methods: undefined })  // :294, `?? DEFAULT_METHODS`
 *
 * A reader that files either under "a value I cannot read" refuses a healthy
 * call and demands a bespoke production contract for it — a gate red on a
 * healthy tree, the worst shape this file records (Codex, PR #94).
 *
 * `void <anything>` is `undefined` whatever its operand evaluates to, so the
 * VALUE is static even where the operand is not.
 *
 * THE IDENTIFIER IS RESOLVED, not matched by name. `undefined` is not a
 * reserved word, and the claim this first shipped with — that TypeScript
 * refuses to bind it at all — is FALSE:
 *
 *     import { wideOpen as undefined } from "./opts.ts";
 *     serveFunction(handle, undefined);   // admits GET
 *
 * That typechecks, and a `.ts` specifier is exactly how these Deno functions
 * import, so the form is reachable in the very files this reads (Codex, PR
 * #94). A name-only check called that the POST-only default and the deploy
 * probe would then fire an unauthenticated production GET at a handler that
 * runs: the gate blessing what it forbids, the worse direction.
 *
 * The second version of this comment then over-corrected, and that is worth
 * recording because it is the same mistake one step down: it said the
 * DECLARATION spellings are refused, which is true only in a SCRIPT. A file
 * with no import or export declares into the global scope, where `let
 * undefined` really does collide (TS2397) — but every file these gates read is
 * a MODULE, and there `let`, `const`, `var`, `function`, `namespace` and both
 * destructuring forms are all ACCEPTED (measured, both contexts). Only `class`
 * (TS2414) and `enum` (TS2431) are refused, and those are refused in a module
 * too, because the restriction is on the NAME rather than on redeclaring a
 * global. So the import alias is not the one reachable form, it is merely the
 * one that is reachable in both; the resolution below already covered the
 * rest, and only the account of why was wrong.
 *
 * So a file that binds the name anywhere gets no answer here, which sends its
 * function to a reviewed `contract_for` case. Conservative by construction:
 * the cost of a false refusal is one recorded reading, the cost of a false
 * acceptance is a live GET. The binding forms are the set this module's
 * `bindingSources` header already enumerates, plus the import clause, which
 * binds a name with no in-file source expression; a form outside that set
 * would be a MISS, which is why the enumeration is the documented one rather
 * than a fresh list. `void <anything>` involves no identifier and is
 * unconditional.
 */
export function isExplicitUndefined(e: ts.Expression): boolean {
  const cur = unwrapTransparent(e);
  if (ts.isVoidExpression(cur)) return true;
  if (!ts.isIdentifier(cur) || cur.text !== "undefined") return false;
  return !bindsName(cur.getSourceFile(), "undefined");
}

const SHADOWED = new WeakMap<ts.SourceFile, Map<string, boolean>>();
const GLOBAL_HOLDERS = new WeakMap<ts.SourceFile, Map<string, Set<string>>>();

/**
 * Is this identifier the GLOBAL `name` — spelled as itself, or as a name that
 * came to hold it? `const O = Object; O.assign(m, …)` mutates `m` exactly as
 * `Object.assign` does, and a receiver matched by its spelling alone kept the
 * literal readable and stale, in every alias form (measured; Codex, PR #94,
 * round 64 — the channel gate's assignment-alias finding, in this predicate).
 * The global must be unbound in the file, whichever spelling reaches it.
 */
function isGlobal(sf: ts.SourceFile, id: ts.Identifier, name: "Object" | "globalThis"): boolean {
  const bound = bindsName(sf, name);
  if (!bound && id.text === name) return true;
  let perFile = GLOBAL_HOLDERS.get(sf);
  if (!perFile) GLOBAL_HOLDERS.set(sf, (perFile = new Map()));
  let holders = perFile.get(name);
  if (!holders) {
    // The global `Object` has a second spelling, `globalThis.Object`, so a
    // name bound to THAT holds it too: `const O = globalThis.Object;
    // O.assign(m, …)` was read as no mutation because the source is a member
    // access and not an identifier (Codex, PR #94, round 65), and `const {
    // Object: O } = globalThis` the same one shape over (round 66).
    // `globalThis` itself has no second spelling this reader knows.
    //
    // The SPELLING seeds the set only while the file leaves it unbound: a
    // file that binds `Object` has said the word means something else there
    // (round 42), but what it bound it TO still decides — `const { Object } =
    // globalThis` binds the name to the very global it names, and that
    // `Object.assign(m, …)` is the built-in.
    const member = name === "Object" ? objectMemberHolds(sf) : undefined;
    perFile.set(name, (holders = holdersOf(sf, bound ? [] : [name], member)));
  }
  return holders.has(id.text);
}

/**
 * The `Object` member of the global `globalThis`, or of any name that holds
 * it — `globalThis.Object`, `globalThis["Object"]`, `const { Object: O } =
 * globalThis`. One predicate for that spelling, consumed by the receiver
 * test AND by the holders of `Object` (as its `memberHolds`), so the two
 * cannot disagree about what reaches the built-in.
 */
function objectMemberHolds(sf: ts.SourceFile): MemberHolds {
  return (receiver, key) => {
    if (key !== "Object") return false;
    const base = unwrapTransparent(receiver);
    return ts.isIdentifier(base) && isGlobal(sf, base, "globalThis");
  };
}
function isGlobalObjectMember(sf: ts.SourceFile, e: ts.Expression): boolean {
  const outer = memberAccess(unwrapTransparent(e));
  return !!outer && objectMemberHolds(sf)(outer.receiver, outer.name);
}

/**
 * Does anything in this file bind `name` as a VALUE?
 *
 * One scan for every global these gates read by name, because a name-only test
 * for one of them was wrong for the same reason as a name-only test for the
 * next: `undefined` (the POST-only default) and `Object` (the built-in
 * `assign`) are both ordinary identifiers a module may bind, and a gate that
 * asks the name alone answers about a global the file cannot even reach.
 *
 * TYPE space is not a binding here, and the first version of this comment said
 * so while the code counted it anyway (Codex, PR #94). `interface Object {}`
 * and `type Object = …` were never in the branch list; a TYPE-ONLY IMPORT was,
 * so `import type { Helper as Object } from "./dep.ts"` — which typechecks, and
 * `import type` appears throughout the trees these gates read — made a real
 * `Object.assign(config, …)` invisible as a mutation and left the realtime gate
 * reading a stale `private: true`: the gate blessing what it forbids. The same
 * alias named `undefined` refuses a healthy `serveFunction(handle, undefined)`
 * and demands a bespoke production contract for it: a gate red on a healthy
 * tree. Both measured against the shipped predicate, all four spellings —
 * a type-only clause, an inline `{ type X as … }` specifier, a type-only
 * default, a type-only namespace.
 *
 * An AMBIENT declaration is the same class and was found by checking the
 * sibling rather than the site reported: `declare const Object: …` and
 * `declare function Object(…)` bind a name for the CHECKER and emit nothing,
 * so the runtime `Object` is still the global. Measured by emit rather than
 * reasoned about — the compiled module calls the global and mutating through
 * it really does change the object (`{"private":false}` when run). Neither
 * form is skipped merely by name: the scan stops descending into it, because
 * everything inside an ambient declaration is ambient too.
 *
 * RESIDUAL, stated rather than chased: a namespace whose body declares only
 * types emits nothing either (measured — `namespace Object { export type A = 1 }`
 * compiles away, while a namespace with a function emits a real binding), and
 * this still counts it as a binding. Deciding otherwise means implementing
 * TypeScript's "instantiated module" rule, including declaration merging, for
 * a form that occurs NOWHERE in the trees these gates read (measured: zero
 * `namespace`/`module`/`declare` in `app/src` and `supabase/functions`) — the
 * epicycle this repository's stopping rule is about. It is pinned as a test so
 * that changing it is a decision somebody makes, and the direction is named
 * rather than called conservative: it errs toward a MISS on the mutation rule.
 *
 * The forms are the set `bindingSources` enumerates, plus the import clause,
 * which binds a value name with no in-file source expression. A CATCH CLAUSE
 * binds one too — `catch (Object) {}` typechecks, measured — and needs no
 * branch of its own: `CatchClause.variableDeclaration` IS a
 * `VariableDeclaration` and `forEachChild` walks into it, so the first branch
 * already sees it. Measured, and a branch for it added and then deleted when
 * removing it changed no verdict: a guard nothing can distinguish from its
 * absence is a rule with nothing behind it. The fixture for the form stays,
 * because what must keep holding is the ANSWER, not the route to it.
 */
function bindsName(sf: ts.SourceFile, name: string): boolean {
  let perFile = SHADOWED.get(sf);
  if (!perFile) SHADOWED.set(sf, (perFile = new Map()));
  const cached = perFile.get(name);
  if (cached !== undefined) return cached;

  let found = false;
  const names = new Set<string>();
  const named = (n: ts.Node | undefined): boolean =>
    !!n && ts.isIdentifier(n) && n.text === name;

  const visit = (n: ts.Node): void => {
    if (found) return;
    // Declares no VALUE, so the runtime name is whatever it was — the global,
    // for the two this scan is asked about. Both stop the descent as well as
    // the binding: a type-only clause's specifiers and an ambient block's
    // contents are type-only and ambient in turn.
    if (declaresNoValue(n)) return;
    if (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) {
      names.clear();
      bindPatternNames(n.name, names);
      if (names.has(name)) {
        found = true;
        return;
      }
    } else if (
      ts.isFunctionDeclaration(n)
      || ts.isFunctionExpression(n)
      || ts.isClassDeclaration(n)
      || ts.isClassExpression(n)
      || ts.isEnumDeclaration(n)
      || ts.isModuleDeclaration(n)
      || ts.isImportClause(n)
      || ts.isImportSpecifier(n)
      || ts.isNamespaceImport(n)
      || ts.isImportEqualsDeclaration(n)
    ) {
      if (named(n.name)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };

  visit(sf);
  perFile.set(name, found);
  return found;
}

/**
 * Does this node introduce a name the CHECKER knows and the runtime does not?
 *
 * Two forms, each measured rather than reasoned about (see `bindsName`): a
 * type-only import, and any declaration carrying `declare`. `ImportClause`,
 * `ImportSpecifier` and `ImportEqualsDeclaration` each carry their own
 * `isTypeOnly`; a `NamespaceImport` does not, and needs none, because its
 * clause is skipped before the walk reaches it.
 */
function declaresNoValue(n: ts.Node): boolean {
  if (
    (ts.isImportClause(n) || ts.isImportSpecifier(n) || ts.isImportEqualsDeclaration(n))
    && n.isTypeOnly
  ) {
    return true;
  }
  return isDeclarationLike(n)
    && (ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Ambient) !== 0;
}

/** The declaration kinds `bindsName` inspects, narrowed for `getCombinedModifierFlags`. */
function isDeclarationLike(n: ts.Node): n is ts.Declaration {
  return ts.isVariableDeclaration(n)
    || ts.isParameter(n)
    || ts.isBindingElement(n)
    || ts.isFunctionDeclaration(n)
    || ts.isFunctionExpression(n)
    || ts.isClassDeclaration(n)
    || ts.isClassExpression(n)
    || ts.isEnumDeclaration(n)
    || ts.isModuleDeclaration(n)
    || ts.isImportClause(n)
    || ts.isImportSpecifier(n)
    || ts.isNamespaceImport(n)
    || ts.isImportEqualsDeclaration(n);
}

/** Every assignment operator, `=` and the compound ones alike. */
export function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    (kind >= ts.SyntaxKind.FirstCompoundAssignment && kind <= ts.SyntaxKind.LastCompoundAssignment)
  );
}

/**
 * A call to the BUILT-IN `Object.assign`, which writes into its first argument.
 *
 * The receiver matters, and the first version of this rule ignored it: any
 * `.assign(…)` counted, so an unrelated `registry.assign(channelConfig)` made
 * an immutable literal unresolvable and the gate red on healthy code (Codex,
 * PR #94).
 *
 * `Object` and `globalThis` are then RESOLVED rather than matched by name, for
 * the reason `isExplicitUndefined` resolves its own: both are ordinary
 * identifiers a module may bind, and TypeScript accepts every form of it —
 * `const`/`let`/`var`, `function`, `class`, `enum`, `namespace`, an import
 * alias, a parameter and a catch clause, all measured, where the same forms
 * for `undefined` are refused. A module that binds one, say
 * `const Object = { assign(_value: unknown) {} }`, calls something of its own
 * and reaches no global at all, and reading that as the built-in invalidated
 * an unchanged private-channel literal: the gate RED ON A HEALTHY TREE, the
 * worst shape this file records (Codex, PR #94). The `globalThis.Object`
 * spelling is the same defect one identifier over — `const globalThis = { … }`
 * typechecks too — and its own binding is the one that decides it, since a
 * local `Object` cannot shadow a PROPERTY of the global object.
 *
 * The residual is stated rather than chased: the scan is file-wide, so a file
 * that binds the name in a NESTED scope and calls the real built-in outside it
 * under-reports that mutation. That needs a scope model, which this module
 * deliberately does not have, and it is the narrower hazard of the two — it
 * takes a shadow AND a genuine built-in call in one file, where the red needs
 * only the shadow. No file either gate reads binds either name today (294
 * scanned, 0 hits), so the rule costs nothing now.
 */
export function isObjectAssignAccess(access: ts.Node): boolean {
  return objectBuiltinMember(access) === "assign";
}

/**
 * A COMPUTED member of the built-in `Object`, in any position — `Object[k](m,
 * …)`, `Object[pick()](…)`, `const f = Object[k]`.
 *
 * It may be `assign`, or `defineProperty`, or any other mutator, and nothing
 * here can say which — so it gets the answer an ESCAPED `Object.assign`
 * already gets: some object may be written, and a reader of literals must
 * refuse rather than read one that may be stale. `const k: "assign" =
 * "assign"; Object[k](msg, { private: false })` mutates exactly as the direct
 * call does, and every computed spelling left `declaredObjects` holding the
 * stale `private: true` and `mutations()` reporting nothing (measured: 11 of
 * 11 green with it planted in `broadcast.ts`; Codex, PR #94, the client's
 * `supabase[key]` finding in this module's own predicate).
 *
 * This REVERSES the round-55 pin that `Object[k](m, …)` is silent. That pin
 * was right that a computed key is not a NAME — reading the subscript's text
 * would call `Object[assign]` the built-in while the program calls whatever
 * the variable holds — and wrong that it is therefore no member. Not guessing
 * which member and not reading it as none are different rules; this is the
 * second. The scanned trees carry no computed access on `Object` at all
 * (measured), so the conservative reading costs nothing today.
 */
export function isComputedObjectAccess(n: ts.Node): boolean {
  return objectBuiltinMember(n) === null;
}

/**
 * Which member of the BUILT-IN `Object` an access reaches: its name, null
 * when the key is computed and could therefore be any of them, and undefined
 * when the receiver is not the resolved global at all. One reader for both
 * spellings of the receiver and both kinds of key, so `isObjectAssignAccess`
 * and `isComputedObjectAccess` cannot disagree about what `Object` is.
 */
function objectBuiltinMember(access: ts.Node): string | null | undefined {
  const member = memberAccess(access);
  const hop = member ?? computedAccess(access);
  if (!hop) return undefined;
  const sf = access.getSourceFile();
  const receiver = unwrapTransparent(hop.receiver);
  // `Object.assign`, `globalThis.Object.assign`, `globalThis["Object"]["assign"]`
  // and every alias of either spelling are the same call; the receiver is read
  // by the same two helpers the holders set is built from.
  const builtin = ts.isIdentifier(receiver) ? isGlobal(sf, receiver, "Object") : isGlobalObjectMember(sf, receiver);
  if (!builtin) return undefined;
  return member ? member.name : null;
}

export function isObjectAssignCall(n: ts.Node): n is ts.CallExpression {
  if (!ts.isCallExpression(n)) return false;
  const callee = calleeOf(n);
  return callee !== null && isObjectAssignAccess(callee);
}

/**
 * A reference to the built-in `Object.assign` that is NOT invoked here.
 *
 * `Object.assign.call(null, c, {})` mutates `c` exactly as the direct call
 * does, and `const f = Object.assign` hands the mutator to a name this module
 * cannot follow. Either way SOME object may be written and nothing here can
 * say which, so the caller invalidates every literal rather than reading one
 * that may already be stale — the same conservative answer a mutation through
 * an unresolved name gets.
 */
export function isEscapedObjectAssign(n: ts.Node): boolean {
  return isObjectAssignAccess(n) && calleeCall(n) === null;
}

/**
 * The identifier at the ROOT of a member chain, when the chain is being
 * written to — `a.b.c = x`, `a["b"] = x`, `delete a.b`, `Object.assign(a, …)`.
 *
 * `direct` is for the `Object.assign` case, where the target is the object
 * itself rather than a member of it.
 */
function collectMutatedRoots(e: ts.Expression, into: Set<string>, direct = false): void {
  let cur: ts.Expression = unwrapTransparent(e);
  if (!direct) {
    const target = memberTarget(cur);
    if (!target) return;
    cur = target;
    while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
      cur = unwrapTransparent(cur.expression);
    }
  }
  if (ts.isIdentifier(cur)) into.add(cur.text);
}

/** The identifiers an assignment's left-hand side writes to. */
function collectAssignmentTargets(left: ts.Expression, into: Set<string>): void {
  const target = unwrapTransparent(left);
  if (ts.isIdentifier(target)) {
    into.add(target.text);
    return;
  }
  if (ts.isObjectLiteralExpression(target)) {
    for (const p of target.properties) {
      if (ts.isShorthandPropertyAssignment(p)) into.add(p.name.text);
      else if (ts.isPropertyAssignment(p)) collectAssignmentTargets(p.initializer, into);
      else if (ts.isSpreadAssignment(p)) collectAssignmentTargets(p.expression, into);
    }
    return;
  }
  if (ts.isArrayLiteralExpression(target)) {
    for (const el of target.elements) {
      if (ts.isSpreadElement(el)) collectAssignmentTargets(el.expression, into);
      else collectAssignmentTargets(el, into);
    }
  }
}
