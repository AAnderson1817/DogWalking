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

describe("serial push repairs", () => {
  it("never runs two at once", async () => {
    // The second is scheduled once the first is genuinely IN FLIGHT, which is
    // what the provider does — `applyRole` is async, so a sign-out's repair
    // has always started before a following sign-in's is queued. Scheduling
    // both in one tick would instead exercise rule 2 and assert nothing about
    // overlap, which is how the first draft of this passed against a runner
    // with no serialisation at all.
    const log: string[] = [];
    const run = createSerialRunner();
    run(tracked(log, "forget"));
    await new Promise((r) => setTimeout(r, 5));
    run(tracked(log, "reclaim"));
    await settle();
    expect(log.join(" "), "one of them did not run").toBe(
      "forget:start forget:end reclaim:start reclaim:end",
    );
    expect(overlapped(log), log.join(" ")).toBe(false);
  });

  it("drops every repair superseded before it starts, same tick included", async () => {
    // The case that matters: a sign-out immediately superseded by a sign-in
    // should reassign this device to the new account, NOT unsubscribe it
    // first and leave that account with push silently off.
    const log: string[] = [];
    const run = createSerialRunner();
    run(tracked(log, "first"));
    run(tracked(log, "superseded"));
    run(tracked(log, "latest"));
    await settle();
    expect(log.join(" ")).toBe("latest:start latest:end");
  });

  it("does not interrupt one that is already running", async () => {
    // There is nothing to interrupt it with, and a half-applied unsubscribe is
    // worse than a completed one.
    const log: string[] = [];
    const run = createSerialRunner();
    run(tracked(log, "running"));
    await new Promise((r) => setTimeout(r, 5));
    run(tracked(log, "next"));
    await settle();
    expect(log.join(" ")).toBe("running:start running:end next:start next:end");
  });

  it("a rejection never escapes, and never stalls the queue", async () => {
    // These run inside the auth transition. A repair that throws must not
    // stand between anyone and being signed out, and must not wedge the one
    // after it.
    const log: string[] = [];
    const run = createSerialRunner();
    run(() => Promise.reject(new Error("worker gone")));
    run(tracked(log, "after"));
    await settle();
    expect(log.join(" ")).toBe("after:start after:end");
  });
});

describe("a running repair is told when it is superseded", () => {
  it("reports true once a newer transition arrives mid-flight", async () => {
    // Rule 2 cannot reach a repair that has already started, and `applyRole`
    // awaits a database query before queueing the reclaim — so a sign-out's
    // cleanup has ALWAYS started by then. Without this, it went on to
    // unsubscribe and the newly signed-in account was left with push off.
    const seen: boolean[] = [];
    const run = createSerialRunner();
    run(async (superseded) => {
      seen.push(superseded()); // nothing has superseded it yet
      await new Promise((r) => setTimeout(r, 30));
      seen.push(superseded()); // …but by now the sign-in has arrived
    });
    await new Promise((r) => setTimeout(r, 5));
    run(async () => {});
    await settle();
    expect(seen).toEqual([false, true]);
  });

  it("reports false throughout when nothing supersedes it", async () => {
    // The other direction: a predicate that always says yes would make every
    // repair stand down and quietly disable both of them.
    const seen: boolean[] = [];
    const run = createSerialRunner();
    run(async (superseded) => {
      seen.push(superseded());
      await new Promise((r) => setTimeout(r, 20));
      seen.push(superseded());
    });
    await settle();
    expect(seen).toEqual([false, false]);
  });
});
