import Link from "next/link";
import { LoomSculpture } from "./loom-sculpture";

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d={diagonal ? "M5 15 15 5M5 5h10v10" : "M4 10h12m-5-5 5 5-5 5"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LoomMark() {
  return (
    <svg viewBox="0 0 30 30" fill="none" aria-hidden="true">
      <path
        d="M5 4v15a6 6 0 0 0 6 6h15M11 4v12a3 3 0 0 0 3 3h12M17 4v9h9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function LandingPage() {
  return (
    <div className="loom-landing">
      <a className="loom-skip" href="#loom-main">
        Skip to content
      </a>
      <header className="loom-nav">
        <Link href="/" className="loom-wordmark" aria-label="Loom home">
          <LoomMark />
          <span>
            loom<span className="loom-wordmark-dot">.</span>
          </span>
        </Link>
        <nav className="loom-nav-links" aria-label="Main navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#team-insights">Team insights</a>
          <Link href="/login">Sign in</Link>
        </nav>
        <Link href="/register" className="loom-button loom-button-small">
          Create your company <Arrow diagonal />
        </Link>
      </header>

      <main id="loom-main">
        <section className="loom-hero" aria-labelledby="loom-hero-title">
          <div className="loom-hero-copy">
            <p className="loom-eyebrow">
              <span className="loom-signal" /> Built for small analytics teams
            </p>
            <h1 id="loom-hero-title">
              Less chasing.
              <br />
              <span>More analysis.</span>
            </h1>
            <p className="loom-hero-description">
              Bring the loose ends together. Give every data request the
              context, owner, and next step it needs.
            </p>
            <div className="loom-hero-actions">
              <Link href="/register" className="loom-button">
                Create your company <Arrow />
              </Link>
              <Link href="/app?demo=1" className="loom-text-link">
                Explore the sample desk <Arrow diagonal />
              </Link>
            </div>
            <p className="loom-hero-note">
              One shared workspace. Your team. A clearer way to work.
            </p>
          </div>
          <div className="loom-hero-art">
            <LoomSculpture />
          </div>
          <div className="loom-hero-bottom">
            <span>From scattered requests to ready work</span>
            <a href="#how-it-works" aria-label="Discover how Loom works">
              Follow the thread <span aria-hidden="true">↓</span>
            </a>
          </div>
        </section>

        <section
          className="loom-purpose"
          aria-label="What Loom brings together"
        >
          <p>
            The analysis is your expertise.
            <br />
            <span>The handoff shouldn’t be your headache.</span>
          </p>
          <div className="loom-purpose-details">
            <span>Clear requirements</span>
            <span>Visible ownership</span>
            <span>Knowledge that stays</span>
          </div>
        </section>

        <section
          className="loom-workflow"
          id="how-it-works"
          aria-labelledby="loom-workflow-title"
        >
          <div className="loom-section-intro">
            <p className="loom-eyebrow">A better thread to follow</p>
            <h2 id="loom-workflow-title">
              The right context.
              <br />
              Before the first query.
            </h2>
            <p>
              Keep the back-and-forth, decisions, and next steps attached to the
              work they belong to.
            </p>
          </div>
          <div className="loom-workflow-body">
            <div className="loom-process-list">
              <article>
                <span className="loom-step">01</span>
                <div>
                  <h3>Start with a clearer ask.</h3>
                  <p>
                    Collect the business question, reporting period, and dataset
                    in one request. Give colleagues a place to follow its
                    progress.
                  </p>
                </div>
              </article>
              <article>
                <span className="loom-step">02</span>
                <div>
                  <h3>Let the agent help. Keep the call.</h3>
                  <p>
                    Review suggested clarifications and assignments against your
                    team’s approved guidance. See the exact change before you
                    apply it.
                  </p>
                </div>
              </article>
              <article>
                <span className="loom-step">03</span>
                <div>
                  <h3>Make the next request easier.</h3>
                  <p>
                    Turn a useful decision into reviewed team guidance. Keep its
                    source so the next analyst can see why it applies.
                  </p>
                </div>
              </article>
            </div>
            <div
              className="loom-request-example"
              aria-label="Illustrative request review"
            >
              <div className="loom-example-topline">
                <span>In the request desk</span>
                <span className="loom-sample-label">Illustrative example</span>
              </div>
              <div className="loom-request-heading">
                <span className="loom-request-id">REQ / 024</span>
                <span className="loom-status-amber">Needs context</span>
              </div>
              <h3>Campaign revenue for the planning review</h3>
              <p className="loom-request-quote">
                “Can we get last month’s campaign revenue?”
              </p>
              <div className="loom-guidance">
                <span className="loom-guidance-symbol" aria-hidden="true">
                  ✳
                </span>
                <div>
                  <strong>A useful next question</strong>
                  <p>
                    Should revenue exclude refunds? The approved campaign guide
                    uses net revenue.
                  </p>
                  <span className="loom-source">
                    Source · Campaign reporting guide
                  </span>
                </div>
              </div>
              <div className="loom-proposal-line">
                <span>Suggested next step</span>
                <strong>Ask for clarification</strong>
              </div>
              <div className="loom-human-review">
                <span className="loom-avatar" aria-hidden="true">
                  A
                </span>
                <span>Ready for an analyst to review</span>
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path
                    d="m5 10 3 3 7-7"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            </div>
          </div>
        </section>

        <section
          className="loom-insights-section"
          id="team-insights"
          aria-labelledby="loom-insights-title"
        >
          <div
            className="loom-insight-visual"
            aria-label="Illustrative request waiting-time breakdown"
          >
            <div className="loom-example-topline">
              <span>Where the time goes</span>
              <span className="loom-sample-label">Synthetic example</span>
            </div>
            <div className="loom-chart-caption">
              <strong>Time across the request journey</strong>
              <span>Hours per request · illustrative values</span>
            </div>
            <div className="loom-time-chart">
              <div>
                <span>Awaiting context</span>
                <div className="loom-bar-track">
                  <span className="loom-bar loom-bar-context" />
                </div>
                <strong>18h</strong>
              </div>
              <div>
                <span>Ready to start</span>
                <div className="loom-bar-track">
                  <span className="loom-bar loom-bar-ready" />
                </div>
                <strong>9h</strong>
              </div>
              <div>
                <span>In progress</span>
                <div className="loom-bar-track">
                  <span className="loom-bar loom-bar-progress" />
                </div>
                <strong>6h</strong>
              </div>
            </div>
            <div className="loom-chart-footnote">
              <span className="loom-signal" />
              <p>See the waiting behind the workload.</p>
            </div>
          </div>
          <div className="loom-insights-copy">
            <p className="loom-eyebrow">Team insights · Powered by Exasol</p>
            <h2 id="loom-insights-title">
              Find the wait.
              <br />
              <span>Fix the handoff.</span>
            </h2>
            <p>
              A busy queue tells only part of the story. Follow the history of
              your requests to see where work waits and how the backlog changes.
            </p>
            <ul>
              <li>Time spent in each stage</li>
              <li>Incoming work and completed requests</li>
              <li>Ownership, aging, and overdue work</li>
            </ul>
            <p className="loom-insights-note">
              Calculated from saved request history, with the records behind the
              numbers.
            </p>
          </div>
        </section>

        <section
          className="loom-company-section"
          aria-labelledby="loom-company-title"
        >
          <div>
            <p className="loom-eyebrow">Your company. A shared rhythm.</p>
            <h2 id="loom-company-title">
              A home for the team
              <br />
              behind the answers.
            </h2>
          </div>
          <div className="loom-company-copy">
            <p>
              Create your company workspace, invite your colleagues, and give
              everyone a clear place in the process.
            </p>
            <div className="loom-role-row">
              <span>Admins set the workspace.</span>
              <span>Analysts move work forward.</span>
              <span>Requesters stay in the loop.</span>
            </div>
            <Link href="/register" className="loom-button">
              Create your company <Arrow />
            </Link>
            <p className="loom-member-link">
              Already part of a team?{" "}
              <Link href="/login">
                Sign in <span aria-hidden="true">↗</span>
              </Link>
            </p>
          </div>
        </section>
      </main>

      <footer className="loom-footer">
        <Link href="/" className="loom-wordmark" aria-label="Loom home">
          <LoomMark />
          <span>
            loom<span className="loom-wordmark-dot">.</span>
          </span>
        </Link>
        <p>Make room for the real work.</p>
        <div>
          <Link href="/app?demo=1">Sample desk</Link>
          <a
            href="https://github.com/minnhaaaaa/Loom"
            target="_blank"
            rel="noreferrer"
          >
            Open source <span aria-hidden="true">↗</span>
          </a>
        </div>
      </footer>
    </div>
  );
}
