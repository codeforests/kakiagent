import { WizardFooter } from '../shell/wizard-header.tsx';
import { Button, EmptyState, ErrorState } from '@kaki/ui';
import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../lib/api.ts';
import { hostOf } from '../lib/widget.ts';
import { useWidgetEditor, type WidgetEditor } from '../lib/widget-editor.ts';
import {
  AppearanceForm,
  DetectAlert,
  InstallCheck,
  OriginsList,
  SnippetBox,
  UnsavedPrompt,
  WidgetPreview,
} from './widget-parts.tsx';

/** Permission, error and loading states shared by both screens; null once loaded. */
function Gate({ editor, head }: { editor: WidgetEditor; head: ReactNode }): ReactNode {
  const { loaded } = editor;
  if (loaded.error instanceof ApiError && loaded.error.status === 403)
    return (
      <div className="widget-page">
        {head}
        <EmptyState title="You can't change the website widget">
          Only the Owner and Admins can change the website widget.
        </EmptyState>
      </div>
    );
  if (loaded.isError)
    return (
      <div className="widget-page">
        {head}
        <ErrorState
          title="We couldn't load your widget settings."
          action={
            <Button variant="secondary" onClick={() => void loaded.refetch()}>
              Try again
            </Button>
          }
        >
          Nothing you saved is lost.
        </ErrorState>
      </div>
    );
  if (!loaded.data)
    return (
      <div className="widget-page">
        {head}
        <div className="widget-layout" aria-busy="true" aria-label="Loading widget settings">
          <div className="card">
            <div className="skeleton-field" />
            <div className="skeleton-field" />
            <div className="skeleton-field" />
          </div>
          <div className="card widget-preview">
            <div className="skeleton-field" />
          </div>
        </div>
      </div>
    );
  return null;
}

function Toast({ text }: { text: string | null }) {
  return text ? (
    <div className="toast" role="status">
      {text}
    </div>
  ) : null;
}

/** SCR-APP-037 — Settings → Website widget (FEAT-032 ui-design). */
export function WidgetSettingsPage() {
  const editor = useWidgetEditor();
  const head = (
    <>
      <Link className="back-link" to="/settings">
        Settings
      </Link>
      <h1 className="page-title">Website widget</h1>
      <p className="page-lede">
        How the chat button looks on your website, where it's allowed, and how to install it.
      </p>
    </>
  );
  const gate = Gate({ editor, head });
  if (gate) return gate;
  const data = editor.data!;
  return (
    <div className="widget-page">
      {head}
      <div className="widget-layout">
        <div className="widget-layout__preview">
          <WidgetPreview editor={editor} idPrefix="widget" />
        </div>
        <div className="widget-layout__main">
          <section className="card stack" aria-labelledby="widget-look">
            <h2 className="section-title" id="widget-look">
              Look
            </h2>
            <DetectAlert editor={editor} />
            <AppearanceForm editor={editor} idPrefix="widget" />
          </section>
          <section className="card stack" aria-labelledby="widget-install">
            <h2 className="section-title" id="widget-install">
              Install
            </h2>
            {data.allowedOrigins.length === 0 && (
              <div className="alert alert--info" role="status">
                <p>Add your website below first, so the widget knows where it may appear.</p>
              </div>
            )}
            <SnippetBox snippet={data.snippet} />
            <InstallCheck settings={data} />
          </section>
          <section className="card stack" aria-labelledby="widget-sites">
            <h2 className="section-title" id="widget-sites">
              Websites
            </h2>
            <OriginsList settings={data} idPrefix="widget" />
          </section>
        </div>
      </div>
      <UnsavedPrompt editor={editor} />
      <Toast text={editor.toast} />
    </div>
  );
}

/** SCR-APP-011 — setup step 5, "Add to your website" (FEAT-032 ui-design). */
export function SetupWebsitePage() {
  const editor = useWidgetEditor();
  const { data, detect } = editor;

  // On arrival, match the site once if it was never checked.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || !data || data.detection.status !== 'none' || !data.siteUrl) return;
    asked.current = true;
    detect.mutate();
  }, [data, detect]);

  const head = (
    <>
      <h1 className="page-title">Add to your website</h1>
      <p className="page-lede">
        Your assistant's chat button, matched to your website. Change anything you like, then add
        one line to your site.
      </p>
    </>
  );
  const gate = Gate({ editor, head });
  if (gate) return gate;
  const s = data!;
  const showSites = s.install.state === 'wrong_domain' || s.allowedOrigins.length === 0;
  return (
    <div className="widget-page widget-setup">
      {head}
      <section className="widget-setup__step" aria-labelledby="setup-look">
        <h2 className="section-title" id="setup-look">
          1. Check the look
        </h2>
        {!s.siteUrl && (
          <div className="alert alert--info" role="status">
            <p>
              Add your website in Sources to match its look.{' '}
              <Link to="/setup/sources">Go to Sources</Link>
            </p>
          </div>
        )}
        <DetectAlert editor={editor} />
        <div className="widget-layout">
          <div className="widget-layout__preview">
            <WidgetPreview editor={editor} idPrefix="setup" />
          </div>
          <div className="widget-layout__main card">
            <AppearanceForm editor={editor} idPrefix="setup" compact />
          </div>
        </div>
      </section>
      <section className="widget-setup__step card stack" aria-labelledby="setup-install">
        <h2 className="section-title" id="setup-install">
          2. Add it to your website
        </h2>
        <SnippetBox snippet={s.snippet} />
      </section>
      <section className="widget-setup__step card stack" aria-labelledby="setup-check">
        <h2 className="section-title" id="setup-check">
          3. Check it's working
        </h2>
        <InstallCheck settings={s} />
        {showSites && <OriginsList settings={s} idPrefix="setup" />}
      </section>
      <WizardFooter
        caption={
          s.install.state === 'detected' && s.install.origin
            ? `Your widget is on ${hostOf(s.install.origin)}.`
            : 'You can change this any time in Settings → Website widget.'
        }
      />
      <UnsavedPrompt editor={editor} />
      <Toast text={editor.toast} />
    </div>
  );
}
