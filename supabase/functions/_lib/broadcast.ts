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
      messages: [{ topic, event, payload, private: false }],
    }),
  });
  if (!res.ok) throw new Error(`broadcast failed: ${res.status}`);
}
