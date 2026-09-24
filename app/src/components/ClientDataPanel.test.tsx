// The erasure panel (review H5, 0058). What matters is that the screen never
// says an erasure is done unless the database says so. The first phase marks
// the client erased before any photo is deleted, so `purged_at` alone used to
// read as "finished": the button went away, and the photos waited for a
// retry nobody could start once the page had reloaded.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientRecord } from "@/lib/api";
import { ExportCancelled } from "@/lib/client-export";
import { ClientDataPanel } from "./ClientDataPanel";

const API = vi.hoisted(() => ({
  getErasureStatus: vi.fn(),
  purgeClient: vi.fn(),
  exportClientData: vi.fn(),
  exportClientRoutes: vi.fn(),
  downloadPhoto: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getErasureStatus: API.getErasureStatus,
  purgeClient: API.purgeClient,
  exportClientData: API.exportClientData,
  exportClientRoutes: API.exportClientRoutes,
  downloadPhoto: API.downloadPhoto,
}));

const EXPORT = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock("@/lib/client-export", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-export")>()),
  buildClientExport: EXPORT.build,
}));

const client = (purged: boolean, id = "c-1") =>
  ({
    id,
    full_name: purged ? "Deleted client" : "Jane Doe",
    purged_at: purged ? "2026-09-24T10:00:00Z" : null,
  }) as unknown as ClientRecord;

beforeEach(() => {
  API.getErasureStatus.mockReset();
  API.purgeClient.mockReset();
  API.exportClientData.mockReset();
  EXPORT.build.mockReset();
  URL.createObjectURL = vi.fn(() => "blob:copy");
  URL.revokeObjectURL = vi.fn();
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

  /**
   * The screen can hand this panel another client without remounting it.
   * One client's "finished" must not stand for the next one's while that
   * answer is on its way — least of all by hiding the button that finishes it.
   */
  it("never shows one client's answer for another", async () => {
    API.getErasureStatus.mockResolvedValueOnce({ erased: true, finished: true, photosLeft: 0 });
    const { rerender } = render(<ClientDataPanel client={client(true, "c-1")} onPurged={() => {}} />);
    expect(await screen.findByText(/personal data was erased/)).toBeInTheDocument();
    API.getErasureStatus.mockReturnValueOnce(new Promise(() => {}));
    rerender(<ClientDataPanel client={client(true, "c-2")} onPurged={() => {}} />);
    expect(screen.getByText(/Checking whether erasing this client's data finished/)).toBeInTheDocument();
    expect(screen.queryByText(/personal data was erased/)).toBeNull();
  });

  /**
   * Two things keep this out: the request's own cancellation when the client
   * changes, and the answer's record of which client it is about. Either
   * alone holds this test; with both removed it goes red (measured).
   */
  it("ignores an answer that arrives for the client it has left", async () => {
    let answerFirst: (s: unknown) => void = () => {};
    API.getErasureStatus
      .mockReturnValueOnce(new Promise((r) => { answerFirst = r; }))
      .mockReturnValueOnce(new Promise(() => {}));
    const { rerender } = render(<ClientDataPanel client={client(true, "c-1")} onPurged={() => {}} />);
    rerender(<ClientDataPanel client={client(true, "c-2")} onPurged={() => {}} />);
    await act(async () => answerFirst({ erased: true, finished: true, photosLeft: 0 }));
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

describe("ClientDataPanel, the copy", () => {
  const done = { blob: new Blob(["zip"]), fileName: "sanpo-jane-doe-2026-09-24.zip", photos: 3, photosMissing: 0 };

  it("makes the copy from the record, the routes and the photos, and saves it", async () => {
    EXPORT.build.mockResolvedValue(done);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<ClientDataPanel client={client(false)} onPurged={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Export their data" }));
    expect(await screen.findByText("The copy is ready.")).toBeInTheDocument();
    const [clientId, deps] = EXPORT.build.mock.calls[0]!;
    expect(clientId).toBe("c-1");
    expect(deps.record).toBe(API.exportClientData);
    expect(deps.routes).toBe(API.exportClientRoutes);
    expect(deps.download).toBe(API.downloadPhoto);
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it("says what it is doing while it works, and cannot be started twice", async () => {
    let finish: (v: unknown) => void = () => {};
    EXPORT.build.mockImplementation((_c: string, deps: { progress: (p: unknown) => void }) => {
      deps.progress({ stage: "photos", done: 1, total: 3 });
      return new Promise((r) => { finish = r; });
    });
    render(<ClientDataPanel client={client(false)} onPurged={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Export their data" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Fetching their photos…");
    expect(screen.getByText("1 of 3 photos")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Making the copy…" })).toBeDisabled();
    // An erasure started now would delete the photos the copy is fetching.
    expect(screen.getByRole("button", { name: "Erase their data" })).toBeDisabled();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await act(async () => finish(done));
    expect(screen.getByRole("button", { name: "Export their data" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Erase their data" })).toBeEnabled();
    click.mockRestore();
  });

  /** A status region that spoke once per photo would read the copy out photo by photo. */
  it("announces the stage, not each photo", async () => {
    let report: (p: unknown) => void = () => {};
    EXPORT.build.mockImplementation((_c: string, deps: { progress: (p: unknown) => void }) => {
      report = deps.progress;
      return new Promise(() => {});
    });
    render(<ClientDataPanel client={client(false)} onPurged={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Export their data" }));
    await act(async () => report({ stage: "photos", done: 1, total: 40 }));
    const said = screen.getByRole("status").textContent;
    await act(async () => report({ stage: "photos", done: 2, total: 40 }));
    expect(screen.getByRole("status").textContent).toBe(said);
    expect(screen.getByText("2 of 40 photos")).toBeInTheDocument();
  });

  it("stops the copy when the walker cancels it, and saves nothing", async () => {
    let signal: AbortSignal | undefined;
    EXPORT.build.mockImplementation((_c: string, deps: { signal: AbortSignal }) => {
      signal = deps.signal;
      return new Promise((_r, reject) => {
        deps.signal.addEventListener("abort", () => reject(new ExportCancelled("The copy was cancelled.")));
      });
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<ClientDataPanel client={client(false)} onPurged={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Export their data" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel the copy" }));
    expect(signal?.aborted).toBe(true);
    expect(await screen.findByText("The copy was cancelled. Nothing was saved.")).toBeInTheDocument();
    // Not a failure: the error region stays empty.
    for (const region of screen.getAllByRole("alert")) expect(region).toBeEmptyDOMElement();
    expect(click).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Export their data" })).toBeEnabled();
    click.mockRestore();
  });

  /** A copy the walker left behind should not arrive as a download later. */
  it("stops the copy when the walker leaves the screen", async () => {
    let signal: AbortSignal | undefined;
    EXPORT.build.mockImplementation((_c: string, deps: { signal: AbortSignal }) => {
      signal = deps.signal;
      return new Promise(() => {});
    });
    const { unmount } = render(<ClientDataPanel client={client(false)} onPurged={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Export their data" }));
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  /** The database refuses it; the screen does not offer it. */
  it("offers no copy of an erased client, finished or not", async () => {
    API.getErasureStatus.mockResolvedValueOnce({ erased: true, finished: true, photosLeft: 0 });
    const { unmount } = render(<ClientDataPanel client={client(true)} onPurged={() => {}} />);
    expect(await screen.findByText(/personal data was erased/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export their data" })).toBeNull();
    unmount();
    API.getErasureStatus.mockResolvedValueOnce({ erased: true, finished: false, photosLeft: 2 });
    render(<ClientDataPanel client={client(true)} onPurged={() => {}} />);
    expect(await screen.findByRole("button", { name: "Finish erasing" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Export their data" })).toBeNull();
  });

  it("says how many photos the copy is missing", async () => {
    EXPORT.build.mockResolvedValue({ ...done, photosMissing: 2 });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<ClientDataPanel client={client(false)} onPurged={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Export their data" }));
    expect(await screen.findByText(/2 photo\(s\) could not be fetched/)).toBeInTheDocument();
    click.mockRestore();
  });

  it("shows why a copy could not be made, and lets the walker try again", async () => {
    EXPORT.build.mockRejectedValue(new Error("A walk's route did not come back, so the copy would be incomplete."));
    render(<ClientDataPanel client={client(false)} onPurged={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Export their data" }));
    expect(await screen.findByText(/route did not come back/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export their data" })).toBeEnabled();
    expect(screen.queryByText("The copy is ready.")).toBeNull();
  });
});

