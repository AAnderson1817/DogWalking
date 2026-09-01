import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotificationList } from "./NotificationInbox";
import type { Notifications } from "@/lib/types";

const ITEMS: Notifications[] = [
  {
    id: "notification-1",
    operator_id: "operator-1",
    client_id: "client-1",
    type: "walk_complete",
    title: "Walk report ready",
    body: "Biscuit's route and notes are ready.",
    walk_id: "walk-1",
    read_at: null,
    created_at: "2026-08-05T14:42:00Z",
    updated_at: "2026-08-05T14:42:00Z",
    email_status: "sent",
    email_attempts: 1,
    email_sent_at: "2026-08-05T14:43:00Z",
    email_last_error: null,
  push_status: "skipped",
  push_attempts: 0,
  push_sent_at: null,
  push_last_error: null,
  email_claimed_at: null,
  push_claimed_at: null,
  email_claim_token: null,
  push_claim_token: null,
  },
];

describe("NotificationList", () => {
  it("uses separate native controls and a visible unread state", () => {
    const html = renderToStaticMarkup(
      <NotificationList items={ITEMS} onOpen={() => undefined} onMarkRead={() => undefined} />,
    );
    expect(html).toContain('aria-label="Walk report ready, Unread"');
    expect(html).toContain(">Unread<");
    expect(html).toContain('aria-label="Mark read"');
    expect(html.match(/<button/g)).toHaveLength(2);
    const firstOpen = html.indexOf("<button");
    const firstClose = html.indexOf("</button>", firstOpen);
    const secondOpen = html.indexOf("<button", firstOpen + 1);
    expect(firstClose).toBeLessThan(secondOpen);
  });
});
