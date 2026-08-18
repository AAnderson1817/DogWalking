import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Unmount between tests. Without this, effects from a previous test keep
// running — timers, subscriptions, wake locks — and the failure they cause
// lands in whichever test happens to be next, which is the hardest kind of
// flake to read.
afterEach(() => {
  cleanup();
});
