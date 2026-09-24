/**
 * A notification row as the edge functions insert it (0057).
 *
 * `client_id` decides who may READ the row: the client, or NULL for the
 * walker (the RLS policies read it). `subject_client_id` is who the row is
 * ABOUT, and it is what `fn_purge_client` deletes by. Before 0057 a row the
 * walker reads named its client only in its title, so erasing the client left
 * "Jane Doe's top-up payment failed" in the walker's inbox.
 *
 * Required rather than optional, so every writer decides. NULL for a row that
 * carries nothing of any client's and must outlive their erasure: the
 * walker's own Sanpo subscription, and a refund or dispute alert, which names
 * only an amount and asks the walker to act. The database fills a missing
 * subject from `client_id` or the walk, and checks any subject given against
 * both and against the operator; leaving it out on a row that names a client
 * only in its words is the defect. A row about a client who has been erased
 * is not written at all (0057).
 */
export interface NotificationRow {
  operator_id: string;
  client_id: string | null;
  subject_client_id: string | null;
  type: string;
  title: string;
  body: string;
  walk_id: string | null;
}
