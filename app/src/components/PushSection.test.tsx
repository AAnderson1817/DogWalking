// The opt-in surface (review M27). What matters is that each of the six
// states produces the RIGHT AFFORDANCE — a switch that cannot work is worse
// than an honest sentence, and "blocked in your browser" points at the only
// place that can undo it.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PushSection } from "./PushSection";

const PUSH = vi.hoisted(() => ({
  readPushEnvironment: vi.fn(),
  enablePush: vi.fn(),
  disablePush: vi.fn(),
}));

vi.mock("@/lib/push", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/push")>()),
  readPushEnvironment: PUSH.readPushEnvironment,
  enablePush: PUSH.enablePush,
  disablePush: PUSH.disablePush,
}));

const ENV = {
  supported: true,
  vapidKey: "k",
  permission: "default" as NotificationPermission,
  subscribed: false,
  workerHandlesPush: true,
};

beforeEach(() => {
  PUSH.readPushEnvironment.mockReset().mockResolvedValue(ENV);
  PUSH.enablePush.mockReset().mockResolvedValue("on");
  PUSH.disablePush.mockReset().mockResolvedValue("off");
});

describe("PushSection", () => {
  it("offers a switch when push is actually available", async () => {
    render(<PushSection />);
    expect(await screen.findByRole("button", { name: "Turn on for this device" })).toBeEnabled();
  });

  it("offers NO switch when the browser cannot do push", async () => {
    PUSH.readPushEnvironment.mockResolvedValue({ ...ENV, supported: false });
    render(<PushSection />);
    expect(await screen.findByText(/This browser cannot show push notifications/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers NO switch when blocked, and says where it CAN be undone", async () => {
    // The worst possible affordance here is a switch that silently does
    // nothing: once denied, the browser will not prompt again from script.
    PUSH.readPushEnvironment.mockResolvedValue({ ...ENV, permission: "denied" });
    render(<PushSection />);
    expect(await screen.findByText(/browser's site settings/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers NO switch when the active worker cannot display a push", async () => {
    // The finding this state exists for (Codex review on PR #85): during an
    // upgrade from the pre-M27 worker, a subscription made here delivers to
    // something that ignores it. A switch would create exactly that.
    PUSH.readPushEnvironment.mockResolvedValue({ ...ENV, workerHandlesPush: false, subscribed: true });
    render(<PushSection />);
    expect(await screen.findByText(/still running an older version/)).toBeInTheDocument();
    expect(screen.queryByRole("button"), "offered a switch under a worker that cannot serve it").toBeNull();
  });

  it("says push is not set up rather than blaming the browser", async () => {
    // No VAPID key is an OWNER action. Telling the user their browser is at
    // fault sends them somewhere that cannot help.
    PUSH.readPushEnvironment.mockResolvedValue({ ...ENV, vapidKey: "" });
    render(<PushSection />);
    expect(await screen.findByText(/not set up for this installation/)).toBeInTheDocument();
  });

  it("turning it on records the new state", async () => {
    render(<PushSection />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Turn on for this device" }));
    await waitFor(() => expect(PUSH.enablePush).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Turn off on this device" })).toBeInTheDocument();
  });

  it("a failure surfaces the browser's own words and re-reads the state", async () => {
    // A failed subscribe can still leave a permission decision behind, so
    // showing the pre-click state would make the switch look broken next press.
    PUSH.enablePush.mockRejectedValue(new Error("Registration failed - push service error"));
    PUSH.readPushEnvironment.mockResolvedValueOnce(ENV).mockResolvedValue({ ...ENV, permission: "denied" });
    render(<PushSection />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Turn on for this device" }));
    expect(await screen.findByText(/push service error/)).toBeInTheDocument();
    expect(await screen.findByText(/browser's site settings/)).toBeInTheDocument();
  });
});
