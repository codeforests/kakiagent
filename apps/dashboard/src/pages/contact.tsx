import type { ContactDetail, ContactMergeEntry } from '@kaki/contracts';
import { Button, EmptyState, ErrorState } from '@kaki/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { contactKey, countText, undoErrorText, useContact } from '../lib/contacts.ts';
import { dateTime } from '../lib/inbox.ts';
import { Glyph } from './conversation-parts.tsx';
import {
  ConsentCard,
  ConversationsCard,
  DuplicatesCard,
  IdentifiersCard,
  LeadsCard,
  MergePreviewDialog,
  MergesCard,
  SearchDialog,
  UndoDialog,
  UndoToast,
} from './contact-parts.tsx';

/**
 * `/contacts/:contactId`: SCR-APP-016 Contact (CHN-08, UC-26; FEAT-039 ui-design). Every member
 * reads it; members with `contacts.merge` (all three roles) merge and undo.
 */
export function ContactPage() {
  const { contactId = '' } = useParams();
  const [search] = useSearchParams();
  const fromLead = search.get('from') === 'lead';
  const contact = useContact(contactId);
  const notFound =
    contact.error instanceof ApiError &&
    (contact.error.status === 404 || contact.error.status === 400);

  return (
    <div className="contact-page">
      <nav aria-label="Breadcrumb" className="contact-page__crumbs">
        <Link to={fromLead ? '/leads' : '/inbox'}>{fromLead ? 'Leads' : 'Inbox'}</Link>
        <span aria-hidden="true"> / </span>
        <span aria-current="page">Contact</span>
      </nav>
      {contact.isPending && (
        <div className="contact-page__grid" aria-busy="true" aria-label="Loading contact">
          <div className="card skeleton-card" />
          <div className="card skeleton-card" />
        </div>
      )}
      {notFound && (
        <EmptyState
          title="We couldn't find this contact."
          action={<Link to="/inbox">Back to inbox</Link>}
        />
      )}
      {contact.isError && !notFound && (
        <ErrorState
          title="We couldn't load this contact."
          action={
            <Button variant="secondary" onClick={() => void contact.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {contact.data && <ContactBody key={contact.data.id} contact={contact.data} />}
    </div>
  );
}

type Other = { contactId: string; label: string };
type Toast = { message: string; mergeId?: string };

function ContactBody({ contact }: { contact: ContactDetail }) {
  const queryClient = useQueryClient();
  const location = useLocation();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const mergesRef = useRef<HTMLHeadingElement>(null);
  const mergeButtonRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  // Where focus goes once the data re-renders; a closing dialog places it (Radix's close
  // focus comes after our effects), otherwise (Undo in the toast) the effect below does.
  const focusAfter = useRef<{ to: 'title' | 'merges'; viaDialog: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const [other, setOther] = useState<Other | null>(null);
  const [undoing, setUndoing] = useState<
    ContactMergeEntry | { mergeId: string; otherLabel: string } | null
  >(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const closeToast = useCallback(() => setToast(null), []);

  // The sidebar's duplicate hint links to `#duplicates`.
  useEffect(() => {
    if (location.hash !== '#duplicates') return;
    const el = document.getElementById('duplicates-title');
    el?.scrollIntoView({ block: 'start' });
    el?.focus();
  }, [location.hash]);

  const refreshAround = (ids: string[]) => {
    for (const id of ids) void queryClient.invalidateQueries({ queryKey: contactKey(id) });
    void queryClient.invalidateQueries({ queryKey: ['leads'] });
    void queryClient.invalidateQueries({ queryKey: ['lead'] });
    void queryClient.invalidateQueries({ queryKey: ['conversation'] });
  };

  const merge = useMutation({
    mutationFn: (o: Other) => api.mergeContacts(contact.id, o.contactId),
    onSuccess: (res, o) => {
      queryClient.setQueryData(contactKey(contact.id), res.contact);
      refreshAround([o.contactId]);
      focusAfter.current = { to: 'title', viaDialog: true };
      setOther(null);
      setToast({ message: `Merged ${o.label} into ${contact.label}.`, mergeId: res.mergeId });
    },
  });

  const undo = useMutation({
    mutationFn: (mergeId: string) => api.undoMerge(mergeId),
    onSuccess: (res) => {
      if (res.contact.id === contact.id) {
        // The merged-away contact's own page: it is itself again.
        queryClient.setQueryData(contactKey(contact.id), res.contact);
      } else {
        queryClient.setQueryData(contactKey(res.contact.id), res.contact);
        refreshAround([contact.id]);
      }
      refreshAround([]);
      focusAfter.current = { to: 'merges', viaDialog: undoing !== null };
      setUndoing(null);
      setToast({ message: 'Merge undone.' });
    },
    onError: (err) => {
      // From the toast there's no dialog to hold the alert.
      if (!undoing) setToast({ message: undoErrorText(err).text });
    },
  });

  // Focus after the data re-renders: the title after a merge, the Merges heading after undo.
  const placeFocus = () => {
    const to = focusAfter.current?.to;
    focusAfter.current = null;
    ((to === 'merges' ? mergesRef.current : null) ?? titleRef.current)?.focus();
  };
  useEffect(() => {
    if (focusAfter.current && !focusAfter.current.viaDialog) placeFocus();
  });

  const reload = () => {
    setOther(null);
    setUndoing(null);
    merge.reset();
    undo.reset();
    refreshAround([contact.id]);
  };

  const returnFocus = (e: Event) => {
    e.preventDefault();
    if (focusAfter.current) return placeFocus();
    (openerRef.current?.isConnected ? openerRef.current : mergeButtonRef.current)?.focus();
  };

  const undoFailure = undoing && undo.isError ? undoErrorText(undo.error) : null;
  const undoAlert = undoFailure && (
    <div className="alert alert--danger" role="alert">
      <p>{undoFailure.text}</p>
      {undoFailure.reload && (
        <Button variant="secondary" className="kaki-btn--sm" onClick={reload}>
          Reload
        </Button>
      )}
    </div>
  );

  const header = (
    <div className="page-header contact-page__header">
      <h1 className="page-title" tabIndex={-1} ref={titleRef}>
        {contact.name ?? contact.label}
      </h1>
      <p className="contact-caption">
        First seen {dateTime(contact.firstSeenAt).split(',')[0]} ·{' '}
        {countText(contact.conversationCount, 'conversation')}
      </p>
    </div>
  );

  const undoDialog = (
    <UndoDialog
      target={undoing}
      intoLabel={contact.label}
      onOpenChange={(open) => {
        if (!open) {
          setUndoing(null);
          undo.reset();
        }
      }}
      onConfirm={() => undoing && undo.mutate(undoing.mergeId)}
      busy={undo.isPending}
      alert={undoAlert}
      onCloseAutoFocus={returnFocus}
    />
  );

  if (contact.mergedInto) {
    const into = contact.mergedInto;
    return (
      <>
        {header}
        <div className="alert alert--info" data-testid="contact-merged-away">
          <p>
            {contact.label} was merged into {into.label}.
          </p>
          <Link to={`/contacts/${into.contactId}`}>Open {into.label}</Link>
          {contact.canMerge && (
            <Button
              variant="secondary"
              onClick={(e) => {
                openerRef.current = e.currentTarget;
                setUndoing({ mergeId: into.mergeId, otherLabel: contact.label });
              }}
            >
              Undo merge
            </Button>
          )}
        </div>
        {undoDialog}
        <UndoToast toast={toast} onClose={closeToast} onUndo={() => undefined} />
      </>
    );
  }

  const openPreview = (o: Other, opener: HTMLElement | null) => {
    openerRef.current = opener;
    merge.reset();
    setOther(o);
  };

  return (
    <>
      {header}
      <div className="contact-page__grid">
        <IdentifiersCard contact={contact} />
        <div className="stack contact-page__aside">
          <DuplicatesCard contact={contact} onReview={openPreview} />
          {contact.canMerge && (
            <Button
              variant="ghost"
              ref={mergeButtonRef}
              className="contact-page__merge"
              onClick={() => setSearching(true)}
            >
              <Glyph name="git-merge" /> Merge with another contact
            </Button>
          )}
          <MergesCard
            contact={contact}
            headingRef={mergesRef}
            onUndo={(m, opener) => {
              openerRef.current = opener;
              undo.reset();
              setUndoing(m);
            }}
          />
        </div>
        <ConversationsCard contact={contact} />
        <LeadsCard contact={contact} />
        <ConsentCard contact={contact} />
      </div>
      <SearchDialog
        open={searching}
        onOpenChange={setSearching}
        onCloseAutoFocus={(e) => {
          // Choosing a result opens the preview, which takes focus itself.
          e.preventDefault();
          if (!other) mergeButtonRef.current?.focus();
        }}
        contactId={contact.id}
        onChoose={(o) => {
          setSearching(false);
          openPreview(o, mergeButtonRef.current);
        }}
      />
      <MergePreviewDialog
        contact={contact}
        other={other}
        onOpenChange={(open) => {
          if (!open) setOther(null);
        }}
        onConfirm={() => other && merge.mutate(other)}
        busy={merge.isPending}
        error={merge.isError ? merge.error : null}
        onReload={reload}
        onCloseAutoFocus={returnFocus}
      />
      {undoDialog}
      <UndoToast toast={toast} onClose={closeToast} onUndo={(id) => undo.mutate(id)} />
    </>
  );
}
