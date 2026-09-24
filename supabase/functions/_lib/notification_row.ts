/**
 * A notification row as the edge functions insert it (0057).
 *
 * `client_id` decides who may READ the row: the client, or NULL for the
 * walker (the RLS policies read it). `subject_client_id` is who the row is
 * ABOUT, and it is what `fn_purge_client` deletes by. Before 0057 a row the
 * walker reads named its client only in its title, so erasing the client left
 * "Jane Doe's top-up payment failed" in the walker's inbox.
 *
 * Required rather than optional, so every writer decides: NULL only for a row
 * about no client (the walker's own Sanpo subscription). The database fills a
 * missing subject from `client_id` or the walk, and checks any subject given
 * against both and against the operator, so naming it is never wrong; leaving
 * it out on a row with neither is the defect.
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
