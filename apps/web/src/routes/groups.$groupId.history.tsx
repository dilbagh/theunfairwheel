import { SignInButton } from "@clerk/clerk-react";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ApiError, useCurrentUserEmailSet, useGroupsApi } from "../lib/groups";

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
  const groupsApi = useGroupsApi();
  const userEmails = useCurrentUserEmailSet();

  const participantsQuery = useQuery({
    queryKey: ["participants", groupId],
    queryFn: () => groupsApi.listParticipants({ groupId }),
  });

  const hasAccess = (participantsQuery.data ?? []).some(
    (participant) =>
      typeof participant.emailId === "string" &&
      userEmails.has(participant.emailId.trim().toLowerCase()),
  );

  const historyQuery = useQuery({
    queryKey: ["spin-history", groupId],
    queryFn: () => groupsApi.listSpinHistory({ groupId }),
    enabled: hasAccess,
    retry: (failureCount, error) => {
      if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
        return false;
      }

      return failureCount < 3;
    },
  });

  if (participantsQuery.isLoading) {
    return <p className="status-text">Loading access...</p>;
  }

  if (participantsQuery.isError) {
    return (
      <section className="center-panel">
        <h1>History Unavailable</h1>
        <p className="muted-text">This group id does not exist or cannot be loaded.</p>
        <Link className="primary-btn link-btn" to="/groups/$groupId" params={{ groupId }}>
          Back to wheel
        </Link>
      </section>
    );
  }

  if (!hasAccess) {
    return (
      <section className="center-panel">
        <h1>Access Denied</h1>
        <p className="muted-text">Only participants in this group can view history.</p>
        <SignInButton mode="modal">
          <button type="button" className="ghost-btn">Log In</button>
        </SignInButton>
        <div className="modal-actions">
          <Link className="primary-btn link-btn" to="/groups/$groupId" params={{ groupId }}>
            Back to wheel
          </Link>
        </div>
      </section>
    );
  }

  if (historyQuery.isLoading) {
    return <p className="status-text">Loading history...</p>;
  }

  if (historyQuery.isError) {
    return (
      <section className="center-panel">
        <h1>History Unavailable</h1>
        <p className="muted-text">This group id does not exist or cannot be loaded.</p>
        <Link className="primary-btn link-btn" to="/groups/$groupId" params={{ groupId }}>
          Back to wheel
        </Link>
      </section>
    );
  }

  const history = historyQuery.data ?? [];

  return (
    <section className="history-layout reveal-up" aria-labelledby="history-heading">
      <header className="panel header-panel history-header">
        <div>
          <p className="eyebrow">Spin History</p>
          <h1 id="history-heading">Recent Spins</h1>
          <p className="muted-text">Showing up to the latest 20 spins.</p>
        </div>
        <Link className="ghost-btn link-btn history-back-btn" to="/groups/$groupId" params={{ groupId }}>
          Back to wheel
        </Link>
      </header>

      <section className="panel history-panel" aria-live="polite">
        {history.length === 0 && <p className="muted-text">No spins recorded yet.</p>}

        {history.length > 0 && (
          <ul className="history-list">
            {history.map((item) => {
              const winner =
                item.participants.find((participant) => participant.id === item.winnerParticipantId)
                  ?.name ?? item.winnerParticipantId;

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
  );
}
