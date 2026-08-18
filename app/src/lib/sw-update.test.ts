import { describe, expect, it, vi } from "vitest";
import { applyUpdate, hasWaitingUpdate, watchForUpdate, type RegistrationLike } from "./sw-update";

/**
 * Review M6. Registration was one line with no update path at all, so an
 * installed PWA resumed from the app switcher — which navigates rarely or
 * never — could run a weeks-old bundle against evolved edge contracts
 * indefinitely.
 *
 * The dangerous direction here is prompting or reloading when nobody asked.
 * Most of these cases are about NOT doing that.
 */

function makeRegistration(over: Partial<RegistrationLike> = {}) {
  const listeners = new Map<string, () => void>();
  const reg = {
    waiting: null,
    installing: null,
    addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
    update: vi.fn(async () => undefined),
    ...over,
  } as RegistrationLike & { update: ReturnType<typeof vi.fn> };
  return { reg, fire: (type: string) => listeners.get(type)?.() };
}

describe("hasWaitingUpdate", () => {
  it("is true when a worker is parked and a controller is already running", () => {
    expect(hasWaitingUpdate({ waiting: { postMessage() {} } }, true)).toBe(true);
  });

  it("is FALSE on a first install, when there is no controller", () => {
    // `waiting` is non-null on a first install too. Without the controller
    // check, somebody opening the app for the very first time is told a new
    // version is ready and asked to reload.
    expect(hasWaitingUpdate({ waiting: { postMessage() {} } }, false)).toBe(false);
  });

  it("is false when nothing is waiting", () => {
    expect(hasWaitingUpdate({ waiting: null }, true)).toBe(false);
  });
});

describe("watchForUpdate", () => {
  it("reports an update that was already waiting at page load", () => {
    const onWaiting = vi.fn();
    const { reg } = makeRegistration({ waiting: { postMessage() {} } });
    watchForUpdate(reg, () => true, { onWaiting, setPoll: () => 0, clearPoll: () => {} });
    expect(onWaiting).toHaveBeenCalledTimes(1);
  });

  it("says nothing when there is no update", () => {
    const onWaiting = vi.fn();
    const { reg } = makeRegistration();
    watchForUpdate(reg, () => true, { onWaiting, setPoll: () => 0, clearPoll: () => {} });
    expect(onWaiting).not.toHaveBeenCalled();
  });

  it("reports one that finishes installing while the page is open", () => {
    const onWaiting = vi.fn();
    const stateListeners: Array<() => void> = [];
    const installing = {
      state: "installing",
      addEventListener: (_t: string, fn: () => void) => stateListeners.push(fn),
    };
    const { reg, fire } = makeRegistration({ waiting: null, installing });

    watchForUpdate(reg, () => true, { onWaiting, setPoll: () => 0, clearPoll: () => {} });
    expect(onWaiting).not.toHaveBeenCalled();

    fire("updatefound");
    // Still installing: nothing is ready to take over yet.
    stateListeners.forEach((fn) => fn());
    expect(onWaiting).not.toHaveBeenCalled();

    (reg as { waiting: unknown }).waiting = { postMessage() {} };
    installing.state = "installed";
    stateListeners.forEach((fn) => fn());
    expect(onWaiting).toHaveBeenCalledTimes(1);
  });

  it("polls for an update, because an installed PWA may never navigate", () => {
    const { reg } = makeRegistration();
    let poll: (() => void) | null = null;
    watchForUpdate(reg, () => true, {
      onWaiting: () => {},
      setPoll: (fn) => {
        poll = fn;
        return 1;
      },
      clearPoll: () => {},
    });
    expect(poll).not.toBeNull();
    poll!();
    expect(reg.update).toHaveBeenCalled();
  });

  it("stops polling when torn down", () => {
    const { reg } = makeRegistration();
    const clearPoll = vi.fn();
    const stop = watchForUpdate(reg, () => true, {
      onWaiting: () => {},
      setPoll: () => 7,
      clearPoll,
    });
    stop();
    expect(clearPoll).toHaveBeenCalledWith(7);
  });
});

describe("applyUpdate", () => {
  it("tells the waiting worker to take over, then reloads once it has", () => {
    const postMessage = vi.fn();
    const reload = vi.fn();
    let onChange: (() => void) | null = null;
    applyUpdate(
      { waiting: { postMessage } },
      { addEventListener: (_t, fn) => (onChange = fn) },
      reload,
    );
    expect(postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    // Not before the worker actually changed — reloading first would drop the
    // page back onto the same old controller.
    expect(reload).not.toHaveBeenCalled();
    onChange!();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads at most once", () => {
    // Another tab accepting an update also fires `controllerchange` here.
    // Reloading a walk out from under an operator because a second tab was
    // tidied up would be worse than the stale bundle this fixes.
    const reload = vi.fn();
    let onChange: (() => void) | null = null;
    applyUpdate(
      { waiting: { postMessage: vi.fn() } },
      { addEventListener: (_t, fn) => (onChange = fn) },
      reload,
    );
    onChange!();
    onChange!();
    onChange!();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does nothing when there is nothing waiting", () => {
    const reload = vi.fn();
    const addEventListener = vi.fn();
    applyUpdate({ waiting: null }, { addEventListener }, reload);
    expect(addEventListener).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});
