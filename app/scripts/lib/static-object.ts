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
 * `as`, `satisfies`, parentheses and `!` hand the same value through.
 *
 * React receives the same literal through every one of them and so does
 * Realtime, so a reader that stops at the wrapper either calls a static value
 * dynamic (a miss) or calls a private option non-private (a gate red on a
 * healthy tree, which is the worse of the two).
 */
export function unwrapTransparent(e: ts.Expression): ts.Expression {
  let cur = e;
  for (let i = 0; i < 8; i += 1) {
    if (
      ts.isAsExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isParenthesizedExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isTypeAssertionExpression(cur)
    ) {
      cur = cur.expression;
      continue;
    }
    return cur;
  }
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
  let cur: ts.Node = node;
  for (let i = 0; i < 8; i += 1) {
    const parent: ts.Node | undefined = cur.parent;
    if (!parent) return null;
    if (ts.isCallExpression(parent)) return parent.expression === cur ? parent : null;
    if (
      (ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isTypeAssertionExpression(parent)) &&
      parent.expression === cur
    ) {
      cur = parent;
      continue;
    }
    return null;
  }
  return null;
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
  const { linkBinding, linkNames } = makeLinkBinding(link);

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
        if (aliasOf) link(n.name.text, aliasOf);
      } else bindPattern(n.name);
      linkBinding(n.name, n.initializer);
    } else if (ts.isParameter(n) || ts.isBindingElement(n)) {
      bindPattern(n.name);
      // A DEFAULT is a source expression like any other: `function m(alias =
      // config)` and `const { a = config } = o` both let `alias` hold the same
      // object, so a mutation through it reaches `config`.
      linkBinding(n.name, n.initializer);
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
    // ALIASING is a separate question from rebinding and therefore a separate
    // block, which the first version of this got wrong by nesting one inside
    // the other: excluding `??=` from rebinding then silently excluded it from
    // the alias graph too, so `let a; a ??= config; a.private = false;` stopped
    // invalidating `config` — caught by this file's own fixtures rather than by
    // review, which is what they are for.
    //
    // `a = config` makes the two names one object from here on, and so does
    // `[a] = [config]` or `({ a } = { a: config })`. Rather than match a
    // destructuring pattern positionally (the right side can be any
    // expression, so the matching is not always possible), every target is
    // linked to every identifier the right side mentions. That OVER-links,
    // which is the conservative direction: it can refuse a name nothing
    // touched, never miss one that was mutated.
    if (ts.isBinaryExpression(n) && isAliasFormingAssignment(n.operatorToken.kind)) {
      const targets = new Set<string>();
      collectAssignmentTargets(n.left, targets);
      const sources = new Set<string>();
      collectIdentifiers(n.right, sources);
      for (const target of targets) for (const source of sources) link(target, source);
    }
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
    if (ts.isForOfStatement(n) || ts.isForInStatement(n)) {
      if (!ts.isVariableDeclarationList(n.initializer)) {
        collectAssignmentTargets(n.initializer, rebound);
        const targets = new Set<string>();
        collectAssignmentTargets(n.initializer, targets);
        linkNames(targets, n.expression);
      } else {
        // `for (const alias of [config])` declares a FRESH binding — so it
        // does not shadow-invalidate `config`, which the declaration branch
        // already handles — but `alias` holds the same object, so a mutation
        // through it must still reach `config`.
        const targets = new Set<string>();
        for (const d of n.initializer.declarations) bindPatternNames(d.name, targets);
        linkNames(targets, n.expression);
      }
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

    ts.forEachChild(n, visit);
  };
  visit(sf);

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
  const aliasLiteral = (name: string): ts.ObjectLiteralExpression | undefined => {
    const guard = new Set<string>([name]);
    let cur = aliasSource.get(name) ?? null;
    for (let i = 0; cur && i < 16; i += 1) {
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
 * Link every name a binding introduces to every identifier its SOURCE mentions.
 *
 * This is the one place that answers "what can this name come to hold?", and
 * it is deliberately the COMPLETE set of TypeScript constructs that bind a
 * name together with a value expression, because four consecutive review
 * rounds found this rule one form short — a parameter, then an assignment,
 * then a destructuring declaration, then a parameter DEFAULT. The set is:
 *
 *   VariableDeclaration   `const a = …`         initializer
 *   Parameter             `(a = …)`             initializer (the default)
 *   BindingElement        `{ a = … }`           initializer (the default)
 *   ForOf / ForIn         `for (a of …)`        the iterable
 *   assignment `=`        `a = …`               the right-hand side
 *
 * Nothing else in the language introduces a binding with an in-file source
 * expression: a class field, a catch clause and an import bind a name with
 * nothing here to link it to. Conservative by construction — every target to
 * every identifier the source mentions, not a positional match — so it can
 * refuse a name nothing touched and can never miss one that was mutated.
 */

/** The names a binding pattern introduces. */
function bindPatternNames(nm: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(nm)) {
    into.add(nm.text);
    return;
  }
  for (const el of nm.elements) if (ts.isBindingElement(el)) bindPatternNames(el.name, into);
}

/** Link a binding's names to the identifiers its source expression mentions. */
function makeLinkBinding(
  link: (a: string, b: string) => void,
): {
  linkBinding: (name: ts.BindingName, source: ts.Expression | undefined) => void;
  linkNames: (targets: Set<string>, source: ts.Expression) => void;
} {
  const linkNames = (targets: Set<string>, source: ts.Expression) => {
    if (targets.size === 0) return;
    const sources = new Set<string>();
    collectIdentifiers(source, sources);
    for (const target of targets) for (const s of sources) link(target, s);
  };
  return {
    linkNames,
    linkBinding: (name, source) => {
      if (!source) return;
      const targets = new Set<string>();
      bindPatternNames(name, targets);
      linkNames(targets, source);
    },
  };
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
function isAliasFormingAssignment(kind: ts.SyntaxKind): boolean {
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
  depth = 0,
): ts.Expression | null | undefined {
  let value: ts.Expression | null | undefined;
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) {
      const inner = unwrapTransparent(p.expression);
      const from = ts.isObjectLiteralExpression(inner)
        ? inner
        : ts.isIdentifier(inner)
          ? declared.get(inner.text)
          : undefined;
      if (from && depth < 8) {
        const nested = resolveProperty(from, name, declared, spreadErases, depth + 1);
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
  if (!ts.isPropertyAccessExpression(access)) return false;
  if (access.name.text !== "assign") return false;
  const sf = access.getSourceFile();
  const receiver = unwrapTransparent(access.expression);
  if (ts.isIdentifier(receiver)) {
    return receiver.text === "Object" && !bindsName(sf, "Object");
  }
  return (
    ts.isPropertyAccessExpression(receiver) &&
    receiver.name.text === "Object" &&
    ts.isIdentifier(receiver.expression) &&
    receiver.expression.text === "globalThis" &&
    !bindsName(sf, "globalThis")
  );
}

export function isObjectAssignCall(n: ts.Node): n is ts.CallExpression {
  return ts.isCallExpression(n) && isObjectAssignAccess(n.expression);
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
    if (!ts.isPropertyAccessExpression(cur) && !ts.isElementAccessExpression(cur)) return;
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
