import type {
  PrivacyNoticeBody,
  PrivacySettingsResponse,
  PurposeStatementBody,
} from '@kaki/contracts';

/** Helpers for SCR-APP-047 and the setup step (FEAT-058 ui-design, technical-design §5.3). */

export type NoticeMode = 'link' | 'template';

export interface NoticeDraft {
  mode: NoticeMode;
  url: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  address: string;
  extra: string;
}

export interface PurposeDraft {
  en: string;
  zh: string;
}

export type NoticeErrors = Partial<Record<'url' | 'contactName' | 'contactEmail', string>>;
export type PurposeErrors = Partial<Record<'en' | 'zh', string>>;

export const PURPOSE_MAX = 600;

/** The form's starting values; a never-saved notice starts on "On my website". */
export function noticeDraftOf(res: PrivacySettingsResponse): NoticeDraft {
  const empty: NoticeDraft = {
    mode: 'link',
    url: '',
    contactName: '',
    contactEmail: res.defaults.template.contactEmail ?? '',
    contactPhone: '',
    address: '',
    extra: '',
  };
  const { notice } = res;
  if (notice.mode === 'link') return { ...empty, url: notice.url };
  if (notice.mode === 'template') {
    const f = notice.fields;
    return {
      mode: 'template',
      url: '',
      contactName: f.contactName,
      contactEmail: f.contactEmail,
      contactPhone: f.contactPhone ?? '',
      address: f.address ?? '',
      extra: f.extra ?? '',
    };
  }
  return empty;
}

/** True when saving `a` would store what `b` already holds (only the chosen mode counts). */
export function sameNotice(a: NoticeDraft, b: NoticeDraft): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode === 'link') return a.url.trim() === b.url.trim();
  return (['contactName', 'contactEmail', 'contactPhone', 'address', 'extra'] as const).every(
    (k) => a[k].trim() === b[k].trim(),
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Field errors in the ui-design copy (NFR-19); empty when the draft can be saved. */
export function validateNotice(d: NoticeDraft): NoticeErrors {
  const errors: NoticeErrors = {};
  if (d.mode === 'link') {
    const url = d.url.trim();
    if (!url) errors.url = 'Add the link to your privacy notice.';
    else if (!/^https:/i.test(url)) errors.url = 'The link must start with https://';
    else if (!isWebAddress(url))
      errors.url = "That doesn't look like a web address. Copy it from your browser's address bar.";
  } else {
    if (!d.contactName.trim()) errors.contactName = 'Add a contact person.';
    if (!EMAIL.test(d.contactEmail.trim()))
      errors.contactEmail = 'Add a contact email, like hello@kakibakery.sg';
  }
  return errors;
}

function isWebAddress(url: string): boolean {
  if (/\s/.test(url)) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname.includes('.');
  } catch {
    return false;
  }
}

const orNull = (s: string) => s.trim() || null;

export function noticeBodyOf(d: NoticeDraft, version: number): PrivacyNoticeBody {
  return d.mode === 'link'
    ? { version, mode: 'link', url: d.url.trim() }
    : {
        version,
        mode: 'template',
        fields: {
          contactName: d.contactName.trim(),
          contactEmail: d.contactEmail.trim(),
          contactPhone: orNull(d.contactPhone),
          address: orNull(d.address),
          extra: orNull(d.extra),
        },
      };
}

/** The saved statement, or the default when none was saved yet (D6). */
export function purposeDraftOf(res: PrivacySettingsResponse): PurposeDraft {
  if (!res.purpose.wording) return { ...res.defaults.purpose };
  return { en: res.purpose.text.en, zh: res.purpose.text.zh ?? '' };
}

export const samePurpose = (a: PurposeDraft, b: PurposeDraft) =>
  a.en.trim() === b.en.trim() && a.zh.trim() === b.zh.trim();

export function validatePurpose(d: PurposeDraft): PurposeErrors {
  const errors: PurposeErrors = {};
  const tooLong = (s: string) =>
    s.trim().length > PURPOSE_MAX ? `Keep it under 600 characters (${s.trim().length} now).` : null;
  if (!d.en.trim()) errors.en = 'Add the English purpose statement.';
  else {
    const long = tooLong(d.en);
    if (long) errors.en = long;
  }
  const zhLong = tooLong(d.zh);
  if (zhLong) errors.zh = zhLong;
  return errors;
}

export const purposeBodyOf = (d: PurposeDraft, version: number): PurposeStatementBody => ({
  version,
  purpose: { en: d.en.trim(), zh: orNull(d.zh) },
});

const DAY = new Intl.DateTimeFormat('en-SG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Asia/Singapore',
});

/** "27 Oct 2026" from an ISO time or a `YYYY-MM-DD` registry date. */
export function formatDay(value: string): string {
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00+08:00` : value;
  return DAY.format(new Date(iso));
}

/** The saved marker: "Version 3 · saved 27 Oct 2026". */
export const formatSaved = (ref: { seq: number; savedAt: string }) =>
  `Version ${ref.seq} · saved ${formatDay(ref.savedAt)}`;
