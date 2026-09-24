// Turning email back on (0054). What matters is that each server answer
// produces the right affordance: the button only where the server would lift,
// a sentence naming the remedy everywhere else, and nothing at all when email
// is on, which is the common case.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmailSection } from "./EmailSection";

const API = vi.hoisted(() => ({
  getMyEmailStatus: vi.fn(),
  liftMyEmailSuppression: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getMyEmailStatus: API.getMyEmailStatus,
  liftMyEmailSuppression: API.liftMyEmailSuppression,
}));

const EMAIL = "amelia@example.test";
const at = (state: string, email: string | null = EMAIL) => ({ email, state });

beforeEach(() => {
  API.getMyEmailStatus.mockReset().mockResolvedValue(at("ready"));
  API.liftMyEmailSuppression.mockReset().mockResolvedValue("lifted");
});

describe("EmailSection", () => {
  it("offers the lift only when the server says it will lift", async () => {
    render(<EmailSection walkerName="Hart Walks" />);
    expect(await screen.findByText(/Email to amelia@example\.test is turned off/)).toBeInTheDocument();
    expect(screen.getByText(/It's the address you sign in with/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn email back on" })).toBeEnabled();
  });

  it.each([
    ["not_confirmed", /sign in with a link sent to amelia@example\.test/],
    ["not_login_address", /ask Hart Walks to change it/],
    ["not_liftable", /a preference that can't be changed here/],
  ])("offers NO button when the server would refuse (%s), and says why", async (state, why) => {
    // A button the server will refuse is worse than an honest sentence: it
    // looks like it works and then does nothing.
    API.getMyEmailStatus.mockResolvedValue(at(state));
    render(<EmailSection walkerName="Hart Walks" />);
    expect(await screen.findByText(why)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("names the walker generically when there is no business name", async () => {
    API.getMyEmailStatus.mockResolvedValue(at("not_login_address"));
    render(<EmailSection walkerName={null} />);
    expect(await screen.findByText(/ask your walker to change it/)).toBeInTheDocument();
  });

  it.each([
    ["email is on", at("not_suppressed")],
    ["the client has no address", at("no_address", null)],
    ["the account is not a claimed client", null],
  ])("renders nothing when %s", async (_label, answer) => {
    API.getMyEmailStatus.mockResolvedValue(answer);
    const { container } = render(<EmailSection walkerName="Hart Walks" />);
    await waitFor(() => expect(API.getMyEmailStatus).toHaveBeenCalled());
    // A tick for the answer to land, so an empty render is not just "not yet".
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing, and does not throw, when the status cannot be read", async () => {
    // Advisory: a failed read must not replace a working portal with an error.
    API.getMyEmailStatus.mockRejectedValue(new Error("network"));
    const { container } = render(<EmailSection walkerName="Hart Walks" />);
    await waitFor(() => expect(API.getMyEmailStatus).toHaveBeenCalled());
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });

  it("mounts the confirmation's live region before the confirmation arrives", async () => {
    render(<EmailSection walkerName="Hart Walks" />);
    await screen.findByRole("button", { name: "Turn email back on" });
    const region = screen.getByRole("status");
    expect(region).toBeEmptyDOMElement();
    await userEvent.click(screen.getByRole("button", { name: "Turn email back on" }));
    // The SAME element: a region that appears with its text is announced far
    // less reliably than one that was already there.
    await waitFor(() => expect(region).toHaveTextContent(/Email is back on/));
  });

  it("confirms a lift, names the address, and takes the button away", async () => {
    render(<EmailSection walkerName="Hart Walks" />);
    await userEvent.click(await screen.findByRole("button", { name: "Turn email back on" }));
    expect(await screen.findByText(/Walk updates and billing notices will go to amelia@example\.test/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/is turned off/)).toBeNull();
    expect(API.liftMyEmailSuppression).toHaveBeenCalledTimes(1);
  });

  it("treats a lift another tab already made as done, not as a failure", async () => {
    API.liftMyEmailSuppression.mockResolvedValue("not_suppressed");
    render(<EmailSection walkerName="Hart Walks" />);
    await userEvent.click(await screen.findByRole("button", { name: "Turn email back on" }));
    expect(await screen.findByText(/Email is already on for amelia@example\.test/)).toBeInTheDocument();
    expect(screen.queryByText("Email wasn't turned back on.")).toBeNull();
  });

  it("does not claim success from a failed re-read after a lift", async () => {
    // The lift's answer is the new state; a second read that fails must not
    // put an error beside the confirmation.
    render(<EmailSection walkerName="Hart Walks" />);
    await screen.findByRole("button", { name: "Turn email back on" });
    API.getMyEmailStatus.mockRejectedValue(new Error("network"));
    await userEvent.click(screen.getByRole("button", { name: "Turn email back on" }));
    expect(await screen.findByText(/Email is back on/)).toBeInTheDocument();
    expect(screen.queryByText(/network/)).toBeNull();
  });

  it("says the lift did not happen when the server now refuses, and shows its new reading", async () => {
    // The address or the account changed between the offer and the press.
    API.liftMyEmailSuppression.mockResolvedValue("not_confirmed");
    render(<EmailSection walkerName="Hart Walks" />);
    await screen.findByRole("button", { name: "Turn email back on" });
    API.getMyEmailStatus.mockResolvedValue(at("not_confirmed"));
    await userEvent.click(screen.getByRole("button", { name: "Turn email back on" }));
    expect(await screen.findByText("Email wasn't turned back on.")).toBeInTheDocument();
    expect(await screen.findByText(/sign in with a link sent to/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/Email is back on/)).toBeNull();
  });

  it("keeps the button when the call itself fails, so it can be tried again", async () => {
    API.liftMyEmailSuppression.mockRejectedValue(new Error("Failed to fetch"));
    render(<EmailSection walkerName="Hart Walks" />);
    await userEvent.click(await screen.findByRole("button", { name: "Turn email back on" }));
    expect(await screen.findByText("Failed to fetch")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn email back on" })).toBeEnabled();
    expect(screen.queryByText(/Email is back on/)).toBeNull();
  });
});
