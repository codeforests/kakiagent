import type { MemberEvent } from '@kaki/contracts';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { memberEvents, MemberEventNotice } from '../lib/realtime.ts';

/** The toast's text and link label for an event sent to me (ui-design SCR-APP-015, Owner's notifications). */
export function memberToastText(e: MemberEvent): { text: string; action: string } {
  const by = e.by.name || 'A team member';
  return e.type === 'handover_requested'
    ? { text: `${by} asks you to hand over a conversation.`, action: 'Open conversation' }
    : { text: `${by} took over a conversation you were handling.`, action: 'Open' };
}

/**
 * Hand-over requests and take-overs from me, on any page (FEAT-043). Stays 10 s, and not
 * while focus is inside it; announced through a live region that is always mounted.
 */
export function MemberToasts() {
  const [event, setEvent] = useState<MemberEvent | null>(null);
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const on = (e: Event) => {
      if (e instanceof MemberEventNotice) setEvent(e.event);
    };
    memberEvents.addEventListener('member', on);
    return () => memberEvents.removeEventListener('member', on);
  }, []);
  useEffect(() => {
    if (!event || focused) return;
    const timer = setTimeout(() => setEvent(null), 10_000);
    return () => clearTimeout(timer);
  }, [event, focused]);

  const view = event ? memberToastText(event) : null;
  return (
    <div role="status" aria-live="polite">
      {event && view && (
        <div
          ref={ref}
          className={`toast toast--${event.type === 'taken_from_you' ? 'warning' : 'info'}`}
          onFocus={() => setFocused(true)}
          onBlur={(e) => {
            if (!ref.current?.contains(e.relatedTarget as Node | null)) setFocused(false);
          }}
        >
          <p>{view.text}</p>
          <Link
            to={`/inbox/${encodeURIComponent(event.conversationId)}`}
            onClick={() => setEvent(null)}
          >
            {view.action}
          </Link>
        </div>
      )}
    </div>
  );
}
