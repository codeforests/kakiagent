import { Button } from '@kaki/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { Field } from '../lib/field.tsx';
import { describedBy } from '../lib/form.ts';
import { AddFilesForm } from './add-files.tsx';
import { NoPermission } from './system.tsx';

type FieldName = 'url' | 'subdomains' | 'attested';

const URL_ERROR = 'Enter the website address, like https://kakibakery.sg';
const ATTEST_ERROR = 'Confirm you own or are authorised to use this website';

/** The domain the API will confirm, for messages before it answers. */
function domainOf(input: string): string | null {
  try {
    const raw = input.trim();
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname;
    return host.includes('.') ? host.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

/**
 * SCR-APP-007's website part (KB-13, UC-03 4, 4b; FEAT-012 ui-design): one form, used at
 * `/knowledge/sources/new` and in setup at `/setup/sources`. The attestation checkbox is
 * required; submitting without it shows the field error rather than a disabled button.
 */
export function AddWebsiteForm() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const summaryRef = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState('');
  const [subdomainsOpen, setSubdomainsOpen] = useState(false);
  const [subdomains, setSubdomains] = useState('');
  const [attested, setAttested] = useState(false);
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<Partial<Record<FieldName, string>>>({});
  const limits = useQuery({ queryKey: ['sources'], queryFn: api.sources });
  const domain = domainOf(url);
  const subdomainList = subdomains
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const errors: Partial<Record<FieldName, string>> = {
    ...(domain ? {} : { url: URL_ERROR }),
    ...(attested ? {} : { attested: ATTEST_ERROR }),
    ...serverErrors,
  };
  const shown = (f: FieldName) => (submitted || touched[f] ? errors[f] : undefined);
  const errorList = Object.entries(errors) as [FieldName, string][];

  const create = useMutation({
    mutationFn: () =>
      api.createSource({
        kind: 'website',
        url: url.trim(),
        ...(subdomainList.length ? { subdomains: subdomainList } : {}),
        attested,
      }),
    onSuccess: async ({ source }) => {
      await queryClient.invalidateQueries({ queryKey: ['sources'] });
      void navigate(`/knowledge/sources/${source.id}`, {
        state: { toast: `Reading ${source.name}. You can leave this page; we'll keep going.` },
      });
    },
    onError: (err) => {
      if (!(err instanceof ApiError)) return;
      if (err.code === 'attestation_required') setServerErrors({ attested: ATTEST_ERROR });
      else if (err.code === 'url_not_public')
        setServerErrors({
          url: "This address can't be read from the internet. Use your public website address.",
        });
      else if (err.status === 400 && /subdomain|not under/i.test(err.message))
        setServerErrors({
          subdomains: `Each subdomain must end in .${domain}, like shop.${domain}`,
        });
      else if (err.status === 400) setServerErrors({ url: URL_ERROR });
      else return;
      requestAnimationFrame(() => summaryRef.current?.focus());
    },
  });
  const failure = create.error instanceof ApiError ? create.error : null;
  const exists = failure?.code === 'source_exists' ? failure : null;
  const otherFailure = create.isError && !exists && !(failure && failure.status === 400);
  const readOnly = create.isPending;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    setServerErrors({});
    if (!domain || !attested) {
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    create.mutate();
  };

  return (
    <form className="add-website card" onSubmit={submit} noValidate>
      {submitted && errorList.length > 0 && !create.isPending && (
        <div className="alert alert--danger" role="alert" tabIndex={-1} ref={summaryRef}>
          <p className="alert__title">Check these fields</p>
          <ul>
            {errorList.map(([f, msg]) => (
              <li key={f}>
                <a href={`#website-${f}`}>{msg}</a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {exists && (
        <div className="alert alert--warning" role="alert">
          <p>You've already added {domain}.</p>
          {typeof exists.details.sourceId === 'string' && (
            <Link to={`/knowledge/sources/${exists.details.sourceId}`}>Open it</Link>
          )}
        </div>
      )}
      {otherFailure && (
        <div className="alert alert--danger" role="alert">
          <p>We couldn't start reading your site. Nothing was saved.</p>
        </div>
      )}

      <Field
        id="website-url"
        label="Website address (required)"
        help="We read pages on this domain only."
        error={shown('url')}
      >
        <input
          id="website-url"
          className="input"
          type="url"
          inputMode="url"
          autoComplete="url"
          placeholder="e.g. https://kakibakery.sg"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setServerErrors({});
          }}
          onBlur={() => setTouched((t) => ({ ...t, url: true }))}
          aria-invalid={Boolean(shown('url')) || undefined}
          aria-describedby={describedBy('website-url', shown('url'), true)}
          readOnly={readOnly}
          required
        />
      </Field>

      {subdomainsOpen ? (
        <Field
          id="website-subdomains"
          label="Other subdomains to include"
          help={`One per line, e.g. shop.${domain ?? 'kakibakery.sg'}. Only subdomains of your domain.`}
          error={shown('subdomains')}
        >
          <textarea
            id="website-subdomains"
            className="input input--area"
            rows={3}
            value={subdomains}
            onChange={(e) => {
              setSubdomains(e.target.value);
              setServerErrors({});
            }}
            aria-invalid={Boolean(shown('subdomains')) || undefined}
            aria-describedby={describedBy('website-subdomains', shown('subdomains'), true)}
            readOnly={readOnly}
          />
        </Field>
      ) : (
        <Button
          type="button"
          variant="ghost"
          className="kaki-btn--sm add-website__more"
          onClick={() => setSubdomainsOpen(true)}
          aria-expanded={false}
        >
          Add subdomains
        </Button>
      )}

      <div className="field">
        <label className="radio checkbox" htmlFor="website-attested">
          <input
            id="website-attested"
            type="checkbox"
            checked={attested}
            onChange={(e) => {
              setAttested(e.target.checked);
              setServerErrors({});
            }}
            aria-invalid={Boolean(shown('attested')) || undefined}
            aria-describedby={describedBy('website-attested', shown('attested'), true)}
            disabled={readOnly}
            required
          />
          <span>
            I own this website or am authorised to use its content for my business's assistant.
          </span>
        </label>
        <p className="field__help" id="website-attested-help">
          We record this confirmation. We follow robots.txt and don't follow links to other sites.
        </p>
        {shown('attested') && (
          <p className="field__error" id="website-attested-error">
            <span aria-hidden="true">!</span> {shown('attested')}
          </p>
        )}
      </div>

      {limits.data && (
        <p className="add-website__plan">Your plan reads up to {limits.data.pageLimit} pages.</p>
      )}

      <Button type="submit" disabled={create.isPending} aria-busy={create.isPending || undefined}>
        {create.isPending ? 'Starting…' : 'Start reading pages'}
      </Button>
    </form>
  );
}

/** SCR-APP-007's two parts, website then files (UC-03 6 expects both on one step). */
function SourceSections() {
  return (
    <>
      <section className="add-sources__part" aria-labelledby="add-website-title">
        <h2 className="subsection-title" id="add-website-title">
          Your website
        </h2>
        <AddWebsiteForm />
      </section>
      <section className="add-sources__part" id="files" aria-labelledby="add-files-title">
        <h2 className="subsection-title" id="add-files-title">
          Files
        </h2>
        <AddFilesForm />
      </section>
    </>
  );
}

/** `/knowledge/sources/new` (FEAT-015: "Add sources", with files). */
export function AddWebsitePage() {
  const access = useQuery({ queryKey: ['sources'], queryFn: api.sources });
  if (access.error instanceof ApiError && access.error.status === 403) return <NoPermission />;
  return (
    <div className="add-website-page">
      <Link className="back-link" to="/knowledge/sources">
        Sources
      </Link>
      <h1 className="page-title">Add sources</h1>
      <SourceSections />
    </div>
  );
}

/** `/setup/sources`: the setup's second step (UC-03 4, 4a); FEAT-035 adds the wizard frame. */
export function SetupSourcesPage() {
  const access = useQuery({ queryKey: ['sources'], queryFn: api.sources });
  if (access.error instanceof ApiError && access.error.status === 403) return <NoPermission />;
  return (
    <div className="add-website-page">
      <p className="page-lede">Step 2 of the setup</p>
      <h1 className="page-title">Add your sources</h1>
      <SourceSections />
      <Button asChild variant="ghost">
        <Link to="/setup/review">Next: review your facts</Link>
      </Button>
      <Button asChild variant="ghost">
        <Link to="/">Skip for now</Link>
      </Button>
    </div>
  );
}
