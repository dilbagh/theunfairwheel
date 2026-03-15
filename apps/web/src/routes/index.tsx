import { SignInButton, useAuth } from "@clerk/clerk-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { FormEvent, useEffect, useState } from "react";
import { IconLogin, IconSpark } from "../components/button-icons";
import { audioEngine } from "../lib/audio";
import { useGroupsApi } from "../lib/groups";
import { buildHomeSeo, SeoHead } from "../lib/seo";
import { getLastGroupId, setLastGroupId } from "../lib/storage";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const navigate = useNavigate();
  const groupsApi = useGroupsApi();
  const queryClient = useQueryClient();
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
      void queryClient.invalidateQueries({ queryKey: ["my-groups"] });
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
    <>
      <SeoHead meta={buildHomeSeo()} />
      <section className="landing-page reveal-up" aria-labelledby="create-group-heading">
        <div className="center-panel create-group-panel landing-hero">
          <div className="landing-hero-copy">
            <p className="eyebrow create-group-eyebrow">The Unfair Wheel</p>
            <h1 id="create-group-heading">Weighted Random Picker for Teams</h1>
            <p className="landing-lede">
              Run fairer recurring selections for standups, demos, retros, and
              team rituals. The wheel increases the odds for people who have not
              won recently, so repeated picks feel balanced instead of arbitrary.
            </p>
          </div>

          <div className="landing-cta">
            <p className="landing-cta-title">Create a private group and spin live.</p>
            <form className="form-stack create-group-form" onSubmit={onSubmit}>
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
                    <span className="btn-content">
                      <IconSpark />
                      <span className="btn-label">
                        {createGroupMutation.isPending ? "Creating..." : "Create Group"}
                      </span>
                    </span>
                  </button>
                </>
              )}
              {!isSignedIn && (
                <SignInButton mode="modal">
                  <button type="button" className="ghost-btn">
                    <span className="btn-content">
                      <IconLogin />
                      <span className="btn-label">Sign In to Create Group</span>
                    </span>
                  </button>
                </SignInButton>
              )}
            </form>

            {error && <p className="error-text create-group-error">{error}</p>}
          </div>
        </div>

        <section className="panel landing-section" aria-labelledby="landing-benefits-heading">
          <div className="landing-section-heading">
            <p className="eyebrow">Why Teams Use It</p>
            <h2 id="landing-benefits-heading">Built for repeated team rituals, not one-off spins</h2>
          </div>
          <div className="landing-grid">
            <article className="landing-card">
              <h3>Fairer repeated selection</h3>
              <p>
                Every active participant gets a weight based on how long it has
                been since they last won. That keeps outcomes random without
                letting the same people dominate recurring rituals.
              </p>
            </article>
            <article className="landing-card">
              <h3>Real-time group updates</h3>
              <p>
                Everyone in the same group sees participant changes, spin state,
                and results update together, which makes the picker work for
                live team sessions.
              </p>
            </article>
            <article className="landing-card">
              <h3>Participant management</h3>
              <p>
                Managers can add or remove participants, keep owners protected,
                and mark people present or absent before each spin.
              </p>
            </article>
            <article className="landing-card">
              <h3>Spin history for context</h3>
              <p>
                Recent results remain visible so the group can understand who
                has been selected lately and why the weighting changes over time.
              </p>
            </article>
          </div>
        </section>

        <section className="panel landing-section" aria-labelledby="landing-use-cases-heading">
          <div className="landing-section-heading">
            <p className="eyebrow">Common Use Cases</p>
            <h2 id="landing-use-cases-heading">A weighted random picker for everyday team decisions</h2>
          </div>
          <ul className="landing-list">
            <li>Choose who gives the demo or standup update next.</li>
            <li>Rotate recurring responsibilities without manual tracking.</li>
            <li>Pick icebreakers, discussion leads, or retro speakers.</li>
            <li>Assign fair turns for support duties, showcases, or reviews.</li>
            <li>Keep recurring rituals random while avoiding repeat winners.</li>
          </ul>
        </section>

        <section className="panel landing-section" aria-labelledby="landing-how-heading">
          <div className="landing-section-heading">
            <p className="eyebrow">How It Works</p>
            <h2 id="landing-how-heading">Simple flow, weighted outcomes</h2>
          </div>
          <ol className="landing-steps">
            <li>Create a private group for your team.</li>
            <li>Add participants and mark who is active for the current session.</li>
            <li>Spin the wheel and let the weighting favor people who have waited longer.</li>
            <li>Review history so the next spin starts from real context, not guesswork.</li>
          </ol>
        </section>

        <section className="panel landing-section" aria-labelledby="landing-faq-heading">
          <div className="landing-section-heading">
            <p className="eyebrow">FAQ</p>
            <h2 id="landing-faq-heading">Questions search visitors usually have</h2>
          </div>
          <div className="landing-faq">
            <article className="landing-card">
              <h3>What makes the picker &quot;unfair&quot;?</h3>
              <p>
                It is intentionally biased toward people who have not won
                recently, which makes repeated random selection feel fairer over
                time for teams.
              </p>
            </article>
            <article className="landing-card">
              <h3>How is weighting calculated?</h3>
              <p>
                Each active participant gets a weight of spins since last win
                plus one, so people who have waited longer gradually get a
                larger share of the wheel.
              </p>
            </article>
            <article className="landing-card">
              <h3>Is this good for recurring team rituals?</h3>
              <p>
                Yes. The app is designed for repeated standups, demos, retros,
                and rotating assignments where pure randomness often feels
                skewed after several rounds.
              </p>
            </article>
            <article className="landing-card">
              <h3>Do participants need accounts?</h3>
              <p>
                Group creation requires sign-in. Participant access can still be
                managed within the private group workflow for ongoing team use.
              </p>
            </article>
          </div>
        </section>
      </section>
    </>
  );
}
