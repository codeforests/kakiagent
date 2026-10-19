import { Button, EmptyState } from '@kaki/ui';
import { Link } from 'react-router';

/** Home (SCR-APP-012 arrives with FEAT-065). The skeleton points at the one live path. */
export function HomePage() {
  return (
    <>
      <h1 className="page-title">Home</h1>
      <EmptyState
        title="Your assistant is running locally"
        action={
          <Button asChild>
            <Link to="/inbox">Open the inbox</Link>
          </Button>
        }
      >
        Send a message from the widget host page and it shows up in the inbox straight away.
      </EmptyState>
    </>
  );
}
