// Notification bell + inbox sheet (phase 08): unread count, mark-read,
// deep links to the walk or billing surface for either persona.
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Sheet } from "./Sheet";
import { Spinner } from "./Spinner";
import { listNotifications, markNotificationRead } from "@/lib/api";
import { dateLondon, timeLondon } from "@/lib/format";
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
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    const all = await listNotifications();
    setItems(all);
    setUnread(all.filter((n) => n.read_at === null).length);
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
        aria-label={`Notifications, ${unread} unread`}
        style={{
          position: "relative",
          background: "var(--surface)",
          border: 0,
          borderRadius: "var(--r-full)",
          width: 44,
          height: 44,
          boxShadow: "var(--shadow-1)",
          cursor: "pointer",
          fontSize: "var(--fs-20)",
        }}
      >
        🔔
        {unread > 0 && (
          <span
            className="numeral"
            style={{
              position: "absolute",
              top: -4,
              right: -4,
              background: "var(--teal-live)",
              color: "var(--pine-950)",
              borderRadius: "var(--r-full)",
              fontSize: "var(--fs-12)",
              fontWeight: 700,
              minWidth: 20,
              height: 20,
              display: "grid",
              placeItems: "center",
              padding: "0 4px",
            }}
          >
            {unread}
          </span>
        )}
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title="Notifications">
        {items === null ? (
          <Spinner />
        ) : items.length === 0 ? (
          <p style={{ color: "var(--text-2)" }}>Nothing yet.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {items.slice(0, 30).map((n) => {
              const link = deepLink(n, persona);
              return (
                <div
                  key={n.id}
                  onClick={() => {
                    void markRead(n);
                    if (link) {
                      setOpen(false);
                      navigate(link);
                    }
                  }}
                  style={{
                    display: "flex",
                    gap: "var(--s-2)",
                    padding: "var(--s-3) 0",
                    borderBottom: "1px solid var(--mist)",
                    cursor: link ? "pointer" : "default",
                    opacity: n.read_at ? 0.55 : 1,
                  }}
                >
                  {!n.read_at && <span className="pulse-live" style={{ marginTop: 6, flexShrink: 0 }} aria-label="unread" />}
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: "var(--fs-14)" }}>{n.title}</div>
                    {n.body && (
                      <div style={{ color: "var(--text-2)", fontSize: "var(--fs-14)" }}>{n.body}</div>
                    )}
                    <div style={{ color: "var(--ink-faint)", fontSize: "var(--fs-12)", marginTop: 2 }}>
                      {dateLondon(n.created_at)} · {timeLondon(n.created_at)}
                    </div>
                  </div>
                  {!n.read_at && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void markRead(n);
                      }}
                      aria-label="Mark read"
                      style={{ background: "none", border: 0, color: "var(--pine-600)", cursor: "pointer", fontWeight: 700 }}
                    >
                      ✓
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Sheet>
    </>
  );
}
