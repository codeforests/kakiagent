import { Button, FormDialog } from '@kaki/ui';
import { useState, type FormEvent } from 'react';
import { Field } from '../lib/field.tsx';
import { describedBy } from '../lib/form.ts';

export interface FaqAnswer {
  question: string;
  answer: string;
}

/**
 * The "Add an FAQ" `form-dialog` (FEAT-019 ui-design) for a coverage topic, a coverage gap
 * and a gap item in Corrections: FEAT-011's FAQ fields, the question prefilled.
 */
export function AddFaqDialog({
  open,
  question,
  help,
  caption,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  question: string;
  /** The answer field's help: the topic's hint. */
  help?: string | undefined;
  /** Above the fields: how often customers asked. */
  caption?: string | undefined;
  busy: boolean;
  /** Shown in the dialog when the save failed. */
  error: string | null;
  onClose: () => void;
  onSubmit: (faq: FaqAnswer) => void;
}) {
  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => (o ? undefined : onClose())}
      title="Add an FAQ"
      busy={busy}
    >
      {open && (
        <FaqForm
          question={question}
          help={help}
          caption={caption}
          busy={busy}
          error={error}
          onClose={onClose}
          onSubmit={onSubmit}
        />
      )}
    </FormDialog>
  );
}

function FaqForm({
  question: initial,
  help,
  caption,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  question: string;
  help?: string | undefined;
  caption?: string | undefined;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (faq: FaqAnswer) => void;
}) {
  const [faq, setFaq] = useState({ question: initial, answer: '' });
  const [touched, setTouched] = useState({ question: false, answer: false });
  const [submitted, setSubmitted] = useState(false);
  const errors = {
    question: faq.question.trim() ? undefined : 'Enter the question',
    answer: faq.answer.trim() ? undefined : 'Enter the answer',
  };
  const shown = (f: keyof FaqAnswer) => (submitted || touched[f] ? errors[f] : undefined);

  function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (errors.question || errors.answer) return;
    onSubmit({ question: faq.question.trim(), answer: faq.answer.trim() });
  }

  return (
    <form className="fact-form review-edit" onSubmit={submit} noValidate>
      {error && (
        <div className="alert alert--danger" role="alert">
          <p>{error}</p>
        </div>
      )}
      {caption && <p className="field__help">{caption}</p>}
      <Field id="faq-question" label="Question (required)" error={shown('question')}>
        <input
          id="faq-question"
          className="input"
          value={faq.question}
          maxLength={300}
          onChange={(e) => setFaq({ ...faq, question: e.target.value })}
          onBlur={() => setTouched((t) => ({ ...t, question: true }))}
          readOnly={busy}
          aria-invalid={shown('question') ? true : undefined}
          aria-describedby={describedBy('faq-question', shown('question'))}
        />
      </Field>
      <Field id="faq-answer" label="Answer (required)" error={shown('answer')} help={help}>
        <textarea
          id="faq-answer"
          className="input input--area"
          value={faq.answer}
          maxLength={2000}
          onChange={(e) => setFaq({ ...faq, answer: e.target.value })}
          onBlur={() => setTouched((t) => ({ ...t, answer: true }))}
          readOnly={busy}
          aria-invalid={shown('answer') ? true : undefined}
          aria-describedby={describedBy('faq-answer', shown('answer'), !!help)}
        />
      </Field>
      <div className="kaki-dialog__actions">
        <Button variant="ghost" type="button" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy} aria-busy={busy || undefined}>
          {busy ? 'Saving…' : 'Save FAQ'}
        </Button>
      </div>
    </form>
  );
}
