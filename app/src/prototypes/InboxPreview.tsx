// Dev-only harness for the `InboxField` prototype in this directory. Renders
// fixtures; there is no messages table behind it (review H33).
import { useState } from "react";
import { BottomNav } from "@/components/BottomNav";
import {
  InboxField,
  type InboxConversation,
  type InboxMessage,
} from "./InboxField";

const FIXTURES: InboxConversation[] = [
  {
    id: "biscuit",
    clientId: "amelia",
    petName: "Biscuit",
    ownerName: "Amelia Hart",
    clientSince: 2024,
    preview: "The gate code changed this morning.",
    timeLabel: "9:42 AM",
    unread: true,
    messages: [
      {
        id: "biscuit-1",
        sender: "client",
        senderName: "Amelia",
        body: "Good morning. The gate code changed this morning — it is now 1842.",
        sentAt: "2026-08-05T14:42:00Z",
        timeLabel: "9:42 AM",
      },
      {
        id: "biscuit-2",
        sender: "provider",
        senderName: "You",
        body: "Thank you. I will check it before Biscuit's walk this afternoon.",
        sentAt: "2026-08-05T14:46:00Z",
        timeLabel: "9:46 AM",
      },
      {
        id: "biscuit-3",
        sender: "client",
        senderName: "Amelia",
        body: "Perfect, thank you! His raincoat is on the entry bench.",
        sentAt: "2026-08-05T14:48:00Z",
        timeLabel: "9:48 AM",
      },
    ],
  },
  {
    id: "mochi",
    clientId: "mira",
    petName: "Mochi",
    ownerName: "Mira Chen",
    clientSince: 2025,
    preview: "Could we move Friday to 2:30?",
    timeLabel: "Yesterday",
    unread: true,
    messages: [
      {
        id: "mochi-1",
        sender: "client",
        senderName: "Mira",
        body: "Could we move Friday to 2:30? The usual time overlaps with a vet appointment.",
        sentAt: "2026-08-04T19:18:00Z",
        timeLabel: "Yesterday, 2:18 PM",
      },
    ],
  },
  {
    id: "nova",
    clientId: "jordan",
    petName: "Nova",
    ownerName: "Jordan Lee",
    clientSince: 2023,
    preview: "The park loop was lovely today.",
    timeLabel: "Mon",
    unread: false,
    messages: [
      {
        id: "nova-1",
        sender: "provider",
        senderName: "You",
        body: "The park loop was lovely today. Nova had water when we returned.",
        sentAt: "2026-08-03T21:10:00Z",
        timeLabel: "Monday, 4:10 PM",
      },
      {
        id: "nova-2",
        sender: "client",
        senderName: "Jordan",
        body: "Great — thank you for the update.",
        sentAt: "2026-08-03T21:25:00Z",
        timeLabel: "Monday, 4:25 PM",
      },
    ],
  },
];

export default function InboxPreview() {
  const [conversations, setConversations] = useState(FIXTURES);

  function send(conversationId: string, body: string) {
    const message: InboxMessage = {
      id: `local-${Date.now()}`,
      sender: "provider",
      senderName: "You",
      body,
      sentAt: new Date().toISOString(),
      timeLabel: "Now",
    };
    setConversations((current) => current.map((conversation) =>
      conversation.id === conversationId
        ? { ...conversation, preview: body, timeLabel: "Now", messages: [...conversation.messages, message] }
        : conversation));
  }

  return (
    <div className="inbox-preview-page">
      <InboxField
        conversations={conversations}
        onNewMessage={() => undefined}
        onViewClient={() => undefined}
        onSend={send}
      />
      <BottomNav persona="operator" />
    </div>
  );
}
