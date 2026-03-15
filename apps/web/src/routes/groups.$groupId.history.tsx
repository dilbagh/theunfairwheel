import { SignInButton } from "@clerk/clerk-react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { IconArrowLeft, IconLogin } from "../components/button-icons";
import { useGroupSession } from "../lib/group-session";
import { buildGroupHistorySeo, SeoHead } from "../lib/seo";

export const Route = createFileRoute("/groups/$groupId/history")({
  component: GroupHistoryPage,
});

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatSpinTimestamp(timestamp: string): string {
  const parsed = new Date(timestamp);

  if (Number.isNaN(parsed.getTime())) {
    return "Invalid timestamp";
  }

  return dateTimeFormatter.format(parsed);
}

function GroupHistoryPage() {
  const { groupId } = Route.useParams();
  const groupSession = useGroupSession(groupId);
  const canLoadHistory = Boolean(groupSession.viewer?.isParticipant || groupSession.viewer?.isOwner);
  const requestHistory = groupSession.request;

  useEffect(() => {
    if (!canLoadHistory) {
      return;
    }

    void requestHistory({
        type: "load.history",
        payload: {},
      })
      .catch(() => {
        // Access and load errors are surfaced through session state.
      });
  }, [canLoadHistory, groupId, requestHistory]);

  if (groupSession.isLoading) {
    return (
      <>
        <SeoHead meta={buildGroupHistorySeo(groupId)} />
        <p className="status-text">Loading history...</p>
      </>
    );
  }

  if (groupSession.error && !groupSession.group) {
    return (
      <>
        <SeoHead meta={buildGroupHistorySeo(groupId)} />
        <section className="center-panel">
          <h1>History Unavailable</h1>
          <p className="muted-text">This group id does not exist or cannot be loaded.</p>
          <Link className="primary-btn link-btn" to="/groups/$groupId" params={{ groupId }}>
            <span className="btn-content">
              <IconArrowLeft />
              <span className="btn-label">Back to Wheel</span>
            </span>
          </Link>
        </section>
      </>
    );
  }

  if (!groupSession.viewer?.isParticipant && !groupSession.viewer?.isOwner) {
    return (
      <>
        <SeoHead meta={buildGroupHistorySeo(groupId)} />
        <section className="center-panel">
          <h1>Access Denied</h1>
          <p className="muted-text">Only participants in this group can view history.</p>
          <SignInButton mode="modal">
            <button type="button" className="ghost-btn">
              <span className="btn-content">
                <IconLogin />
                <span className="btn-label">Log In</span>
              </span>
            </button>
          </SignInButton>
          <div className="modal-actions">
            <Link className="primary-btn link-btn" to="/groups/$groupId" params={{ groupId }}>
              <span className="btn-content">
                <IconArrowLeft />
                <span className="btn-label">Back to Wheel</span>
              </span>
            </Link>
          </div>
        </section>
      </>
    );
  }

  const history = groupSession.history ?? [];

  return (
    <>
      <SeoHead meta={buildGroupHistorySeo(groupId)} />
      <section className="history-layout reveal-up" aria-labelledby="history-heading">
        <header className="panel header-panel history-header">
          <div>
            <p className="eyebrow">Spin History</p>
            <h1 id="history-heading">Recent Spins</h1>
            <p className="muted-text">Showing up to the latest 20 spins.</p>
          </div>
          <Link className="ghost-btn link-btn history-back-btn" to="/groups/$groupId" params={{ groupId }}>
            <span className="btn-content">
              <IconArrowLeft />
              <span className="btn-label">Back to Wheel</span>
            </span>
          </Link>
        </header>

        <section className="panel history-panel" aria-live="polite">
          {history.length === 0 && <p className="muted-text">No spins recorded yet.</p>}

          {history.length > 0 && (
            <ul className="history-list">
              {history.map((item) => {
                const winner =
                  item.participants.find((participant) => participant.id === item.winnerParticipantId)?.name ??
                  item.winnerParticipantId;

                return (
                  <li key={item.id} className="history-item">
                    <p className="history-winner">Winner: {winner}</p>
                    <p className="history-timestamp">{formatSpinTimestamp(item.createdAt)}</p>
                    <p className="history-participants">
                      Participants: {item.participants.map((participant) => participant.name).join(", ")}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </section>
    </>
  );
}
