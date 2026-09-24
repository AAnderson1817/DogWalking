import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CredentialLogRow } from "@/lib/api";

/**
 * The client's "Entry code activity": every time their walker viewed or
 * changed an entry code for their home (review H3).
 *
 * A failed read used to be caught into an empty list, and an empty list hides
 * the section, so a client whose trail could not be read saw exactly what a
 * client with no entry code on file sees: nothing. On the one screen that
 * answers "who opened my door", that is the M39 shape. The failure must still
 * not cost them the portal (the comment beside the read is right about that),
 * so it is the section that says it could not load, with a retry.
 */

const TRAIL = vi.hoisted(() => ({
  fn: vi.fn<(limit?: number) => Promise<CredentialLogRow[]>>(),
  // One unread update, so a test can press "Mark read", which reloads the
  // whole portal and reads the trail again.
  notifications: [] as Array<{ id: string }>,
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getMyClient: async () => ({
    id: "c-1",
    operator_id: "op-1",
    full_name: "Amelia Hart",
    plan_id: null,
    credit_balance: 4,
    notice_accepted_at: null,
    notice_version: null,
  }),
  getMyOperatorView: async () => ({ business_name: "Hart Walks", gps_retention_days: 365 }),
  getPlan: async () => null,
  listNotifications: async () => TRAIL.notifications,
  listWalksDetailed: async () => [],
  markNotificationRead: async () => undefined,
  listMyCredentialLog: (limit?: number) => TRAIL.fn(limit),
}));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ session: { user: { id: "u-1" } } }),
}));
vi.mock("@/components/NotificationInbox", () => ({
  NotificationBell: () => null,
  NotificationList: ({ items, onMarkRead }: { items: Array<{ id: string }>; onMarkRead: (n: { id: string }) => void }) =>
    items.map((n) => (
      <button key={n.id} type="button" onClick={() => onMarkRead(n)}>
        Mark read
      </button>
    )),
}));
vi.mock("@/components/EmailSection", () => ({ EmailSection: () => null }));
vi.mock("@/components/PushSection", () => ({ PushSection: () => null }));
vi.mock("@/components/YourDataPanel", () => ({ YourDataPanel: () => null }));

const { default: PortalHome } = await import("./PortalHome");

const ROW: CredentialLogRow = {
  id: "log-1",
  credential_id: "cred-1",
  accessed_by: "op-1",
  action: "read",
  purpose: "Luna 2pm walk",
  accessed_at: "2026-08-14T19:02:00Z",
  walk_id: null,
};

async function show() {
  render(
    <MemoryRouter>
      <PortalHome />
    </MemoryRouter>,
  );
  // The portal itself, which the trail's failure must not take down.
  await screen.findByRole("heading", { name: "Hi, Amelia" });
  return userEvent.setup();
}

/** The section the label heads, if it is on screen. */
function trailSection(): HTMLElement | null {
  const label = screen.queryByText("Entry code activity", { selector: ".section-label" });
  return label?.closest("section") ?? null;
}

describe("PortalHome's entry code activity", () => {
  beforeEach(() => {
    TRAIL.fn.mockReset();
    TRAIL.notifications = [];
  });

  it("says it could not load the trail, instead of hiding the section", async () => {
    TRAIL.fn.mockRejectedValue(new Error("upstream timeout"));
    await show();

    const section = trailSection();
    expect(section).not.toBeNull();
    expect(within(section!).getByText("Couldn't load your entry code activity")).toBeInTheDocument();
    expect(within(section!).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    // The rest of the portal is still there.
    expect(screen.getByText("Nothing booked")).toBeInTheDocument();
  });

  it("reads the trail again on Retry, and shows what comes back", async () => {
    TRAIL.fn.mockRejectedValueOnce(new Error("upstream timeout")).mockResolvedValueOnce([ROW]);
    const user = await show();

    await user.click(within(trailSection()!).getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Luna 2pm walk")).toBeInTheDocument();
    expect(within(trailSection()!).getByText("Entry code viewed")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load your entry code activity")).toBeNull();
    expect(TRAIL.fn).toHaveBeenCalledTimes(2);
  });

  it("keeps the failure on screen when the retry fails too", async () => {
    TRAIL.fn.mockRejectedValue(new Error("upstream timeout"));
    const user = await show();

    await user.click(within(trailSection()!).getByRole("button", { name: "Retry" }));

    expect(await within(trailSection()!).findByRole("button", { name: "Retry" })).toBeEnabled();
    expect(within(trailSection()!).getByText("Couldn't load your entry code activity")).toBeInTheDocument();
    expect(TRAIL.fn).toHaveBeenCalledTimes(2);
  });

  it("keeps the newest read when a Retry settles after a reload", async () => {
    // Retry is still reading when the client marks an update read, which
    // reloads the portal and reads the trail again. The reload's answer is
    // the newer one; the Retry failing afterwards must not replace it.
    TRAIL.notifications = [{ id: "n-1" }];
    let failRetry!: (e: unknown) => void;
    TRAIL.fn
      .mockRejectedValueOnce(new Error("upstream timeout"))
      .mockReturnValueOnce(new Promise<CredentialLogRow[]>((_, reject) => (failRetry = reject)))
      .mockResolvedValueOnce([ROW]);
    const user = await show();

    await user.click(within(trailSection()!).getByRole("button", { name: "Retry" }));
    expect(within(trailSection()!).getByText("Loading your entry code activity")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mark read" }));
    expect(await screen.findByText("Luna 2pm walk")).toBeInTheDocument();

    failRetry(new Error("upstream timeout"));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText("Luna 2pm walk")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load your entry code activity")).toBeNull();
    expect(TRAIL.fn).toHaveBeenCalledTimes(3);
  });

  it("shows no section for a client with no activity, as before", async () => {
    TRAIL.fn.mockResolvedValue([]);
    await show();
    expect(trailSection()).toBeNull();
  });

  it("shows the trail when the read succeeds", async () => {
    TRAIL.fn.mockResolvedValue([ROW]);
    await show();
    expect(within(trailSection()!).getByText("Luna 2pm walk")).toBeInTheDocument();
  });
});
