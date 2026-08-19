// Notification bell + inbox sheet (phase 08): unread count, mark-read,
// deep links to the walk or billing surface for either persona.
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApprovedIcon } from "./ApprovedIcon";
import { Button } from "./Button";
import { loadErrorMessage } from "./LoadError";
import { Sheet } from "./Sheet";
import { LoadingState, StateField } from "./StateField";
import { listNotifications, markNotificationRead } from "@/lib/api";
import { dateLocal, timeLocal } from "@/lib/format";
import type { Notifications } from "@/lib/types";

function deepLink(n: Notifications, persona: "operator" | "client"): string | null {
  if (n.walk_id) {
    return persona === "operator" ? `/walks/${n.walk_id}/live` : `/portal/walks/${n.walk_id}`;
  }
  switch (n.type) {
    case "payment_failed":
    case "renewal_upcoming":
    case "low_credit":
      return persona === "operator" ? "/billing" : "/portal/billing";
    default:
      return null;
  }
}

export function NotificationBell({ persona }: { persona: "operator" | "client" }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notifications[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const all = await listNotifications();
      setItems(all);
      setUnread(all.filter((n) => n.read_at === null).length);
    } catch (error) {
      setLoadError(loadErrorMessage(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function markRead(n: Notifications) {
    if (!n.read_at) {
      await markNotificationRead(n.id);
      await refresh();
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label={`Inbox, ${unread} unread`}
        className="notification-bell"
      >
        <ApprovedIcon name="inbox" />
        {unread > 0 && (
          <span className="notification-bell__count numeral">
            {unread}
          </span>
        )}
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title="Inbox">
        {loadError ? (
          <StateField
            compact
            tone={/offline|connection/i.test(loadError) ? "information" : "attention"}
            label={/offline|connection/i.test(loadError) ? "Offline" : "Needs attention"}
            title="Couldn't load updates"
            detail={loadError}
            role="alert"
            action={<Button onClick={() => void refresh()}>Retry</Button>}
          />
        ) : items === null ? (
          <LoadingState label="Loading updates" compact />
        ) : items.length === 0 ? (
          <StateField compact title="No updates yet" detail="New activity will appear here." />
        ) : (
          <div className="notification-inbox">
            <p className="notification-inbox__summary">
              {unread} unread {unread === 1 ? "update" : "updates"}
            </p>
            <NotificationList
              items={items.slice(0, 30)}
              onOpen={(notification) => {
                void markRead(notification);
                const link = deepLink(notification, persona);
                if (link) {
                  setOpen(false);
                  navigate(link);
                }
              }}
              onMarkRead={(notification) => void markRead(notification)}
            />
          </div>
        )}
      </Sheet>
    </>
  );
}

export function NotificationList({
  items,
  onOpen,
  onMarkRead,
}: {
  items: Notifications[];
  onOpen: (notification: Notifications) => void;
  onMarkRead: (notification: Notifications) => void;
}) {
  return items.map((notification) => (
    <div
      key={notification.id}
      className={`notification-row${notification.read_at ? "" : " notification-row--unread"}`}
    >
      <button
        type="button"
        className="notification-row__open"
        onClick={() => onOpen(notification)}
        aria-label={`${notification.title}${notification.read_at ? "" : ", Unread"}`}
      >
        <span className="notification-row__heading">
          <strong>{notification.title}</strong>
          {!notification.read_at && <span className="notification-row__unread">Unread</span>}
        </span>
        {notification.body && (
          <span className="notification-row__body">{notification.body}</span>
        )}
        <time className="notification-row__time" dateTime={notification.created_at}>
          {dateLocal(notification.created_at)} · {timeLocal(notification.created_at)}
        </time>
      </button>
      {!notification.read_at && (
        <button
          type="button"
          className="icon-button"
          onClick={() => onMarkRead(notification)}
          aria-label="Mark read"
        >
          <ApprovedIcon name="check" size={16} />
        </button>
      )}
    </div>
  ));
}
