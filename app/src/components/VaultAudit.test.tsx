import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CredentialLogRow } from "@/lib/api";

/**
 * The operator's audit sheet for one entry code: who viewed or changed it.
 *
 * A failed read used to be caught into an empty list, and the sheet then said
 * "This credential has not been opened yet". On the screen whose job is to
 * answer that question, "nothing happened" and "could not find out" must not
 * look the same (the M39 shape).
 *
 * The sheet also rendered only `purpose`, which only a reveal carries. Since
 * 0030 the log records creations, rotations, revocations and failed password
 * checks too, and each of those showed as a date with nothing above it.
 */

const LOG = vi.hoisted(() => ({
  fn: vi.fn<(credentialId: string) => Promise<CredentialLogRow[]>>(),
}));

vi.mock("@/lib/auth-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-context")>()),
  useAuth: () => ({ reauth: vi.fn(async () => null) }),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  listCredentialLog: (credentialId: string) => LOG.fn(credentialId),
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

const row = (over: Partial<CredentialLogRow> = {}): CredentialLogRow => ({
  id: "log-1",
  credential_id: "cred-1",
  accessed_by: "op-1",
  action: "read",
  purpose: "Luna 2pm walk",
  accessed_at: "2026-08-14T19:02:00Z",
  walk_id: null,
  ...over,
});

/** A promise the test settles when it chooses. */
function held<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function show() {
  render(<CredentialRow credential={CREDENTIAL} onChanged={() => undefined} />);
  return userEvent.setup();
}

const sheet = () => screen.getByRole("dialog", { name: "Audit trail" });

describe("the audit trail sheet", () => {
  beforeEach(() => {
    LOG.fn.mockReset();
  });

  it("says it could not load the trail, not that the code was never opened", async () => {
    LOG.fn.mockRejectedValue(new Error("upstream timeout"));
    const user = show();
    await user.click(screen.getByRole("button", { name: "Audit trail" }));

    const failure = await within(sheet()).findByText("Couldn't load the audit trail");
    expect(failure).toBeInTheDocument();
    expect(within(sheet()).queryByText(/not been opened|no reveals|nothing recorded/i)).toBeNull();
    expect(within(sheet()).getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("reads the trail again on Retry, and shows what comes back", async () => {
    LOG.fn.mockRejectedValueOnce(new Error("upstream timeout")).mockResolvedValueOnce([row()]);
    const user = show();
    await user.click(screen.getByRole("button", { name: "Audit trail" }));
    await user.click(await within(sheet()).findByRole("button", { name: "Retry" }));

    expect(await within(sheet()).findByText("Luna 2pm walk")).toBeInTheDocument();
    expect(within(sheet()).queryByText("Couldn't load the audit trail")).toBeNull();
    expect(LOG.fn).toHaveBeenCalledTimes(2);
  });

  it("says what each entry was, not only the reveals", async () => {
    // Everything but a reveal carries no purpose, so a sheet that printed the
    // purpose showed each of these as a bare date.
    LOG.fn.mockResolvedValue([
      row({ id: "a", action: "create", purpose: null }),
      row({ id: "b", action: "rotate", purpose: null }),
      row({ id: "c", action: "revoke", purpose: null }),
      row({ id: "d", action: "reauth_failed", purpose: null }),
      row({ id: "e", action: "read", purpose: "Luna 2pm walk" }),
    ]);
    const user = show();
    await user.click(screen.getByRole("button", { name: "Audit trail" }));

    const panel = sheet();
    expect(await within(panel).findByText("Entry code added")).toBeInTheDocument();
    expect(within(panel).getByText("Entry code changed")).toBeInTheDocument();
    expect(within(panel).getByText("Access removed")).toBeInTheDocument();
    expect(within(panel).getByText("Failed sign-in check")).toBeInTheDocument();
    expect(within(panel).getByText("Entry code viewed")).toBeInTheDocument();
    expect(within(panel).getByText("Luna 2pm walk")).toBeInTheDocument();
  });

  it("reads the trail afresh each time it opens, rather than showing the last answer", async () => {
    LOG.fn.mockResolvedValueOnce([row({ purpose: "Earlier visit" })]);
    const user = show();
    await user.click(screen.getByRole("button", { name: "Audit trail" }));
    expect(await within(sheet()).findByText("Earlier visit")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // The second read has not answered yet. What the sheet showed last time
    // is not the answer to this opening.
    const second = held<CredentialLogRow[]>();
    LOG.fn.mockReturnValueOnce(second.promise);
    await user.click(screen.getByRole("button", { name: "Audit trail" }));
    expect(within(sheet()).getByText("Loading audit trail")).toBeInTheDocument();
    expect(within(sheet()).queryByText("Earlier visit")).toBeNull();

    second.resolve([row({ purpose: "Latest visit" })]);
    expect(await within(sheet()).findByText("Latest visit")).toBeInTheDocument();
  });

  it("keeps the newest answer when an earlier read settles after it", async () => {
    const first = held<CredentialLogRow[]>();
    LOG.fn.mockReturnValueOnce(first.promise).mockResolvedValueOnce([row({ purpose: "Latest visit" })]);
    const user = show();
    await user.click(screen.getByRole("button", { name: "Audit trail" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Audit trail" }));
    expect(await within(sheet()).findByText("Latest visit")).toBeInTheDocument();

    // The first opening's read fails only now. It is not the answer to the
    // opening on screen.
    first.reject(new Error("upstream timeout"));
    await new Promise((r) => setTimeout(r, 0));
    expect(within(sheet()).getByText("Latest visit")).toBeInTheDocument();
    expect(within(sheet()).queryByText("Couldn't load the audit trail")).toBeNull();
  });

  it("says so when there is nothing to show", async () => {
    LOG.fn.mockResolvedValue([]);
    const user = show();
    await user.click(screen.getByRole("button", { name: "Audit trail" }));
    expect(await within(sheet()).findByText("Nothing recorded yet")).toBeInTheDocument();
    expect(within(sheet()).queryByText("Couldn't load the audit trail")).toBeNull();
  });
});
