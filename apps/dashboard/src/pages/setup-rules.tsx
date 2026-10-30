import { WizardFooter } from '../shell/wizard-header.tsx';
import { Link } from 'react-router';
import { useToast } from '../lib/form.ts';
import { useAssistantSettings } from '../lib/assistant.ts';
import { useRules } from '../lib/rules.ts';
import { AssistantBlock } from './assistant.tsx';
import { NoticeForm, PrivacyScreen, PurposeForm } from './privacy-parts.tsx';
import { RulesBlock } from './rules-parts.tsx';

/**
 * `/setup/rules`: SCR-APP-009 (partial), the setup's "Rules and privacy" step (GOV-14, ONB-09;
 * FEAT-058). FEAT-054 adds boundary rules above the privacy block (APR-01); FEAT-035 the
 * wizard frame and the assistant block between them (AGT-08, AGT-11).
 */
export function SetupRulesPage() {
  const [toast, setToast] = useToast();
  // The rules block loads on its own; the caption only counts them once they're saved.
  const rulesSaved = useRules().data?.version != null;
  const assistantSaved = (useAssistantSettings().data?.settings.version ?? 0) > 0;
  const head = (
    <>
      <h1 className="page-title">Rules and privacy</h1>
      <p className="page-lede">
        Set what your assistant may talk about and promise, and tell visitors how you use their
        details. You can change these any time in Settings.
      </p>
      <section className="stack rules-setup" aria-labelledby="setup-rules-title">
        <h2 className="section-title" id="setup-rules-title">
          Rules
        </h2>
        <RulesBlock variant="setup" onToast={setToast} />
      </section>
      <section className="stack" aria-labelledby="assistant">
        <h2 className="section-title" id="assistant">
          Assistant
        </h2>
        <p className="page-lede">
          Your assistant's name, how it greets visitors and how it says it's an AI. Visitors always
          see the disclosure.
        </p>
        <AssistantBlock variant="setup" onToast={setToast} />
      </section>
      <h2 className="section-title" id="privacy">
        Privacy
      </h2>
    </>
  );
  return (
    <PrivacyScreen head={head} className="privacy-setup">
      {(data, reload, generation) => {
        const ready =
          rulesSaved &&
          assistantSaved &&
          data.readiness.privacyNotice &&
          data.readiness.purposeStatement;
        return (
          <div className="stack">
            <NoticeForm key={`n${generation}`} data={data} onReload={reload} onToast={setToast} />
            <PurposeForm key={`p${generation}`} data={data} onReload={reload} onToast={setToast} />
            <p className="privacy-lede">
              <Link to="/settings/privacy#documents">See where your data goes</Link>
            </p>
            <WizardFooter
              caption={
                ready
                  ? undefined
                  : "You'll need saved rules, saved assistant settings, a privacy notice and a purpose statement before you go live."
              }
            />
            {toast && (
              <div className="toast" role="status">
                {toast}
              </div>
            )}
          </div>
        );
      }}
    </PrivacyScreen>
  );
}
