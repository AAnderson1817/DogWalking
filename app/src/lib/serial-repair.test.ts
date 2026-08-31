import { describe, expect, it } from "vitest";
import { createSerialRunner } from "./serial-repair";

/** A repair that records when it starts and finishes, so OVERLAP is visible. */
function tracked(log: string[], name: string, ms = 20) {
  return () =>
    new Promise<void>((resolve) => {
      log.push(`${name}:start`);
      setTimeout(() => {
        log.push(`${name}:end`);
        resolve();
      }, ms);
    });
}

function overlapped(log: string[]): boolean {
  let running = 0;
  for (const entry of log) {
    if (entry.endsWith(":start")) {
      if (running > 0) return true;
      running += 1;
    } else running -= 1;
  }
  return false;
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

/**
 * The caller owns the version — it is the AUTH TRANSITION's, not the
 * scheduling moment's. `transitions()` models a provider bumping it on
 * arrival, which is the whole point of the fifteenth round's finding.
 */
function harness() {
  let version = 0;
  const run = createSerialRunner(() => version);
  return { run, arrive: () => ++version, at: () => version };
}

describe("serial push repairs", () => {
  it("never runs two at once", async () => {
    // The second is scheduled once the first is genuinely IN FLIGHT, which is
    // what the provider does. Scheduling both against the same version would
    // instead exercise rule 2 and assert nothing about overlap.
    const log: string[] = [];
    const h = harness();
    h.run(tracked(log, "forget"), h.arrive());
    await new Promise((r) => setTimeout(r, 5));
    h.run(tracked(log, "reclaim"), h.at());
    await settle();
    expect(log.join(" "), "one of them did not run").toBe(
      "forget:start forget:end reclaim:start reclaim:end",
    );
    expect(overlapped(log), log.join(" ")).toBe(false);
  });

  it("drops a repair whose transition has been superseded before it starts", async () => {
    // Including one scheduled in the same tick: a sign-out immediately
    // superseded by a sign-in should reassign this device to the new account,
    // not unsubscribe it first and leave that account with push off.
    const log: string[] = [];
    const h = harness();
    h.run(tracked(log, "first"), h.arrive());
    h.run(tracked(log, "superseded"), h.arrive());
    h.run(tracked(log, "latest"), h.arrive());
    await settle();
    expect(log.join(" ")).toBe("latest:start latest:end");
  });

  it("drops a LATE repair from a transition that has since been superseded", async () => {
    // The dangerous direction (Codex review on PR #85, fifteenth round). A
    // role lookup begun before a sign-out can finish after it; queueing its
    // reclaim as the newest repair made the sign-out's cleanup stand down
    // while the previous account's subscription stayed live — the
    // shared-device leak the cleanup exists to close.
    const log: string[] = [];
    const h = harness();
    const stale = h.arrive(); // the sign-in, whose role lookup is slow
    h.arrive(); // …then the sign-out arrives
    h.run(tracked(log, "stale-reclaim"), stale);
    await settle();
    expect(log.join(" "), "a repair from a superseded transition ran").toBe("");
  });

  it("does not interrupt one that is already running", async () => {
    // There is nothing to interrupt it with, and a half-applied unsubscribe is
    // worse than a completed one. It is TOLD instead — see below.
    const log: string[] = [];
    const h = harness();
    h.run(tracked(log, "running"), h.arrive());
    await new Promise((r) => setTimeout(r, 5));
    h.run(tracked(log, "next"), h.arrive());
    await settle();
    expect(log.join(" ")).toBe("running:start running:end next:start next:end");
  });

  it("a rejection never escapes, and never stalls the queue", async () => {
    // These run inside the auth transition. A repair that throws must not
    // stand between anyone and being signed out, and must not wedge the one
    // after it.
    const log: string[] = [];
    const h = harness();
    h.run(() => Promise.reject(new Error("worker gone")), h.arrive());
    h.run(tracked(log, "after"), h.at());
    await settle();
    expect(log.join(" ")).toBe("after:start after:end");
  });
});

describe("a running repair is told when it is superseded", () => {
  it("reports true as soon as the next TRANSITION arrives, not when a repair is scheduled", async () => {
    // The fifteenth round's other half. Keyed on scheduling, a running cleanup
    // only learned it had been superseded once the reclaim was queued — after
    // a database round trip, long after two service-worker lookups finish — so
    // it never learned in time and unsubscribed anyway.
    const seen: boolean[] = [];
    const h = harness();
    h.run(async (superseded) => {
      seen.push(superseded());
      await new Promise((r) => setTimeout(r, 30));
      seen.push(superseded());
    }, h.arrive());
    await new Promise((r) => setTimeout(r, 5));
    h.arrive(); // the transition arrives; NO repair is scheduled for it yet
    await settle();
    expect(seen).toEqual([false, true]);
  });

  it("reports false throughout when nothing supersedes it", async () => {
    // A predicate that always said yes would make every repair stand down and
    // quietly disable both of them.
    const seen: boolean[] = [];
    const h = harness();
    h.run(async (superseded) => {
      seen.push(superseded());
      await new Promise((r) => setTimeout(r, 20));
      seen.push(superseded());
    }, h.arrive());
    await settle();
    expect(seen).toEqual([false, false]);
  });
});
