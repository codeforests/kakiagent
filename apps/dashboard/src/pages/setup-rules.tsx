import { Button } from '@kaki/ui';
import { Link } from 'react-router';
import { useToast } from '../lib/form.ts';
import { NoticeForm, PrivacyScreen, PurposeForm } from './privacy-parts.tsx';

/**
 * `/setup/rules`: SCR-APP-009 (partial), the setup's "Rules and privacy" step (GOV-14, ONB-09;
 * FEAT-058). FEAT-054 adds boundary rules above the privacy block; FEAT-035 the wizard frame.
 */
export function SetupRulesPage() {
  const [toast, setToast] = useToast();
  const head = (
    <>
      <p className="page-lede">Step 4 of the setup</p>
      <h1 className="page-title">Rules and privacy</h1>
      <p className="page-lede">
        Tell visitors how you use their details. You can change this any time in Settings → Privacy
        and data.
      </p>
    </>
  );
  return (
    <PrivacyScreen head={head} className="privacy-setup">
      {(data, reload, generation) => {
        const ready = data.readiness.privacyNotice && data.readiness.purposeStatement;
        return (
          <div className="stack">
            <NoticeForm key={`n${generation}`} data={data} onReload={reload} onToast={setToast} />
            <PurposeForm key={`p${generation}`} data={data} onReload={reload} onToast={setToast} />
            <p className="privacy-lede">
              <Link to="/settings/privacy#documents">See where your data goes</Link>
            </p>
            <div className="review-setup__footer">
              <Button asChild>
                <Link to="/setup/test">Continue</Link>
              </Button>
              {!ready && (
                <p className="review-setup__caption">You'll need both before you go live.</p>
              )}
            </div>
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
