import { SignInButton, useAuth } from "@clerk/clerk-react";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { FormEvent, useEffect, useState } from "react";
import { audioEngine } from "../lib/audio";
import { useGroupsApi } from "../lib/groups";
import { getLastGroupId, setLastGroupId } from "../lib/storage";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const navigate = useNavigate();
  const groupsApi = useGroupsApi();
  const { isSignedIn } = useAuth();
  const [groupName, setGroupName] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const lastGroupId = getLastGroupId();

    if (lastGroupId) {
      void navigate({
        to: "/groups/$groupId",
        params: { groupId: lastGroupId },
        replace: true,
      });
      return;
    }

    setReady(true);
  }, [navigate]);

  const createGroupMutation = useMutation({
    mutationFn: (name: string) => groupsApi.createGroup({ name }),
    onSuccess: (group) => {
      setLastGroupId(group.id);
      void navigate({
        to: "/groups/$groupId",
        params: { groupId: group.id },
        replace: true,
      });
    },
    onError: (mutationError: Error) => {
      setError(mutationError.message);
    },
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    void audioEngine.playClick();

    if (!isSignedIn) {
      setError("Sign in to create a group.");
      return;
    }

    const normalized = groupName.trim();
    if (!normalized) {
      setError("Group name is required.");
      return;
    }

    createGroupMutation.mutate(normalized);
  };

  if (!ready) {
    return <p className="status-text">Opening your game lobby...</p>;
  }

  return (
    <section className="center-panel reveal-up" aria-labelledby="create-group-heading">
      <p className="eyebrow">The Unfair Wheel</p>
      <h1 id="create-group-heading">Create Your Group</h1>

      <form className="form-stack" onSubmit={onSubmit}>
        {isSignedIn && (
          <>
            <label htmlFor="groupName" className="field-label">
              Group Name
            </label>
            <input
              id="groupName"
              name="groupName"
              className="text-input"
              placeholder="Friday Product Squad"
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
              maxLength={60}
              required
            />
            <button
              type="submit"
              className="primary-btn"
              disabled={createGroupMutation.isPending}
            >
              {createGroupMutation.isPending ? "Creating..." : "Create Group"}
            </button>
          </>
        )}
        {!isSignedIn && (
          <SignInButton mode="modal">
            <button type="button" className="ghost-btn">
              Sign In to Create Group
            </button>
          </SignInButton>
        )}
      </form>

      {error && <p className="error-text">{error}</p>}
    </section>
  );
}
