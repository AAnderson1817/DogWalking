// 0057: the subject a recorded notification row must name.
//
// Used by the deps recorders of every function that writes notifications. A
// recorder that rejects on a wrong subject makes the handler under test
// reject, so every test that writes a notice checks its subject without
// asserting it itself, and a new writer is checked the first time any test
// reaches it. The handlers do not catch a failed notification insert, which
// is what makes a rejection here a failing test rather than a swallowed one.

import type { NotificationRow } from "../_lib/notification_row.ts";

/** Why a row names the wrong subject, or null when it names `expected`. */
export function wrongSubject(row: NotificationRow, expected: string | null): string | null {
  if (row.subject_client_id !== expected) {
    return `a ${row.type} notice names subject ${row.subject_client_id}, not ${expected} ` +
      "(0057: an erasure deletes notices by their subject)";
  }
  if (row.client_id !== null && row.client_id !== row.subject_client_id) {
    return `a ${row.type} notice is for ${row.client_id} but about ${row.subject_client_id}`;
  }
  return null;
}

/** The recorder's answer for a row: resolve, or reject naming the problem. */
export function checkSubject(row: NotificationRow, expected: string | null): Promise<void> {
  const problem = wrongSubject(row, expected);
  return problem === null ? Promise.resolve() : Promise.reject(new Error(problem));
}
