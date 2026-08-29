import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InboxField, type InboxConversation } from "./InboxField";

const CONVERSATIONS: InboxConversation[] = [
  {
    id: "conversation-1",
    clientId: "client-1",
    petName: "Biscuit",
    ownerName: "Amelia Hart",
    clientSince: 2024,
    preview: "The gate code changed this morning.",
    timeLabel: "9:42 AM",
    unread: true,
    messages: [
      {
        id: "message-1",
        sender: "client",
        senderName: "Amelia",
        body: "The gate code changed this morning.",
        sentAt: "2026-08-05T14:42:00Z",
        timeLabel: "9:42 AM",
      },
      {
        id: "message-2",
        sender: "provider",
        senderName: "You",
        body: "Thank you. I will check it before the walk.",
        sentAt: "2026-08-05T14:44:00Z",
        timeLabel: "9:44 AM",
      },
    ],
  },
];

describe("InboxField", () => {
  it("renders the approved correspondence hierarchy and exact controls", () => {
    const html = renderToStaticMarkup(
      <InboxField
        conversations={CONVERSATIONS}
        onNewMessage={() => undefined}
        onViewClient={() => undefined}
        onSend={() => undefined}
      />,
    );
    expect(html.indexOf("Biscuit")).toBeLessThan(html.indexOf("Amelia Hart"));
    expect(html).toContain("New message");
    expect(html).toContain("Search conversations");
    expect(html).toContain("View client");
    expect(html).toContain("Write a message");
    expect(html).toContain(">Send<");
    expect(html).toContain("Unread");
    expect(html).toContain('role="log"');
  });
});
