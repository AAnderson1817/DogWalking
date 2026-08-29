/**
 * Review L2: a door code copied out of the vault outlives the reveal.
 *
 * The panel advertises a 30-second auto-clear, and it applies only to the copy
 * ON SCREEN. The copy that leaves the app persists in the OS pasteboard: on
 * iOS it is readable by the next foregrounded app and syncs to the operator's
 * Mac through Universal Clipboard. Copy is also the path operators will
 * actually use — nobody retypes an alarm sequence at a door.
 *
 * ── What this can and cannot do ─────────────────────────────────────────────
 *
 * It is BEST-EFFORT and the UI says so. A web page cannot read the clipboard
 * to check what is on it (that needs a permission prompt this would fail), and
 * cannot write to it at all without focus and a recent user gesture. So:
 *
 *   * We remember that WE wrote a secret, rather than reading the clipboard.
 *   * We only attempt a clear while the document has focus — a background tab
 *     writing to the pasteboard is refused by the browser anyway, and on some
 *     engines the rejection is silent, which would make this look like it
 *     worked.
 *   * We overwrite with a single space rather than an empty string, because
 *     `writeText("")` is a no-op in several implementations and leaves the
 *     previous contents in place.
 *
 * If the operator switches apps before the timer expires, the clear does not
 * run. That is the honest limit, and it is why the button is labelled to say
 * the copy leaves the app rather than implying the timer covers it.
 */

export interface ClipboardPort {
  writeText(text: string): Promise<void>;
  hasFocus(): boolean;
}

/** The single decision, extracted so it can be tested without a DOM. */
export function shouldClearClipboard(state: {
  /** Did we put a secret there ourselves? */
  copied: boolean;
  /** Is the document focused? A background write is refused, sometimes silently. */
  focused: boolean;
}): boolean {
  return state.copied && state.focused;
}

/** What we overwrite with. Not "" — that is a no-op in several engines. */
export const CLIPBOARD_SCRUB = " ";

export function makeSecretClipboard(port: ClipboardPort) {
  let copied = false;

  return {
    async copy(secret: string): Promise<void> {
      await port.writeText(secret);
      copied = true;
    },

    /**
     * Best-effort scrub. Resolves either way — a failed clear must never
     * surface as an error over a door code the operator is still reading, and
     * there is nothing they could do about it.
     */
    async clear(): Promise<boolean> {
      if (!shouldClearClipboard({ copied, focused: port.hasFocus() })) return false;
      try {
        await port.writeText(CLIPBOARD_SCRUB);
        copied = false;
        return true;
      } catch {
        return false;
      }
    },

    /** Test seam: has this instance written a secret it has not scrubbed? */
    get holdsSecret(): boolean {
      return copied;
    },
  };
}

export const browserClipboard: ClipboardPort = {
  writeText: (text) => navigator.clipboard.writeText(text),
  hasFocus: () => document.hasFocus(),
};
