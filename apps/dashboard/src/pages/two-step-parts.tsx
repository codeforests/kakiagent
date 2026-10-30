import { Button } from '@kaki/ui';
import { useEffect, useState, type Ref } from 'react';
import { describedBy } from '../lib/form.ts';
import { downloadRecoveryCodes, formatRecoveryCode, type CodeKind } from '../lib/mfa.ts';

/**
 * Parts shared by SCR-APP-005, the `reauth-dialog` and My account (FEAT-006 ui-design):
 * the code field, its error texts, the recovery codes list and the QR code.
 */

/** The code input (ui-design "Code inputs"): numeric one-time-code, or a recovery code. */
export function CodeField({
  id,
  kind,
  value,
  onChange,
  error,
  readOnly,
  inputRef,
  autoFocus,
}: {
  id: string;
  kind: CodeKind;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  readOnly?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  autoFocus?: boolean;
}) {
  const totp = kind === 'totp';
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {totp ? '6-digit code' : 'Recovery code'}
      </label>
      <input
        ref={inputRef}
        id={id}
        className={`input code-input${totp ? '' : ' code-input--recovery'}`}
        type="text"
        {...(totp
          ? { inputMode: 'numeric' as const, autoComplete: 'one-time-code', maxLength: 7 }
          : { autoComplete: 'off', autoCapitalize: 'off', placeholder: 'e.g. abcde-fghij' })}
        spellCheck={false}
        value={value}
        readOnly={readOnly}
        autoFocus={autoFocus}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error ?? undefined)}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && (
        <p className="field__error" id={`${id}-error`}>
          <span aria-hidden="true">!</span> {error}
        </p>
      )}
    </div>
  );
}

/** The ten codes, two columns, with Copy and Download (SCR-APP-005 step 3, My account). */
export function RecoveryCodesList({
  codes,
  email,
  onToast,
}: {
  codes: string[];
  email: string;
  onToast: (text: string) => void;
}) {
  const shown = codes.map(formatRecoveryCode);
  return (
    <>
      <ul className="recovery-codes" aria-label={`Recovery codes, ${codes.length}`}>
        {shown.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="recovery-codes__actions">
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            void navigator.clipboard
              .writeText(shown.join('\n'))
              .then(() => onToast('Codes copied'))
              .catch(() => onToast("Couldn't copy. Select the codes and copy them instead."))
          }
        >
          Copy codes
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => downloadRecoveryCodes(codes, email)}
        >
          Download
        </Button>
      </div>
    </>
  );
}

/** The `otpauth://` URI as a QR code; `uqr` loads only here (D6), in its own chunk. */
export function QrCode({ uri }: { uri: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void import('uqr').then(({ renderSVG }) => {
      if (live)
        setSvg(
          renderSVG(uri, { border: 0, whiteColor: 'transparent', blackColor: 'currentColor' }),
        );
    });
    return () => {
      live = false;
    };
  }, [uri]);
  return (
    <div
      className="qr"
      role="img"
      aria-label="QR code for your authenticator app"
      // The SVG is generated here from our own URI by `uqr`, never from user input.
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
}

/** Lucide `shield-check`, 40 px. */
export function ShieldCheckIcon({ size = 40 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

/** Lucide `lock`, 40 px. */
export function LockIcon() {
  return (
    <svg
      width={40}
      height={40}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

/** Lucide `mail`, 24 px. */
export function MailIcon() {
  return (
    <svg
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  );
}

/** Lucide `circle-check`, 40 px. */
export function CircleCheckIcon() {
  return (
    <svg
      width={40}
      height={40}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}
