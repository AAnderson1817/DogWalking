// Server-side Realtime broadcast via the REST endpoint (no socket needed).
export async function broadcast(
  topic: string,
  event: string,
  payload: unknown,
): Promise<void> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return;
  const res = await fetch(`${url}/realtime/v1/api/broadcast`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      // Must match the client's channel config: a message published as public
      // is not delivered to subscribers of the private topic of the same name,
      // so this is not only the security fix but a correctness one — the
      // client's "walk ended" signal would stop arriving otherwise.
      // The service-role key bypasses RLS, so no realtime.messages policy
      // needs to grant this caller anything.
      messages: [{ topic, event, payload, private: true }],
    }),
  });
  if (!res.ok) throw new Error(`broadcast failed: ${res.status}`);
}
