import { useMemo, useState, type FormEvent } from "react";
import { Button } from "./Button";
import { Input, Textarea } from "./fields";

export interface InboxMessage {
  id: string;
  sender: "client" | "provider";
  senderName: string;
  body: string;
  sentAt: string;
  timeLabel: string;
}

export interface InboxConversation {
  id: string;
  clientId: string;
  petName: string;
  ownerName: string;
  clientSince: number;
  preview: string;
  timeLabel: string;
  unread: boolean;
  messages: InboxMessage[];
}

export function InboxField({
  conversations,
  onNewMessage,
  onViewClient,
  onSend,
}: {
  conversations: InboxConversation[];
  onNewMessage: () => void;
  onViewClient: (clientId: string) => void;
  onSend: (conversationId: string, message: string) => void;
}) {
  const [selectedId, setSelectedId] = useState(conversations[0]?.id ?? null);
  const [mobileView, setMobileView] = useState<"index" | "thread">("index");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const selected = conversations.find((conversation) => conversation.id === selectedId) ?? conversations[0] ?? null;
  const unreadCount = conversations.filter((conversation) => conversation.unread).length;
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return conversations;
    return conversations.filter((conversation) =>
      `${conversation.petName} ${conversation.ownerName} ${conversation.preview}`.toLowerCase().includes(query));
  }, [conversations, search]);

  function selectConversation(id: string) {
    setSelectedId(id);
    setMobileView("thread");
    setDraft("");
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const message = draft.trim();
    if (!selected || !message) return;
    onSend(selected.id, message);
    setDraft("");
  }

  return (
    // A section, not a main element: the landmark is the shell's (AppMain).
    <section className={`inbox-field inbox-field--${mobileView}`} aria-label="Inbox">
      <section className="inbox-index" aria-label="Conversations">
        <header className="inbox-index__header">
          <div>
            <h1>Inbox</h1>
            <p className="inbox-index__count">
              {unreadCount} unread {unreadCount === 1 ? "conversation" : "conversations"}
            </p>
          </div>
          <Button onClick={onNewMessage}>New message</Button>
        </header>

        <div className="inbox-search">
          <Input
            label="Search conversations"
            placeholder="Pet or owner"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <div className="conversation-index" aria-live="polite">
          {filtered.length === 0 ? (
            <p className="conversation-index__empty">No conversations match your search.</p>
          ) : filtered.map((conversation) => {
            const active = selected?.id === conversation.id;
            return (
              <button
                key={conversation.id}
                type="button"
                className={`conversation-row${active ? " conversation-row--selected" : ""}${conversation.unread ? " conversation-row--unread" : ""}`}
                aria-current={active ? "true" : undefined}
                aria-label={`${conversation.petName}, ${conversation.ownerName}, ${conversation.preview}${conversation.unread ? ", Unread" : ""}`}
                onClick={() => selectConversation(conversation.id)}
              >
                <span className="conversation-row__identity">
                  <strong>{conversation.petName}</strong>
                  <span>{conversation.ownerName}</span>
                </span>
                <span className="conversation-row__preview">{conversation.preview}</span>
                <time className="conversation-row__time">{conversation.timeLabel}</time>
                {conversation.unread && (
                  <span className="conversation-row__unread-label">
                    <span aria-hidden className="conversation-row__unread-dot" />
                    Unread
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>

      <section className="inbox-thread" aria-label={selected ? `Conversation with ${selected.ownerName}` : "Conversation"}>
        {selected ? (
          <>
            <header className="inbox-thread__header">
              <button
                type="button"
                className="text-button inbox-thread__back"
                onClick={() => setMobileView("index")}
              >
                Back to Inbox
              </button>
              <div className="inbox-thread__identity">
                <h2>{selected.petName}</h2>
                <p>{selected.ownerName} / Client since {selected.clientSince}</p>
              </div>
              <Button variant="ghost" onClick={() => onViewClient(selected.clientId)}>
                View client
              </Button>
            </header>

            <div className="message-history" role="log" aria-label="Message history">
              {selected.messages.map((message) => (
                <article
                  key={message.id}
                  className={`message-field message-field--${message.sender}`}
                  aria-label={`${message.senderName} at ${message.timeLabel}`}
                >
                  <div className="message-field__meta">
                    <strong>{message.senderName}</strong>
                    <time dateTime={message.sentAt}>{message.timeLabel}</time>
                  </div>
                  <p>{message.body}</p>
                </article>
              ))}
            </div>

            <form className="message-composer" onSubmit={submit}>
              <Textarea
                label="Write a message"
                rows={2}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
              <Button type="submit" disabled={!draft.trim()}>Send</Button>
            </form>
          </>
        ) : (
          <p className="inbox-thread__empty">Select a conversation.</p>
        )}
      </section>
    </section>
  );
}
