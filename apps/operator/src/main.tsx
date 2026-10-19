import '@kaki/design-tokens/tokens.css';
import '@kaki/ui/styles.css';
import './app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { OperatorShell } from './shell.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <OperatorShell />
  </StrictMode>,
);
