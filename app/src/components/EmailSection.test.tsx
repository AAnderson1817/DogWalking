// Turning email back on (0054). What matters is that each server answer
// produces the right affordance: the button only where the server would lift,
// a sentence naming the remedy everywhere else, and nothing at all when email
// is on, which is the common case.
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnrecognisedEmailStatusError } from "@/lib/email-lift-states";
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
const answer = (result: string, email: string | null = EMAIL) => ({ result, email });

beforeEach(() => {
  API.getMyEmailStatus.mockReset().mockResolvedValue(at("ready"));
  API.liftMyEmailSuppression.mockReset().mockResolvedValue(answer("lifted"));
});

describe("EmailSection", () => {
  it("offers the lift only when the server says it will lift", async () => {
    render(<EmailSection walkerName="Hart Walks" />);
    expect(await screen.findByText(/Email to amelia@example\.test is turned off/)).toBeInTheDocument();
    expect(screen.getByText(/You signed in with a link sent to that address/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn email back on" })).toBeEnabled();
  });

  it.each([
    ["needs_link_sign_in", /choose "Use a magic link instead".*open the link we send to amelia@example\.test/],
    ["not_confirmed", /choose "Forgot your password\?".*open the reset link we send to amelia@example\.test/],
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

  it("sends an unconfirmed account to a reset link, never a magic link", async () => {
    // GoTrue sends an unconfirmed account's magic-link request through signup,
    // which a project with signup closed refuses; a reset link is not gated
    // on signup and confirms the address.
    API.getMyEmailStatus.mockResolvedValue(at("not_confirmed"));
    render(<EmailSection walkerName="Hart Walks" />);
    await screen.findByText(/Forgot your password/);
    expect(screen.queryByText(/magic link/i)).toBeNull();
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
  ])("renders nothing when %s", async (_label, status) => {
    API.getMyEmailStatus.mockResolvedValue(status);
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

  it("names the address the server lifted, not the one the page read earlier", async () => {
    // The contact address can change between the offer and the press; the
    // lift decides on the one current when it runs, and says which.
    API.liftMyEmailSuppression.mockResolvedValue(answer("lifted", "amelia.new@example.test"));
    render(<EmailSection walkerName="Hart Walks" />);
    await userEvent.click(await screen.findByRole("button", { name: "Turn email back on" }));
    expect(await screen.findByText(/will go to amelia\.new@example\.test/)).toBeInTheDocument();
    expect(screen.queryByText(/will go to amelia@example\.test/)).toBeNull();
  });

  it("treats a lift another tab already made as done, not as a failure", async () => {
    API.liftMyEmailSuppression.mockResolvedValue(answer("not_suppressed"));
    render(<EmailSection walkerName="Hart Walks" />);
    await userEvent.click(await screen.findByRole("button", { name: "Turn email back on" }));
    expect(await screen.findByText(/Email is already on for amelia@example\.test/)).toBeInTheDocument();
    expect(screen.queryByText("Email wasn't turned back on.")).toBeNull();
  });

  it("confirms from the lift's own answer, without reading the status again", async () => {
    // A second read that could fail after the lift succeeded would leave an
    // error beside the confirmation; the answer IS the new state.
    render(<EmailSection walkerName="Hart Walks" />);
    await userEvent.click(await screen.findByRole("button", { name: "Turn email back on" }));
    expect(await screen.findByText(/Email is back on/)).toBeInTheDocument();
    expect(API.getMyEmailStatus).toHaveBeenCalledTimes(1);
  });

  it("on a refusal, shows the server's new reading and never keeps the button", async () => {
    // The session, the address or the account changed between the offer and
    // the press. The refusal carries the new reading; no second read is made,
    // so none can fail and leave a button the server has just refused.
    API.liftMyEmailSuppression.mockResolvedValue(answer("needs_link_sign_in"));
    render(<EmailSection walkerName="Hart Walks" />);
    await userEvent.click(await screen.findByRole("button", { name: "Turn email back on" }));
    expect(await screen.findByText("Email wasn't turned back on.")).toBeInTheDocument();
    expect(screen.getByText(/open the link we send to amelia@example\.test/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/Email is back on/)).toBeNull();
    expect(API.getMyEmailStatus).toHaveBeenCalledTimes(1);
  });

  it("on a refusal for an account that is no longer a client, says so and offers nothing", async () => {
    API.liftMyEmailSuppression.mockResolvedValue(answer("not_client", null));
    render(<EmailSection walkerName="Hart Walks" />);
    await userEvent.click(await screen.findByRole("button", { name: "Turn email back on" }));
    expect(await screen.findByText("Email wasn't turned back on.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/is turned off/)).toBeNull();
  });

  it("disables the button while the lift is in flight", async () => {
    let settle!: (v: unknown) => void;
    API.liftMyEmailSuppression.mockReturnValue(new Promise((r) => { settle = r; }));
    render(<EmailSection walkerName="Hart Walks" />);
    await userEvent.click(await screen.findByRole("button", { name: "Turn email back on" }));
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    await act(async () => settle(answer("lifted")));
    expect(await screen.findByText(/Email is back on/)).toBeInTheDocument();
  });

  it("moves focus to the section's heading when the answer arrives", async () => {
    // The button the focus was on goes away with a lift or a refusal; left
    // there, focus falls to the end of a long page.
    render(<EmailSection walkerName="Hart Walks" />);
    await userEvent.click(await screen.findByRole("button", { name: "Turn email back on" }));
    await screen.findByText(/Email is back on/);
    expect(screen.getByRole("heading", { name: "Email" })).toHaveFocus();
  });

  it("keeps the button when the call itself fails, and says so plainly", async () => {
    API.liftMyEmailSuppression.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<EmailSection walkerName="Hart Walks" />);
    await userEvent.click(await screen.findByRole("button", { name: "Turn email back on" }));
    expect(await screen.findByText(/You appear to be offline/)).toBeInTheDocument();
    expect(screen.queryByText("Failed to fetch")).toBeNull();
    expect(screen.getByRole("button", { name: "Turn email back on" })).toBeEnabled();
    expect(screen.queryByText(/Email is back on/)).toBeNull();
  });

  it("says an answer this build does not know is unknown, not what it said", async () => {
    // A server newer than the page. The lift may or may not have happened, and
    // "Unrecognised email status: …" means nothing to the person reading it.
    API.liftMyEmailSuppression.mockRejectedValue(new UnrecognisedEmailStatusError("paused"));
    render(<EmailSection walkerName="Hart Walks" />);
    await userEvent.click(await screen.findByRole("button", { name: "Turn email back on" }));
    expect(await screen.findByText(/Reload the page to check/)).toBeInTheDocument();
    expect(screen.queryByText(/Unrecognised email status/)).toBeNull();
    expect(screen.queryByText(/Email is back on/)).toBeNull();
  });
});
