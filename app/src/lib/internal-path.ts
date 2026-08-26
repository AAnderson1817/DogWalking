/**
 * Guard for anything handed to `navigate()` or `<Link to>` that did not come
 * from a string literal in this codebase (review M41).
 *
 * The two react-router advisories that reached this app were open redirects:
 * a target beginning `//host` or `\\host` is treated by the router — and by
 * the browser, once it becomes an href — as ANOTHER ORIGIN, so a value that
 * looks like a path navigates the user off-site. CVE-2025-68470 was the
 * forward-slash form; GHSA-wrjc-x8rr-h8h6 is the backslash bypass of the fix
 * for it.
 *
 * No such sink exists in this app today: every `navigate()` and `<Link to>`
 * target is either a literal or a template whose first segment is a literal
 * (`/walks/${id}/live`), so none of them can start with `//` or `\` whatever
 * the interpolated value is. That was true by accident rather than by
 * construction, which is the only reason the upgrade was not urgent — and it
 * is exactly the kind of property that quietly stops being true.
 *
 * So this exists to be the obvious thing to reach for. It is deliberately NOT
 * paired with a CI grep over `navigate(` arguments: the one legitimate
 * non-literal call site would have to be allow-listed by name, and a stale
 * exception that excuses a real check is a failure mode this repository has
 * already paid for more than once.
 */

/**
 * Returns `candidate` if it is unambiguously a path within this app, and
 * `null` otherwise.
 *
 * Accepts a single leading `/` followed by something that is not `/` or `\`.
 * Rejects, in order of how much they look fine:
 *
 *   - `//evil.com` and `/\evil.com`  — protocol-relative, another origin
 *   - `\\evil.com` and `\/evil.com`  — the backslash bypass
 *   - `https://evil.com`             — absolute
 *   - `javascript:…`, `data:…`       — a scheme is never a path
 *   - `walks/1`                      — relative; resolves against wherever
 *                                      the user happens to be, so where it
 *                                      lands is not knowable from here
 *   - `""`                           — not a destination
 *
 * A query string and a fragment are fine: `/portal/walks/1?x=2#top` is a path.
 */
export function internalPath(candidate: string | null | undefined): string | null {
  if (typeof candidate !== "string" || candidate === "") return null;
  // Control characters (a tab or newline inside `/\tevil.com`) are stripped by
  // browsers when resolving a URL, so a value carrying them is not the value
  // that gets navigated to. Refuse rather than try to predict the stripping.
  //
  // Character codes rather than a regex: a control-character class is exactly
  // what `no-control-regex` exists to flag, and suppressing a lint rule that
  // is right in general to keep a use that is right in particular leaves a
  // comment where a reader wants a reason.
  for (let i = 0; i < candidate.length; i++) {
    const code = candidate.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  if (!candidate.startsWith("/")) return null;
  const second = candidate[1];
  if (second === "/" || second === "\\") return null;
  return candidate;
}
