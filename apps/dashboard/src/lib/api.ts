import {
  CoachSessionDetail,
  CoachSessionList,
  CoachSessionResponse,
  CoachSuggestions,
  CoachTurnResponse,
  CorrectionConfirmResponse,
  CorrectionResponse,
  CorrectionAcceptResponse,
  CorrectionDetail,
  CorrectionItemResponse,
  CorrectionList,
  CorrectionReplayNextResponse,
  CoverageReport,
  CoverageTopicResponse,
  ReviewIntervalsResponse,
  type CorrectionEdit,
  type CorrectionListQuery,
  type ReviewIntervals,
  type CoachOrigin,
  type CoachTurnRequest,
  ReplayCandidateList,
  ReplayNextResponse,
  ReplayResponse,
  type ReplayCreate,
  AssistantSettingsResponse,
  AuthOptions,
  BusinessProfileResponse,
  PrivacySettingsResponse,
  type PrivacyNoticeBody,
  type PurposeStatementBody,
  ConversationList,
  CreateWorkspaceResponse,
  MagicLinkResponse,
  MagicLinkVerifyResponse,
  FactList,
  FactResponse,
  ImportPreview,
  Me,
  ApproveAllResponse,
  ApprovePreview,
  ApproveSelectionResponse,
  ConflictList,
  ResolveConflictResponse,
  RejectSelectionResponse,
  ReviewList,
  ReviewSummary,
  UndoResponse,
  SourceDetail,
  SourceList,
  SourceResponse,
  UploadTicket,
  WidgetDetectResponse,
  WidgetSettings,
  type WidgetAppearanceBody,
  type ApproveFactBody,
  type AssistantSettingsBody,
  type BusinessProfileBody,
  type CreateFactBody,
  type CreateSourceBody,
  type CreateWorkspaceBody,
  type ConfirmImportBody,
  type ImportBody,
  type FactListQuery,
  type FactRef,
  type ResolveConflictBody,
  type ReviewListQuery,
  type ReviewScopeQuery,
  type UpdateFactBody,
  type UploadRequestBody,
} from '@kaki/contracts';
import type { z } from 'zod';

/**
 * A 401 (FEAT-005 §3.6): `unauthorized` when no session was sent, `session_expired` when
 * the one sent has ended (idle, too old or signed out elsewhere).
 */
export class UnauthorizedError extends Error {
  readonly code: 'unauthorized' | 'session_expired';
  constructor(code: string) {
    super('Sign in to continue');
    this.code = code === 'session_expired' ? 'session_expired' : 'unauthorized';
  }
}

/** A non-2xx answer with the API's `{ error, message }` body (design §3.2). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** The rest of the body, e.g. `sourceId` on `source_exists`. */
  readonly details: Record<string, unknown>;
  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function send(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    } & Record<string, unknown>;
    if (res.status === 401) throw new UnauthorizedError(err.error ?? 'unauthorized');
    throw new ApiError(
      res.status,
      err.error ?? 'error',
      err.message ?? `${path}: ${res.status}`,
      err,
    );
  }
  return res;
}

async function request<S extends z.ZodType>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  schema: S,
  body?: unknown,
): Promise<z.infer<S>> {
  const res = await send(method, path, body);
  return schema.parse(await res.json());
}

const getJson = <S extends z.ZodType>(path: string, schema: S) => request('GET', path, schema);

function query(params: Record<string, string | number | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const qs = q.toString();
  return qs ? `?${qs}` : '';
}

export const api = {
  me: () => getJson('/api/v1/me', Me),
  authOptions: () => getJson('/api/v1/auth/options', AuthOptions),
  requestMagicLink: (email: string) =>
    request('POST', '/api/v1/auth/magic-link', MagicLinkResponse, { email }),
  verifyMagicLink: (token: string) =>
    request('POST', '/api/v1/auth/magic-link/verify', MagicLinkVerifyResponse, { token }),
  signOut: async () => void (await send('POST', '/api/v1/auth/sign-out')),
  signOutEverywhere: async () => void (await send('POST', '/api/v1/auth/sign-out-everywhere')),
  createWorkspace: (body: CreateWorkspaceBody) =>
    request('POST', '/api/v1/workspaces', CreateWorkspaceResponse, body),
  conversations: () => getJson('/api/v1/conversations', ConversationList),
  facts: (filter: FactListQuery) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filter))
      if (v !== undefined && v !== '') params.set(k, String(v));
    const qs = params.toString();
    return getJson(`/api/v1/kb/facts${qs ? `?${qs}` : ''}`, FactList);
  },
  fact: (id: string) => getJson(`/api/v1/kb/facts/${encodeURIComponent(id)}`, FactResponse),
  createFact: (body: CreateFactBody) => request('POST', '/api/v1/kb/facts', FactResponse, body),
  updateFact: (id: string, body: UpdateFactBody) =>
    request('PATCH', `/api/v1/kb/facts/${encodeURIComponent(id)}`, FactResponse, body),
  /** FEAT-011 §3.2: conditional on the version the owner saw; 204 on success. */
  deleteFact: async (id: string, version: number) =>
    void (await send('DELETE', `/api/v1/kb/facts/${encodeURIComponent(id)}?version=${version}`)),
  /** FEAT-024 §3: SCR-APP-041. */
  assistantSettings: () => getJson('/api/v1/settings/assistant', AssistantSettingsResponse),
  saveAssistantSettings: (body: AssistantSettingsBody) =>
    request('PUT', '/api/v1/settings/assistant', AssistantSettingsResponse, body),
  /** FEAT-009 §3: SCR-APP-044 and the setup step. */
  businessProfile: () => getJson('/api/v1/settings/business-profile', BusinessProfileResponse),
  saveBusinessProfile: (body: BusinessProfileBody) =>
    request('PUT', '/api/v1/settings/business-profile', BusinessProfileResponse, body),
  privacySettings: () => getJson('/api/v1/settings/privacy', PrivacySettingsResponse),
  savePrivacyNotice: (body: PrivacyNoticeBody) =>
    request('PUT', '/api/v1/settings/privacy/notice', PrivacySettingsResponse, body),
  savePurposeStatement: (body: PurposeStatementBody) =>
    request('PUT', '/api/v1/settings/privacy/purpose', PrivacySettingsResponse, body),
  /** A plain link: the browser downloads it with the session cookie. */
  documentUrl: (doc: 'data-flow' | 'dpa') => `/api/v1/settings/privacy/documents/${doc}.pdf`,
  /** FEAT-012 §3: SCR-APP-023, SCR-APP-024 and the website form. */
  sources: () => getJson('/api/v1/kb/sources', SourceList),
  source: (id: string) => getJson(`/api/v1/kb/sources/${encodeURIComponent(id)}`, SourceDetail),
  createSource: (body: CreateSourceBody) =>
    request('POST', '/api/v1/kb/sources', SourceResponse, body),
  retrySource: (id: string, version: number) =>
    request('POST', `/api/v1/kb/sources/${encodeURIComponent(id)}/retry`, SourceResponse, {
      version,
    }),
  /** FEAT-015 §3.2: a presigned PUT into quarantine; nothing is saved yet. */
  requestUpload: (body: UploadRequestBody) =>
    request('POST', '/api/v1/kb/uploads', UploadTicket, body),
  deleteSource: async (id: string, version: number) =>
    void (await send('DELETE', `/api/v1/kb/sources/${encodeURIComponent(id)}?version=${version}`)),
  /** FEAT-016 §3.2: SCR-APP-025's preview (writes nothing) and confirm. */
  previewImport: (id: string, body: ImportBody) =>
    request('POST', `/api/v1/kb/sources/${encodeURIComponent(id)}/preview`, ImportPreview, body),
  confirmImport: (id: string, body: ConfirmImportBody) =>
    request('POST', `/api/v1/kb/sources/${encodeURIComponent(id)}/import`, SourceResponse, body),
  /** FEAT-013 §3: SCR-APP-019 and SCR-APP-008. */
  reviewFacts: (q: ReviewListQuery) => getJson(`/api/v1/kb/review/facts${query(q)}`, ReviewList),
  reviewSummary: () => getJson('/api/v1/kb/review/summary', ReviewSummary),
  approvePreview: (scope: ReviewScopeQuery) =>
    getJson(`/api/v1/kb/review/preview${query(scope)}`, ApprovePreview),
  approveAll: (scope: ReviewScopeQuery, previewHash: string) =>
    request('POST', '/api/v1/kb/review/approve-all', ApproveAllResponse, {
      ...scope,
      previewHash,
    }),
  approveFact: (id: string, body: ApproveFactBody) =>
    request('POST', `/api/v1/kb/facts/${encodeURIComponent(id)}/approve`, FactResponse, body),
  rejectFact: (id: string, version: number) =>
    request('POST', `/api/v1/kb/facts/${encodeURIComponent(id)}/reject`, FactResponse, {
      version,
    }),
  approveSelected: (facts: FactRef[]) =>
    request('POST', '/api/v1/kb/review/approve', ApproveSelectionResponse, { facts }),
  rejectSelected: (facts: FactRef[]) =>
    request('POST', '/api/v1/kb/review/reject', RejectSelectionResponse, { facts }),
  undoReview: (facts: FactRef[]) =>
    request('POST', '/api/v1/kb/review/undo', UndoResponse, { facts }),
  conflicts: () => getJson('/api/v1/kb/conflicts', ConflictList),
  resolveConflict: (body: ResolveConflictBody) =>
    request('POST', '/api/v1/kb/conflicts/resolve', ResolveConflictResponse, body),
  /** FEAT-027 §3: SCR-APP-030, SCR-APP-010 and the quick coach panel. */
  coachSessions: (cursor?: string) =>
    getJson(`/api/v1/coach/sessions${query({ cursor })}`, CoachSessionList),
  coachSession: (id: string) =>
    getJson(`/api/v1/coach/sessions/${encodeURIComponent(id)}`, CoachSessionDetail),
  createCoachSession: (origin: CoachOrigin) =>
    request('POST', '/api/v1/coach/sessions', CoachSessionResponse, { origin }),
  coachTurn: (id: string, body: CoachTurnRequest) =>
    request(
      'POST',
      `/api/v1/coach/sessions/${encodeURIComponent(id)}/messages`,
      CoachTurnResponse,
      body,
    ),
  confirmCorrection: (id: string) =>
    request(
      'POST',
      `/api/v1/coach/corrections/${encodeURIComponent(id)}/confirm`,
      CorrectionConfirmResponse,
      {},
    ),
  dismissCorrection: (id: string) =>
    request(
      'POST',
      `/api/v1/coach/corrections/${encodeURIComponent(id)}/dismiss`,
      CorrectionResponse,
      {},
    ),
  coachSuggestions: () => getJson('/api/v1/coach/suggestions', CoachSuggestions),
  /** FEAT-028 §3: SCR-APP-031. */
  replayCandidates: (cursor?: string) =>
    getJson(`/api/v1/coach/replay-candidates${query({ cursor })}`, ReplayCandidateList),
  startReplay: (body: ReplayCreate) =>
    request('POST', '/api/v1/coach/replays', ReplayResponse, body),
  replay: (id: string) =>
    getJson(`/api/v1/coach/replays/${encodeURIComponent(id)}`, ReplayResponse),
  replayNext: (id: string) =>
    request('POST', `/api/v1/coach/replays/${encodeURIComponent(id)}/next`, ReplayNextResponse, {}),
  /** FEAT-018 §3: SCR-APP-021, SCR-APP-022. */
  coverage: () => getJson('/api/v1/kb/coverage', CoverageReport),
  setCoverageTopic: (topicId: string, skipped: boolean) =>
    request(
      'PUT',
      `/api/v1/kb/coverage/topics/${encodeURIComponent(topicId)}`,
      CoverageTopicResponse,
      { skipped },
    ),
  corrections: (q: Partial<CorrectionListQuery>) =>
    getJson(`/api/v1/corrections${query(q)}`, CorrectionList),
  correction: (id: string) =>
    getJson(`/api/v1/corrections/${encodeURIComponent(id)}`, CorrectionDetail),
  acceptCorrection: (id: string, edit: CorrectionEdit | null) =>
    request(
      'POST',
      `/api/v1/corrections/${encodeURIComponent(id)}/accept`,
      CorrectionAcceptResponse,
      { edit },
    ),
  closeCorrection: (id: string) =>
    request(
      'POST',
      `/api/v1/corrections/${encodeURIComponent(id)}/close`,
      CorrectionItemResponse,
      {},
    ),
  correctionReplayNext: (id: string) =>
    request(
      'POST',
      `/api/v1/corrections/${encodeURIComponent(id)}/replay/next`,
      CorrectionReplayNextResponse,
      {},
    ),
  /** FEAT-032 §3: SCR-APP-037 and SCR-APP-011; every change answers with the settings. */
  widget: () => getJson('/api/v1/widget', WidgetSettings),
  saveWidgetAppearance: (body: WidgetAppearanceBody) =>
    request('PUT', '/api/v1/widget/appearance', WidgetSettings, body),
  detectWidgetTheme: () => request('POST', '/api/v1/widget/theme/detect', WidgetDetectResponse, {}),
  /** The raw image as the body (413 `logo_too_large`, 415 `logo_type`). */
  uploadWidgetLogo: async (file: File) => {
    const res = await fetch('/api/v1/widget/logo', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': file.type },
      body: file,
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (res.status === 401) throw new UnauthorizedError(err.error ?? 'unauthorized');
      throw new ApiError(res.status, err.error ?? 'error', err.message ?? `logo: ${res.status}`);
    }
    return WidgetSettings.parse(await res.json());
  },
  deleteWidgetLogo: () => request('DELETE', '/api/v1/widget/logo', WidgetSettings),
  addWidgetOrigin: (origin: string) =>
    request('POST', '/api/v1/widget/origins', WidgetSettings, { origin }),
  removeWidgetOrigin: (origin: string) =>
    request('DELETE', `/api/v1/widget/origins/${encodeURIComponent(origin)}`, WidgetSettings),
  reviewIntervals: () => getJson('/api/v1/kb/review-intervals', ReviewIntervalsResponse),
  saveReviewIntervals: (intervals: ReviewIntervals) =>
    request('PUT', '/api/v1/kb/review-intervals', ReviewIntervalsResponse, { intervals }),
};

/** The PUT to storage failed: the network, or storage refused it. */
export class UploadError extends Error {}

/**
 * PUTs a file to its presigned URL with XHR, which reports upload progress (`fetch` has
 * no upload progress). Resolves when storage has the whole file.
 */
export function putFile(
  ticket: UploadTicket,
  file: Blob,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', ticket.url);
    for (const [k, v] of Object.entries(ticket.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new UploadError(`storage answered ${xhr.status}`));
    xhr.onerror = () => reject(new UploadError('network error'));
    xhr.onabort = () => reject(new UploadError('aborted'));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(file);
  });
}
