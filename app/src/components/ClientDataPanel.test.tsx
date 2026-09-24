// The erasure panel (review H5, 0058). What matters is that the screen never
// says an erasure is done unless the database says so. The first phase marks
// the client erased before any photo is deleted, so `purged_at` alone used to
// read as "finished": the button went away, and the photos waited for a
// retry nobody could start once the page had reloaded.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientRecord } from "@/lib/api";
import { ClientDataPanel } from "./ClientDataPanel";

const API = vi.hoisted(() => ({
  getErasureStatus: vi.fn(),
  purgeClient: vi.fn(),
  exportClientData: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getErasureStatus: API.getErasureStatus,
  purgeClient: API.purgeClient,
  exportClientData: API.exportClientData,
}));

const client = (purged: boolean) =>
  ({
    id: "c-1",
    full_name: purged ? "Deleted client" : "Jane Doe",
    purged_at: purged ? "2026-09-24T10:00:00Z" : null,
  }) as unknown as ClientRecord;

beforeEach(() => {
  API.getErasureStatus.mockReset();
  API.purgeClient.mockReset();
  API.exportClientData.mockReset();
});

describe("ClientDataPanel, an erased client", () => {
  it("says the data was erased only when the database says the erasure finished", async () => {
    API.getErasureStatus.mockResolvedValue({ erased: true, finished: true, photosLeft: 0 });
    render(<ClientDataPanel client={client(true)} onPurged={() => {}} />);
    expect(await screen.findByText(/personal data was erased/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Finish erasing" })).toBeNull();
  });

  /** After a reload: the one case the old screen could not see. */
  it("offers to finish an erasure that has not, and says how many photos are left", async () => {
    API.getErasureStatus.mockResolvedValue({ erased: true, finished: false, photosLeft: 3 });
    API.purgeClient.mockResolvedValue({ photosDeleted: 3, photosLeft: 0, finished: true });
    const onPurged = vi.fn();
    render(<ClientDataPanel client={client(true)} onPurged={onPurged} />);
    expect(await screen.findByText(/has not finished: 3 photo\(s\) are still stored/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Finish erasing" }));
    expect(API.purgeClient).toHaveBeenCalledWith("c-1");
    expect(await screen.findByText(/personal data was erased/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Finish erasing" })).toBeNull();
    expect(onPurged).toHaveBeenCalled();
  });

  it("offers to finish when every photo is gone but the last step did not run", async () => {
    API.getErasureStatus.mockResolvedValue({ erased: true, finished: false, photosLeft: 0 });
    render(<ClientDataPanel client={client(true)} onPurged={() => {}} />);
    expect(await screen.findByText(/its last step did not run/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finish erasing" })).toBeEnabled();
  });

  /**
   * Not knowing is not "finished". Offering the retry costs nothing — the
   * first phase is idempotent — and hiding it is how photos were stranded.
   */
  it("offers to finish when it cannot find out", async () => {
    API.getErasureStatus.mockRejectedValue(new Error("network down"));
    render(<ClientDataPanel client={client(true)} onPurged={() => {}} />);
    expect(await screen.findByText(/could not be checked/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finish erasing" })).toBeEnabled();
    expect(screen.queryByText(/personal data was erased\./)).toBeNull();
  });

  /** Until the database answers, the screen does not say the data is gone. */
  it("claims nothing while it is still asking", async () => {
    API.getErasureStatus.mockReturnValue(new Promise(() => {}));
    render(<ClientDataPanel client={client(true)} onPurged={() => {}} />);
    expect(screen.getByText(/Checking whether erasing this client's data finished/)).toBeInTheDocument();
    expect(screen.queryByText(/personal data was erased/)).toBeNull();
  });

  it("keeps offering it while photos remain after a retry", async () => {
    API.getErasureStatus.mockResolvedValue({ erased: true, finished: false, photosLeft: 3 });
    API.purgeClient.mockResolvedValue({ photosDeleted: 1, photosLeft: 2, finished: false });
    render(<ClientDataPanel client={client(true)} onPurged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Finish erasing" }));
    expect(await screen.findByText(/has not finished: 2 photo\(s\) are still stored/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finish erasing" })).toBeEnabled();
  });
});

describe("ClientDataPanel, erasing", () => {
  async function eraseFromSheet() {
    await userEvent.click(screen.getByRole("button", { name: "Erase their data" }));
    await userEvent.type(screen.getByLabelText("Type DELETE to confirm"), "DELETE");
    await userEvent.click(screen.getByRole("button", { name: "Erase permanently" }));
  }

  it("says the data was erased when the erasure finished", async () => {
    API.purgeClient.mockResolvedValue({ photosDeleted: 2, photosLeft: 0, finished: true });
    const onPurged = vi.fn();
    render(<ClientDataPanel client={client(false)} onPurged={onPurged} />);
    await eraseFromSheet();
    expect(await screen.findByText("This client's personal data has been erased.")).toBeInTheDocument();
    expect(onPurged).toHaveBeenCalled();
  });

  it("does not say the data was erased when photos remain", async () => {
    API.purgeClient.mockResolvedValue({ photosDeleted: 1, photosLeft: 1, finished: false });
    const onPurged = vi.fn();
    const { rerender } = render(<ClientDataPanel client={client(false)} onPurged={onPurged} />);
    await eraseFromSheet();
    expect(onPurged).toHaveBeenCalled();
    expect(screen.queryByText("This client's personal data has been erased.")).toBeNull();
    // The screen reloads the record, which now reads as erased.
    API.getErasureStatus.mockResolvedValue({ erased: true, finished: false, photosLeft: 1 });
    rerender(<ClientDataPanel client={client(true)} onPurged={onPurged} />);
    expect(await screen.findByText(/has not finished: 1 photo\(s\) are still stored/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finish erasing" })).toBeEnabled();
  });

  /** The first phase may have committed: the record is reloaded either way. */
  it("reloads the record when the erasure fails part way", async () => {
    API.purgeClient.mockRejectedValue(new Error("statement timeout"));
    const onPurged = vi.fn();
    render(<ClientDataPanel client={client(false)} onPurged={onPurged} />);
    await eraseFromSheet();
    expect((await screen.findAllByText("statement timeout")).length).toBeGreaterThan(0);
    expect(onPurged).toHaveBeenCalled();
  });
});
