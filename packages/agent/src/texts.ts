/**
 * System-owned texts (ADR-008 decision 6): rendered, never generated. English only for
 * now; FEAT-024 makes the disclosure tenant-editable and FEAT-033 adds 中文.
 */
export const texts = {
  /** AGT-11. design.md §6 default, without "a person can take over" until FEAT-044. */
  disclosure: (businessName: string) => `You're chatting with an AI assistant for ${businessName}.`,
  /** NFR-04 and the kill switch (architecture §6.5). Lead capture follows with FEAT-049. */
  fallback: 'Thanks for your message. Our team will get back to you soon.',
  /** UC-20 6a: a reply that failed verification twice. */
  escalation: 'Let me confirm that with the team and get back to you.',
} as const;
