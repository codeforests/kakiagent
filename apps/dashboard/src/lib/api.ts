import {
  Account,
  AiStatusResponse,
  DeviceSessionList,
  EmailChangeConfirmed,
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
  BoundaryRulesResponse,
  ReviewIntervalsResponse,
  type SaveBoundaryRulesRequest,
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
  ChannelItem,
  ChannelsResponse,
  OnboardingProgress,
  ReadinessResponse,
  type GoLiveBody,
  type OnboardingStep,
  type StepOutcomeBody,
  PrivacySettingsResponse,
  type PrivacyNoticeBody,
  type PurposeStatementBody,
  ConversationList,
  ConversationThread,
  ThreadPage,
  CloseConversationResponse,
  InboxMembers,
  StaffMessageResponse,
  TakeoverResult,
  type InboxView,
  CreateWorkspaceResponse,
  MagicLinkResponse,
  MagicLinkVerifyResponse,
  MfaEnrolmentStart,
  MfaStatus,
  RecoveryCodes,
  ReauthStatus,
  TeamMfa,
  type MfaCode,
  InvitationLookup,
  TeamInvitation,
  TeamResponse,
  WorkspaceList,
  type InviteBody,
  type MemberPatch,
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
  type ChannelOfflineBody,
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
 * the one sent has ended (idle, too old or signed out elsewhere), `mfa_required` when it
 * still owes a two-step code (FEAT-006 §3).
 */
export class UnauthorizedError extends Error {
  readonly code: 'unauthorized' | 'session_expired' | 'mfa_required';
  constructor(code: string) {
    super('Sign in to continue');
    this.code = code === 'session_expired' || code === 'mfa_required' ? code : 'unauthorized';
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
  /** `invitation`: the invite token, so the link also joins (FEAT-007 §3, SCR-APP-004). */
  requestMagicLink: (email: string, invitation?: string) =>
    request('POST', '/api/v1/auth/magic-link', MagicLinkResponse, {
      email,
      ...(invitation ? { invitation } : {}),
    }),
  verifyMagicLink: (token: string) =>
    request('POST', '/api/v1/auth/magic-link/verify', MagicLinkVerifyResponse, { token }),
  signOut: async () => void (await send('POST', '/api/v1/auth/sign-out')),
  signOutEverywhere: async () => void (await send('POST', '/api/v1/auth/sign-out-everywhere')),
  // Two-step verification and re-auth (FEAT-006 §3).
  mfaStatus: () => getJson('/api/v1/auth/mfa', MfaStatus),
  passMfaChallenge: async (body: MfaCode) =>
    void (await send('POST', '/api/v1/auth/mfa/challenge', body)),
  startMfaEnrolment: () => request('POST', '/api/v1/auth/mfa/enrolment', MfaEnrolmentStart),
  confirmMfaEnrolment: (code: string) =>
    request('POST', '/api/v1/auth/mfa/enrolment/confirm', RecoveryCodes, { code }),
  newRecoveryCodes: () => request('POST', '/api/v1/auth/mfa/recovery-codes', RecoveryCodes),
  removeMfa: async () => void (await send('DELETE', '/api/v1/auth/mfa')),
  reauthStatus: () => getJson('/api/v1/auth/reauth', ReauthStatus),
  reauthenticate: async (body: MfaCode) => void (await send('POST', '/api/v1/auth/reauth', body)),
  requestReauthLink: () => request('POST', '/api/v1/auth/reauth/email', MagicLinkResponse),
  teamMfa: () => getJson('/api/v1/team/mfa', TeamMfa),
  setTeamMfa: (required: boolean) => request('PUT', '/api/v1/team/mfa', TeamMfa, { required }),
  // Team, invitations and workspaces (FEAT-007 §3). Tokens go in bodies, never URLs.
  team: () => getJson('/api/v1/team', TeamResponse),
  invite: (body: InviteBody) => request('POST', '/api/v1/team/invitations', TeamInvitation, body),
  resendInvite: (id: string) =>
    request('POST', `/api/v1/team/invitations/${encodeURIComponent(id)}/resend`, TeamInvitation),
  revokeInvite: async (id: string) =>
    void (await send('DELETE', `/api/v1/team/invitations/${encodeURIComponent(id)}`)),
  updateMember: (userId: string, patch: MemberPatch) =>
    request('PATCH', `/api/v1/team/members/${encodeURIComponent(userId)}`, TeamResponse, patch),
  lookupInvite: (token: string) =>
    request('POST', '/api/v1/invitations/lookup', InvitationLookup, { token }),
  acceptInvite: (token: string) => request('POST', '/api/v1/invitations/accept', Me, { token }),
  workspaces: () => getJson('/api/v1/workspaces', WorkspaceList),
  switchWorkspace: (tenantId: string) =>
    request('POST', `/api/v1/workspaces/${encodeURIComponent(tenantId)}/switch`, Me),
  createWorkspace: (body: CreateWorkspaceBody) =>
    request('POST', '/api/v1/workspaces', CreateWorkspaceResponse, body),
  // My account: name, email change, devices (FEAT-008 §3). Tokens go in bodies, never URLs.
  account: () => getJson('/api/v1/me/account', Account),
  updateProfile: (displayName: string | null) =>
    request('PATCH', '/api/v1/me/profile', Account, { displayName }),
  requestEmailChange: (email: string) =>
    request('POST', '/api/v1/me/email-change', Account, { email }),
  cancelEmailChange: async () => void (await send('DELETE', '/api/v1/me/email-change')),
  confirmEmailChange: (token: string) =>
    request('POST', '/api/v1/email-change/confirm', EmailChangeConfirmed, { token }),
  sessions: () => getJson('/api/v1/me/sessions', DeviceSessionList),
  revokeSession: async (id: string) =>
    void (await send('DELETE', `/api/v1/me/sessions/${encodeURIComponent(id)}`)),
  // Inbox (FEAT-042 §3): views, the thread with older pages, and close.
  conversations: (q: {
    view: InboxView;
    channel: 'widget' | null;
    assignee?: string | null;
    cursor?: string | undefined;
    limit?: number;
  }) => {
    const params = new URLSearchParams();
    if (q.view !== 'open') params.set('view', q.view);
    if (q.channel) params.set('channel', q.channel);
    if (q.assignee) params.set('assignee', q.assignee);
    if (q.cursor) params.set('cursor', q.cursor);
    if (q.limit) params.set('limit', String(q.limit));
    const qs = params.toString();
    return getJson(`/api/v1/conversations${qs ? `?${qs}` : ''}`, ConversationList);
  },
  conversation: (id: string) =>
    getJson(`/api/v1/conversations/${encodeURIComponent(id)}`, ConversationThread),
  conversationMessages: (id: string, before: number) =>
    getJson(
      `/api/v1/conversations/${encodeURIComponent(id)}/messages?before=${before}`,
      ThreadPage,
    ),
  closeConversation: (id: string, version: number) =>
    request(
      'POST',
      `/api/v1/conversations/${encodeURIComponent(id)}/close`,
      CloseConversationResponse,
      { version },
    ),
  // Take over and hand back (FEAT-043 §3).
  takeOver: (id: string, version: number, from?: string) =>
    request(
      'POST',
      `/api/v1/conversations/${encodeURIComponent(id)}/takeover`,
      TakeoverResult,
      from ? { version, from } : { version },
    ),
  handBack: (id: string, version: number) =>
    request('POST', `/api/v1/conversations/${encodeURIComponent(id)}/handback`, TakeoverResult, {
      version,
    }),
  sendStaffMessage: (id: string, body: string, clientMessageId: string) =>
    request(
      'POST',
      `/api/v1/conversations/${encodeURIComponent(id)}/messages`,
      StaffMessageResponse,
      { body, clientMessageId },
    ),
  requestHandover: async (id: string) =>
    void (await send('POST', `/api/v1/conversations/${encodeURIComponent(id)}/handover-request`)),
  inboxMembers: () => getJson('/api/v1/inbox/members', InboxMembers),
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
  aiStatus: () => getJson('/api/v1/ai/status', AiStatusResponse),
  pauseAi: () => request('POST', '/api/v1/ai/pause', AiStatusResponse),
  resumeAi: () => request('POST', '/api/v1/ai/resume', AiStatusResponse),
  channels: () => getJson('/api/v1/channels', ChannelsResponse),
  setChannelState: (id: string, state: 'live' | 'offline', version: number) =>
    request('POST', `/api/v1/channels/${id}/${state}`, ChannelItem, { version }),
  saveChannelOffline: (id: string, body: ChannelOfflineBody) =>
    request('PUT', `/api/v1/channels/${id}/offline-settings`, ChannelItem, body),
  checkChannel: (id: string) => request('POST', `/api/v1/channels/${id}/check`, ChannelItem),
  /** FEAT-035 §3: the wizard's progress and the go-live check (SCR-APP-012). */
  getProgress: () => getJson('/api/v1/onboarding/progress', OnboardingProgress),
  recordStep: (step: OnboardingStep, outcome: StepOutcomeBody['outcome']) =>
    request('PUT', `/api/v1/onboarding/progress/${step}`, OnboardingProgress, { outcome }),
  getReadiness: () => getJson('/api/v1/onboarding/readiness', ReadinessResponse),
  goLive: (body: GoLiveBody) =>
    request('POST', '/api/v1/onboarding/go-live', ReadinessResponse, body),
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
  getRules: () => getJson('/api/v1/settings/rules', BoundaryRulesResponse),
  saveRules: (body: SaveBoundaryRulesRequest) =>
    request('PUT', '/api/v1/settings/rules', BoundaryRulesResponse, body),
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
