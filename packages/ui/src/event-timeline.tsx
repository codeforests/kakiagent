import { useEffect, useRef, useState } from 'react';

/** 24-px outline step icons (Lucide shapes, design.md §2.4). Decorative: the badge names the step. */
const STEP_PATHS = {
  plus: 'M12 5v14M5 12h14',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  shield: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6zM9 12l2 2 4-4',
  file: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5',
  columns: 'M4 4h16v16H4zM12 4v16M4 10h16',
  table: 'M4 4h16v16H4zM4 10h16M4 15h16M10 4v16',
  eraser: 'M7 21h10M5 15l9-9 5 5-6 6H8zM10 10l5 5',
  sparkles:
    'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6',
  save: 'M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM7 3v5h8M7 21v-7h10v7',
  flag: 'M4 21V4h12l-2 4 2 4H4',
  check: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12l3 3 5-6',
  cross: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 9l6 6M15 9l-6 6',
  loader: 'M12 3a9 9 0 1 0 9 9',
} as const;
export type StepIcon = keyof typeof STEP_PATHS;

function StepSvg({ name, className }: { name: StepIcon; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={STEP_PATHS[name]} />
    </svg>
  );
}

export type TimelineState = 'done' | 'current' | 'waiting' | 'success' | 'failed';

export interface TimelineStep {
  key: string;
  label: string;
  icon: StepIcon;
  state: TimelineState;
  /** The caption under the badge: a time, or Done / In progress… / Waiting. */
  caption: string;
}

const BADGE: Record<TimelineState, string> = {
  done: 'neutral',
  current: 'info',
  waiting: 'neutral',
  success: 'success',
  failed: 'danger',
};

/**
 * `event-timeline` (design.md §4.4): a long-running job's steps in a dot-grid well. The step in
 * progress carries aria-current="step"; `announce` is spoken politely only when it changes after
 * the first render, so opening the page says nothing extra.
 */
export function EventTimeline({
  label,
  steps,
  announce,
}: {
  label: string;
  steps: TimelineStep[];
  announce?: string;
}) {
  const [spoken, setSpoken] = useState('');
  const last = useRef(announce);
  useEffect(() => {
    if (announce !== last.current) {
      last.current = announce;
      setSpoken(announce ?? '');
    }
  }, [announce]);
  return (
    <div className="kaki-timeline">
      <ol className="kaki-timeline__steps" aria-label={label}>
        {steps.map((step) => {
          const icon: StepIcon =
            step.state === 'current'
              ? 'loader'
              : step.state === 'success'
                ? 'check'
                : step.state === 'failed'
                  ? 'cross'
                  : step.icon;
          return (
            <li
              key={step.key}
              className={`kaki-timeline__step kaki-timeline__step--${step.state}`}
              aria-current={step.state === 'current' ? 'step' : undefined}
            >
              <span className="kaki-timeline__node">
                <StepSvg
                  name={icon}
                  className={step.state === 'current' ? 'kaki-timeline__spin' : undefined}
                />
              </span>
              <span className="kaki-timeline__text">
                <span className={`kaki-timeline__badge kaki-timeline__badge--${BADGE[step.state]}`}>
                  {step.state === 'done' && (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="m5 12 5 5 9-10" />
                    </svg>
                  )}
                  {step.label}
                </span>
                <span className="kaki-timeline__caption">{step.caption}</span>
              </span>
            </li>
          );
        })}
      </ol>
      <span className="kaki-sr-only" aria-live="polite" data-testid="timeline-announce">
        {spoken}
      </span>
    </div>
  );
}
