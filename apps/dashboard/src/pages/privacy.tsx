import { Link } from 'react-router';
import { useToast } from '../lib/form.ts';
import {
  DocumentsSection,
  NoticeForm,
  PrivacyScreen,
  PurposeForm,
  ReadinessAlert,
  TermsSection,
} from './privacy-parts.tsx';

/** SCR-APP-047 Privacy and data (GOV-14, GOV-07, GOV-11; FEAT-058 ui-design). */
export function PrivacyPage() {
  const [toast, setToast] = useToast();
  const head = (
    <>
      <Link className="back-link" to="/settings">
        Settings
      </Link>
      <h1 className="page-title">Privacy and data</h1>
      <p className="page-lede">
        Your privacy notice, what visitors agree to, and where their data goes.
      </p>
    </>
  );
  return (
    <PrivacyScreen head={head} className="privacy-page">
      {(data, reload, generation) => (
        <div className="stack">
          <ReadinessAlert data={data} />
          <NoticeForm key={`n${generation}`} data={data} onReload={reload} onToast={setToast} />
          <PurposeForm key={`p${generation}`} data={data} onReload={reload} onToast={setToast} />
          <DocumentsSection data={data} onToast={setToast} />
          <TermsSection data={data} />
          {toast && (
            <div className="toast" role="status">
              {toast}
            </div>
          )}
        </div>
      )}
    </PrivacyScreen>
  );
}
