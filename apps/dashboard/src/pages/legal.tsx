import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { api } from '../lib/api.ts';
import { AuthLayout } from './auth-layout.tsx';
import { NotFound } from './system.tsx';

/**
 * `/legal/:document` (FEAT-005 ui-design, supporting route): the title and current
 * version of a document a new Owner accepts. The full text arrives after legal review
 * (technical-design D9).
 */
export function LegalPage() {
  const { document } = useParams();
  const options = useQuery({ queryKey: ['auth-options'], queryFn: api.authOptions });
  if (options.isError)
    return (
      <AuthLayout title="We couldn't load this page">
        <p className="auth__body">Check your connection and try again.</p>
      </AuthLayout>
    );
  if (!options.data) return <AuthLayout title=" " busy />;
  const doc = options.data.terms.find((t) => t.document === document);
  if (!doc)
    return (
      <main id="main" className="auth">
        <NotFound />
      </main>
    );
  return (
    <AuthLayout title={doc.title}>
      <p className="auth__note">Version {doc.version}</p>
      <p className="auth__body">The full text will be published here before the pilot.</p>
    </AuthLayout>
  );
}
