import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Review H18, and the single most valuable thing the DOM harness makes
 * testable: a door code, lockbox combination or alarm sequence is on screen
 * for 30 seconds and then must be gone.
 *
 * None of this was reachable before. The old harness rendered components
 * through `renderToStaticMarkup`, so the `useEffect` that starts the countdown
 * never ran, the interval never ticked, and the cleanup that clears it on
 * unmount never fired. The auto-clear — the whole security property of the
 * reveal panel — was verified by hand, once, and by nothing since.
 *
 * The unmount case is the one that would hurt: an interval that survives its
 * component keeps a decrypted secret referenced in a closure, and the operator
 * has already navigated away believing it gone.
 */

const REAUTH = vi.hoisted(() => ({ fn: vi.fn(async () => "pw" as string | null) }));
const VAULT_GET = vi.hoisted(() => ({ fn: vi.fn(async () => ({ secret: "4821#" })) }));

vi.mock("@/lib/auth-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-context")>()),
  useAuth: () => ({ reauth: REAUTH.fn }),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  vaultGet: (...args: unknown[]) => VAULT_GET.fn(...(args as [])),
  listCredentialLog: vi.fn(async () => []),
}));

const { CredentialRow } = await import("./VaultFlows");

const CREDENTIAL = {
  id: "cred-1",
  operator_id: "op-1",
  property_id: "prop-1",
  label: "Front door",
  entry_method: "door_code" as const,
  revoked_at: null,
  rotated_at: null,
  created_at: "2026-08-01T00:00:00Z",
};

/** Drive the reveal from the operator's side: purpose, then confirm. */
async function reveal(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /reveal/i }));
  await user.type(screen.getByLabelText(/purpose/i), "Luna 2pm walk");
  await user.click(screen.getByRole("button", { name: /confirm & reveal/i }));
  await waitFor(() => expect(screen.getByText("4821#")).toBeInTheDocument());
}

describe("the vault reveal panel", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    REAUTH.fn.mockClear();
    VAULT_GET.fn.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the secret only after a re-auth and a stated purpose", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CredentialRow credential={CREDENTIAL} onChanged={() => undefined} />);

    expect(screen.queryByText("4821#")).not.toBeInTheDocument();
    await reveal(user);

    expect(REAUTH.fn).toHaveBeenCalledTimes(1);
    expect(VAULT_GET.fn).toHaveBeenCalledWith(
      expect.objectContaining({ credential_id: "cred-1", purpose: "Luna 2pm walk" }),
    );
  });

  it("clears the secret from the DOM after 30 seconds", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CredentialRow credential={CREDENTIAL} onChanged={() => undefined} />);
    await reveal(user);

    // Still there at 29s — otherwise a component that never showed it would
    // satisfy the assertion below.
    await act(async () => {
      vi.advanceTimersByTime(29_000);
    });
    expect(screen.getByText("4821#")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await waitFor(() => expect(screen.queryByText("4821#")).not.toBeInTheDocument());
  });

  it("counts down visibly, and announces the last seconds", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CredentialRow credential={CREDENTIAL} onChanged={() => undefined} />);
    await reveal(user);

    await act(async () => {
      vi.advanceTimersByTime(25_000);
    });
    // A sighted operator reads the number; a screen-reader user gets the
    // sentence, and only near the end so it does not chatter for 30 seconds.
    expect(screen.getByText("5s")).toBeInTheDocument();
    expect(screen.getByText(/clears in 5 seconds/i)).toBeInTheDocument();
  });

  /**
   * The leak. If the interval outlives the component, a decrypted secret stays
   * referenced by a live closure after the operator has navigated away.
   */
  it("stops its timer when the row unmounts", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { unmount } = render(
      <CredentialRow credential={CREDENTIAL} onChanged={() => undefined} />,
    );
    await reveal(user);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
