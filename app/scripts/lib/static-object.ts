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

  const bind = (name: string, lit: ts.ObjectLiteralExpression | null) => {
    seen.set(name, seen.has(name) ? null : lit);
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
        bind(n.name.text, init && ts.isObjectLiteralExpression(init) ? init : null);
        if (init && ts.isIdentifier(init)) link(n.name.text, init.text);
      } else bindPattern(n.name);
      linkBinding(n.name, n.initializer);
    } else if (ts.isParameter(n) || ts.isBindingElement(n)) {
      bindPattern(n.name);
      // A DEFAULT is a source expression like any other: `function m(alias =
      // config)` and `const { a = config } = o` both let `alias` hold the same
      // object, so a mutation through it reaches `config`.
      linkBinding(n.name, n.initializer);
    } else if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) {
      bind(n.name.text, null);
    } else if (ts.isImportSpecifier(n) || ts.isImportClause(n) || ts.isNamespaceImport(n)) {
      if (n.name && ts.isIdentifier(n.name)) bind(n.name.text, null);
    } else if (ts.isCatchClause(n) && n.variableDeclaration) {
      bindPattern(n.variableDeclaration.name);
    }

    // Rebinding the NAME: `x = …`, every compound form, and `x++`. A
    // destructuring assignment target counts too.
    if (ts.isBinaryExpression(n) && isAssignmentOperator(n.operatorToken.kind)) {
      collectAssignmentTargets(n.left, rebound);
      // `a = config` also makes the two names one object from here on — and so
      // does `[a] = [config]` or `({ a } = { a: config })`, which the first
      // version of this edge did not see. Rather than match a destructuring
      // pattern positionally (the right side can be any expression, so the
      // matching is not always possible), every target is linked to every
      // identifier the right side mentions. That OVER-links, which is the
      // conservative direction Codex offered as the alternative: it can refuse
      // a name nothing touched, never miss one that was mutated.
      if (n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const targets = new Set<string>();
        collectAssignmentTargets(n.left, targets);
        const sources = new Set<string>();
        collectIdentifiers(n.right, sources);
        for (const target of targets) for (const source of sources) link(target, source);
      }
    }
    if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(n.operand)
    ) {
      rebound.add(n.operand.text);
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

  const out = new Map<string, ts.ObjectLiteralExpression>();
  for (const [name, lit] of seen) {
    if (lit && !rebound.has(name) && !mutated.has(name)) out.set(name, lit);
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
 * PR #94). `Object` and `globalThis.Object` only — and, deliberately, not a
 * local shadow of the name, because a file that shadows `Object` is beyond
 * what this catches and refusing on the name alone is the defect being fixed.
 */
export function isObjectAssignCall(n: ts.Node): n is ts.CallExpression {
  if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return false;
  if (n.expression.name.text !== "assign") return false;
  const receiver = unwrapTransparent(n.expression.expression);
  if (ts.isIdentifier(receiver)) return receiver.text === "Object";
  return (
    ts.isPropertyAccessExpression(receiver) &&
    receiver.name.text === "Object" &&
    ts.isIdentifier(receiver.expression) &&
    receiver.expression.text === "globalThis"
  );
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
