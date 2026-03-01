import {
  SignedIn,
  SignedOut,
  SignInButton,
  UserButton,
  useUser,
} from "@clerk/clerk-react";
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, createRootRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { type GroupSummary, useGroupsApi } from "../lib/groups";

export const Route = createRootRoute({
  component: RootComponent,
});

const EMPTY_GROUPS: GroupSummary[] = [];

function RootComponent() {
  const groupsApi = useGroupsApi();
  const { user } = useUser();
  const [isGroupSelectorOpen, setIsGroupSelectorOpen] = useState(false);

  const myGroupsQuery = useQuery({
    queryKey: ["my-groups"],
    queryFn: () => groupsApi.listMyGroups(),
    enabled: isGroupSelectorOpen,
  });
  const bookmarkedGroupIdsQuery = useQuery({
    queryKey: ["group-bookmarks"],
    queryFn: () => groupsApi.listBookmarkedGroupIds(),
    enabled: isGroupSelectorOpen && Boolean(user),
  });

  const groups = myGroupsQuery.data ?? EMPTY_GROUPS;
  const bookmarkedGroupIds = bookmarkedGroupIdsQuery.data ?? [];
  const ownedGroups = useMemo(
    () => groups.filter((group) => user && group.ownerUserId === user.id),
    [groups, user],
  );
  const bookmarkedGroups = useMemo(() => {
    if (!user) {
      return [];
    }

    const bookmarkedIds = new Set(bookmarkedGroupIds);
    return groups.filter(
      (group) => group.ownerUserId !== user.id && bookmarkedIds.has(group.id),
    );
  }, [bookmarkedGroupIds, groups, user]);
  const isLoadingModalData =
    myGroupsQuery.isLoading || bookmarkedGroupIdsQuery.isLoading;
  const hasModalDataError =
    myGroupsQuery.isError || bookmarkedGroupIdsQuery.isError;

  return (
    <div className="app-shell">
      <div className="bg-layer bg-layer-one" aria-hidden />
      <div className="bg-layer bg-layer-two" aria-hidden />

      <div className="app-frame">
        <header className="global-nav panel" aria-label="Main navigation">
          <Link to="/" className="brand-link">
            <span className="brand-mark" aria-hidden>
              ◉
            </span>
            <span className="brand-name">The Unfair Wheel</span>
          </Link>
          <div className="global-nav-actions">
            <SignedIn>
              <button
                type="button"
                className="ghost-btn nav-groups-btn"
                onClick={() => {
                  setIsGroupSelectorOpen(true);
                }}
              >
                My Groups
              </button>
              <UserButton />
            </SignedIn>
            <SignedOut>
              <SignInButton mode="modal">
                <button type="button" className="ghost-btn">
                  Log In
                </button>
              </SignInButton>
            </SignedOut>
          </div>
        </header>

        <main className="page-wrap">
          <Outlet />
        </main>

        <footer className="global-footer panel" aria-label="App footer">
          <p className="footer-copy">Developed by AI - Crafted by Dilbagh</p>
          <div className="footer-socials" aria-label="Social links">
            <a
              className="ghost-btn icon-btn footer-social-link"
              href="https://github.com/dilbagh/theunfairwheel"
              target="_blank"
              rel="noreferrer"
              aria-label="GitHub"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M12 .5A12 12 0 0 0 8.2 23.9c.6.1.8-.2.8-.6v-2.3c-3.3.7-4-1.6-4-1.6-.5-1.4-1.3-1.8-1.3-1.8-1-.8.1-.8.1-.8 1.2.1 1.8 1.2 1.8 1.2 1 1.7 2.7 1.2 3.3.9.1-.8.4-1.2.7-1.5-2.7-.3-5.5-1.4-5.5-6.1 0-1.4.5-2.6 1.2-3.5-.1-.3-.5-1.6.1-3.3 0 0 1-.3 3.7 1.3a12.9 12.9 0 0 1 6.8 0c2.6-1.6 3.7-1.3 3.7-1.3.7 1.7.2 3 .1 3.3.8.9 1.2 2.1 1.2 3.5 0 4.7-2.8 5.8-5.5 6.1.4.4.8 1 .8 2.1v3.1c0 .4.2.7.8.6A12 12 0 0 0 12 .5Z"
                />
              </svg>
            </a>
            <a
              className="ghost-btn icon-btn footer-social-link"
              href="https://www.linkedin.com/in/dilbagh/"
              target="_blank"
              rel="noreferrer"
              aria-label="LinkedIn"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M20.4 20.5h-3.6v-5.7c0-1.4 0-3.2-2-3.2s-2.3 1.5-2.3 3.1v5.8H9V9h3.4v1.6h.1c.5-.9 1.6-1.9 3.3-1.9 3.6 0 4.2 2.3 4.2 5.4v6.4ZM5 7.4a2.1 2.1 0 1 1 0-4.2 2.1 2.1 0 0 1 0 4.2ZM6.8 20.5H3.1V9h3.7v11.5ZM22 0H2C.9 0 0 .9 0 2v20c0 1.1.9 2 2 2h20c1.1 0 2-.9 2-2V2c0-1.1-.9-2-2-2Z"
                />
              </svg>
            </a>
          </div>
        </footer>
      </div>

      {isGroupSelectorOpen && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal group-selector-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="group-selector-heading"
          >
            <h2 id="group-selector-heading">My Groups</h2>
            <p className="muted-text">
              Owned or bookmarked groups tied to your account.
            </p>

            {isLoadingModalData && (
              <p className="status-text">Loading groups...</p>
            )}
            {hasModalDataError && (
              <p className="error-text">
                Unable to load your groups right now.
              </p>
            )}
            {!isLoadingModalData &&
              !hasModalDataError &&
              ownedGroups.length === 0 &&
              bookmarkedGroups.length === 0 && (
                <p className="muted-text">
                  No owned or bookmarked groups yet. Create your first group
                  from the home page.
                </p>
              )}

            {!isLoadingModalData &&
              !hasModalDataError &&
              ownedGroups.length > 0 && (
                <section
                  className="group-selector-section"
                  aria-label="Owned groups"
                >
                  <p className="eyebrow">Owned by You</p>
                  <ul className="group-selector-list">
                    {ownedGroups.map((group) => (
                      <li key={group.id}>
                        <Link
                          className="ghost-btn link-btn group-selector-link"
                          to="/groups/$groupId"
                          params={{ groupId: group.id }}
                          onClick={() => {
                            setIsGroupSelectorOpen(false);
                          }}
                        >
                          {group.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

            {!isLoadingModalData &&
              !hasModalDataError &&
              bookmarkedGroups.length > 0 && (
                <section
                  className="group-selector-section"
                  aria-label="Bookmarked groups"
                >
                  <p className="eyebrow">Bookmarks</p>
                  <ul className="group-selector-list">
                    {bookmarkedGroups.map((group) => (
                      <li key={group.id}>
                        <Link
                          className="ghost-btn link-btn group-selector-link"
                          to="/groups/$groupId"
                          params={{ groupId: group.id }}
                          onClick={() => {
                            setIsGroupSelectorOpen(false);
                          }}
                        >
                          {group.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

            <div className="modal-actions">
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  setIsGroupSelectorOpen(false);
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
