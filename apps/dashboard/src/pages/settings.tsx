import { Link } from 'react-router';

interface Row {
  name: string;
  purpose: string;
  /** Built screens link; the rest show "Coming soon" (FEAT-024 ui-design, Settings index). */
  to?: string;
}

/** The Settings groups from the IA (ux-foundations "Settings"), in its order. */
const GROUPS: { title: string; rows: Row[] }[] = [
  {
    title: 'Assistant and rules',
    rows: [
      {
        name: 'Assistant',
        purpose: 'Name, tone, greeting and the messages visitors see',
        to: '/settings/assistant',
      },
      { name: 'Rules and approvals', purpose: 'What your assistant may say and promise' },
    ],
  },
  {
    title: 'Channels and widget',
    rows: [
      { name: 'Channels', purpose: 'Where your assistant answers' },
      { name: 'Website widget', purpose: 'Look, install and allowed websites' },
    ],
  },
  {
    title: 'Business and team',
    rows: [
      {
        name: 'Business profile',
        purpose: 'Your details and opening hours',
        to: '/settings/business-profile',
      },
      { name: 'Team', purpose: 'Members and roles' },
    ],
  },
  {
    title: 'Privacy and data',
    rows: [
      { name: 'Privacy and data', purpose: 'Privacy notice, retention and terms' },
      { name: 'Audit log', purpose: 'Every decision and change, verifiable' },
    ],
  },
  {
    title: 'Plan and usage',
    rows: [{ name: 'Plan and usage', purpose: 'Your plan and what you have used' }],
  },
];

/** The Settings section's landing list (FEAT-024 ui-design); other rows link as they are built. */
export function SettingsPage() {
  return (
    <>
      <h1 className="page-title">Settings</h1>
      <div className="settings-groups">
        {GROUPS.map((g) => (
          <section className="card settings-group" key={g.title} aria-label={g.title}>
            <h2 className="settings-group__title">{g.title}</h2>
            <ul className="settings-list">
              {g.rows.map((r) => (
                <li key={r.name}>
                  {r.to ? (
                    <Link className="settings-row" to={r.to}>
                      <span className="settings-row__text">
                        <span className="settings-row__name">{r.name}</span>
                        <span className="settings-row__purpose">{r.purpose}</span>
                      </span>
                      <span aria-hidden="true">›</span>
                    </Link>
                  ) : (
                    <div className="settings-row settings-row--soon">
                      <span className="settings-row__text">
                        <span className="settings-row__name">{r.name}</span>
                        <span>{r.purpose}</span>
                      </span>
                      <span className="settings-row__soon">Coming soon</span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
