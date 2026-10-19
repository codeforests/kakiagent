# Requirements Traceability Matrix
## AI Customer Agent SaaS for Singapore SMEs — MVP

> Source: [SRS.md](SRS.md) v0.4, [use-cases.md](use-cases.md) v0.4 · Last updated: 2026-10-19
> Design, Plan and Test columns start as `_TBD_` and are filled by downstream phases (see Column ownership).

## Column ownership
| Column(s) | Owner | Rule |
|---|---|---|
| Req ID, Requirement, Priority, Status, Source, Use case(s) | Requirements engineering | Only this phase adds rows or edits these columns. Removed requirements keep their row with Status `Removed (vX.Y)`. |
| Design ref | Software architecture (ADRs), then per-feature detailed design and UI design | Append, never overwrite. NFR rows usually end at an ADR; FR rows gain concrete design refs per feature. |
| Plan ref | Implementation planning | The feature/epic that schedules the requirement. |
| Test ref | Acceptance verification | Append one entry per accepted feature report; mark `(partial)` where a report verified only part of the requirement. Full verification is computed, never stored. |

**Source key:** *Research Pn* = problem statement row in SRS §1.2 · *SRS v0.1 (Cn/An)* = original NFR, tied to constraints and assumptions in SRS §1.5 · *Gap review v0.3* = added in the v0.3 review · *Owner request v0.4* = added at the product owner's request in v0.4 · *Appx A n* = review finding in SRS Appendix A · *Dn* = decision in SRS §7 · regulatory obligations quoted from SRS §5.

**Use case "— (system-level)":** the requirement is a cross-cutting system property verified by its own tests rather than by an actor journey.

## Matrix
| Req ID | Requirement (short) | Priority | Status | Source | Use case(s) | Design ref | Plan ref | Test ref |
|---|---|---|---|---|---|---|---|---|
| ONB-01 | Sign up with an email magic link or Google | Must | Active | Research P1 | UC-01 | _TBD_ | _TBD_ | _TBD_ |
| ONB-02 | Guided wizard | Must | Active | Research P1 | UC-03 | _TBD_ | _TBD_ | _TBD_ |
| ONB-03 | Business profile | Must | Active | Research P1; Appx A A15 | UC-03 | _TBD_ | _TBD_ | _TBD_ |
| ONB-04 | "Paste your website URL" as the first and quickest path to a working bot | Must | Active | Research P1 | UC-03 | _TBD_ | _TBD_ | _TBD_ |
| ONB-05 | Test-your-bot playground before going live, provided by owner coaching mode… | Must | Active | Research P1 | UC-04 | _TBD_ | _TBD_ | _TBD_ |
| ONB-06 | Industry templates (F&B, retail, beauty/wellness, education/tuition,… | Should | Active | Research P1 | UC-03, UC-29 | _TBD_ | _TBD_ | _TBD_ |
| ONB-07 | Widget install | Must | Active | Research P1 | UC-05 | _TBD_ | _TBD_ | _TBD_ |
| ONB-08 | Median time from sign-up to going live is ≤ 15 minutes for a website-only… | Should | Active | Research P1 | UC-03 | _TBD_ | _TBD_ | _TBD_ |
| ONB-09 | Go-live readiness check | Must | Active | Gap review v0.3; Appx A A21 | UC-03, UC-15 | _TBD_ | _TBD_ | _TBD_ |
| ONB-10 | Going live and going offline are explicit owner/admin actions per channel | Must | Active | Gap review v0.3; Appx A A21 | UC-03 | _TBD_ | _TBD_ | _TBD_ |
| AUTH-01 | Sign in with a magic link or Google | Must | Active | Gap review v0.3; Appx A A7 | UC-01, UC-02 | _TBD_ | _TBD_ | _TBD_ |
| AUTH-02 | Session management | Must | Active | Gap review v0.3; Appx A A7 | UC-02, UC-06 | _TBD_ | _TBD_ | _TBD_ |
| AUTH-03 | MFA: tenant users can enrol a TOTP authenticator | Must | Active | Gap review v0.3; Appx A A7 | UC-02, UC-06, UC-07, UC-08, UC-22, UC-24, UC-29, UC-30, UC-32, UC-33, UC-34 | _TBD_ | _TBD_ | _TBD_ |
| AUTH-04 | Team invitations | Must | Active | Gap review v0.3; Appx A A7 | UC-02, UC-06 | _TBD_ | _TBD_ | _TBD_ |
| AUTH-05 | Users can change their profile name and email | Must | Active | Gap review v0.3; Appx A A7 | UC-02 | _TBD_ | _TBD_ | _TBD_ |
| AUTH-06 | Ownership transfer | Must | Active | Gap review v0.3; Appx A A7 | UC-07 | _TBD_ | _TBD_ | _TBD_ |
| AUTH-07 | Tenant deletion | Must | Active | Gap review v0.3; Appx A A7; PDPA – retention limitation | UC-08 | _TBD_ | _TBD_ | _TBD_ |
| AUTH-08 | At sign-up the user accepts the Terms of Service, Acceptable Use Policy and the… | Must | Active | Gap review v0.3; Appx A A7; PDPC GenAI guidelines – data-intermediary documentation | UC-01 | _TBD_ | _TBD_ | _TBD_ |
| KB-01 | Website crawl | Must | Active | Research P1; Appx A A16; D2 | UC-03, UC-14 | _TBD_ | _TBD_ | _TBD_ |
| KB-02 | File upload | Must | Active | Research P1 | UC-10 | _TBD_ | _TBD_ | _TBD_ |
| KB-03 | Spreadsheet upload (CSV/XLSX) with column mapping to Product, Service, Price,… | Must | Active | Research P1 | UC-10 | _TBD_ | _TBD_ | _TBD_ |
| KB-04 | Chat-history import (WhatsApp .txt export, Telegram JSON export) | Must | Active | Research P1 | UC-11 | _TBD_ | _TBD_ | _TBD_ |
| KB-05 | LLM extraction into typed entities | Must | Active | Research P1; Appx A A15 | UC-03, UC-10, UC-15 | _TBD_ | _TBD_ | _TBD_ |
| KB-06 | Conflict detection | Must | Active | Research P1 | UC-12, UC-14, UC-15 | _TBD_ | _TBD_ | _TBD_ |
| KB-07 | KB manager | Must | Active | Research P1 | UC-12, UC-13 | _TBD_ | _TBD_ | _TBD_ |
| KB-08 | Freshness | Should | Active | Research P1 | UC-14 | _TBD_ | _TBD_ | _TBD_ |
| KB-09 | Coverage report | Must | Active | Research P1 | UC-03, UC-13, UC-16, UC-37 | _TBD_ | _TBD_ | _TBD_ |
| KB-10 | Removed in v0.4, superseded by KB-18. Learn from human replies | Could | Removed (v0.4) | Research P1 | — | _TBD_ | _TBD_ | _TBD_ |
| KB-11 | Upload safety | Must | Active | Gap review v0.3; Appx A A11 | UC-10, UC-11 | _TBD_ | _TBD_ | _TBD_ |
| KB-12 | Processing status | Must | Active | Gap review v0.3 | UC-03, UC-10, UC-11, UC-13, UC-14 | _TBD_ | _TBD_ | _TBD_ |
| KB-13 | Website authorisation | Must | Active | Gap review v0.3; Appx A A9; D9 | UC-03 | _TBD_ | _TBD_ | _TBD_ |
| KB-14 | Entity history | Should | Active | Gap review v0.3 | UC-13 | _TBD_ | _TBD_ | _TBD_ |
| KB-15 | GST-aware prices | Must | Active | Gap review v0.3; Appx A A15; GST – price display for GST-registered businesses | UC-10, UC-20 | _TBD_ | _TBD_ | _TBD_ |
| KB-16 | Fact review and approval (D11) | Must | Active | Owner request v0.4; D11; IMDA – reducing automation bias | UC-03, UC-04, UC-14, UC-15 | _TBD_ | _TBD_ | _TBD_ |
| KB-17 | Stale facts | Must | Active | Owner request v0.4 | UC-13, UC-15, UC-16 | _TBD_ | _TBD_ | _TBD_ |
| KB-18 | Correction queue | Must | Active | Owner request v0.4; IMDA – reducing automation bias | UC-04, UC-16, UC-23, UC-36 | _TBD_ | _TBD_ | _TBD_ |
| AGT-01 | Answers only from the tenant's approved KB facts (KB-16) and business profile… | Must | Active | Research P2 | UC-04, UC-20, UC-27 | _TBD_ | _TBD_ | _TBD_ |
| AGT-02 | Price and fact integrity | Must | Active | Research P2; Appx A A6 | UC-04, UC-20 | _TBD_ | _TBD_ | _TBD_ |
| AGT-03 | Understands English, Singlish (code-switching, particles such as… | Must | Active | Research P4 | UC-20 | _TBD_ | _TBD_ | _TBD_ |
| AGT-04 | When confidence is low or the question is out of scope, the agent says it will… | Must | Active | Research P2 | UC-04, UC-20 | _TBD_ | _TBD_ | _TBD_ |
| AGT-05 | Uses web context | Must | Active | Research P3; Appx A A17 | UC-20 | _TBD_ | _TBD_ | _TBD_ |
| AGT-06 | Tools available to the agent | Must | Active | Research P2; IMDA Agentic AI v1.5 – defined operational boundaries; IMDA Agentic AI v1.5 – agent identity and access limits | UC-21, UC-22, UC-23, UC-26 | _TBD_ | _TBD_ | _TBD_ |
| AGT-07 | Prompt-injection resistance | Must | Active | Research P2; IMDA GenAI framework – prompt injection, transparency, harmful content | UC-20 | _TBD_ | _TBD_ | _TBD_ |
| AGT-08 | Configurable persona | Must | Active | Research P2 | UC-03, UC-20 | _TBD_ | _TBD_ | _TBD_ |
| AGT-09 | After hours | Must | Active | Research P2 | UC-20, UC-23, UC-27 | _TBD_ | _TBD_ | _TBD_ |
| AGT-10 | Proactive greeting triggered by intent signals (for example, ≥ 30 seconds on… | Should | Active | Research P2; D2 | UC-20 | _TBD_ | _TBD_ | _TBD_ |
| AGT-11 | Discloses that it is an AI assistant at the start of a conversation | Must | Active | Research P2; IMDA GenAI framework – prompt injection, transparency, harmful content | UC-03, UC-20 | _TBD_ | _TBD_ | _TBD_ |
| AGT-12 | Conversation memory | Must | Active | Gap review v0.3; Appx A A21 | UC-20, UC-26 | _TBD_ | _TBD_ | _TBD_ |
| AGT-13 | Harmful and abusive content | Must | Active | Gap review v0.3; Appx A A21; IMDA GenAI framework – prompt injection, transparency, harmful content | UC-20 | _TBD_ | _TBD_ | _TBD_ |
| AGT-14 | Evaluation suite | Must | Active | Gap review v0.3; Appx A A12, A13; D1; IMDA Agentic AI v1.5 – testing before and after deployment | — (system-level) | _TBD_ | _TBD_ | _TBD_ |
| AGT-15 | Visitor feedback | Should | Active | Gap review v0.3; Appx A A21 | UC-16, UC-20, UC-36 | _TBD_ | _TBD_ | _TBD_ |
| AGT-16 | Visitor scope | Must | Active | Owner request v0.4; IMDA Agentic AI v1.5 – agent identity and access limits | UC-20 | _TBD_ | _TBD_ | _TBD_ |
| AGT-17 | Owner coaching mode | Must | Active | Owner request v0.4 | UC-04, UC-16 | _TBD_ | _TBD_ | _TBD_ |
| CHN-01 | Single ChannelAdapter abstraction (receive → normalise → agent → send) so new… | Must | Active | Research P3 | UC-25 | _TBD_ | _TBD_ | _TBD_ |
| CHN-02 | Web widget | Must | Active | Research P3; Appx A A6, A11 | UC-05, UC-20 | _TBD_ | _TBD_ | _TBD_ |
| CHN-03 | First-party intent tracking (inside the widget script) | Must | Active | Research P3; Appx A A17; D8; PDPA – consent and purpose limitation | UC-20 | _TBD_ | _TBD_ | _TBD_ |
| CHN-04 | Email channel | Must | Active | Research P3; Appx A A10 | UC-25, UC-27 | _TBD_ | _TBD_ | _TBD_ |
| CHN-05 | Telegram | Must | Active | Research P3; Appx A A21 | UC-25, UC-26 | _TBD_ | _TBD_ | _TBD_ |
| CHN-06 | Facebook Messenger and Instagram DM via the Meta Graph API: connect a Page / IG… | Should | Active | Research P3; Appx A A21 | UC-25 | _TBD_ | _TBD_ | _TBD_ |
| CHN-07 | Channel handoff | Must | Active | Research P3 | UC-26 | _TBD_ | _TBD_ | _TBD_ |
| CHN-08 | Contact identity | Must | Active | Research P3 | UC-21, UC-26 | _TBD_ | _TBD_ | _TBD_ |
| CHN-09 | Visitor attachments in the widget | Should | Active | Gap review v0.3; Appx A A11 | UC-20 | _TBD_ | _TBD_ | _TBD_ |
| CHN-10 | Email safety | Must | Active | Gap review v0.3; Appx A A10 | UC-27 | _TBD_ | _TBD_ | _TBD_ |
| CHN-11 | Widget allowed origins | Must | Active | Gap review v0.3; Appx A A9 | UC-05 | _TBD_ | _TBD_ | _TBD_ |
| CHN-12 | Channel health | Must | Active | Gap review v0.3; Appx A A19 | UC-25, UC-27 | _TBD_ | _TBD_ | _TBD_ |
| CHN-13 | Visitor controls in the widget | Must | Active | Gap review v0.3 | UC-05, UC-20, UC-23 | _TBD_ | _TBD_ | _TBD_ |
| CHN-14 | Theme matching | Must | Active | Owner request v0.4 | UC-05, UC-20 | _TBD_ | _TBD_ | _TBD_ |
| INB-01 | Unified real-time inbox across all channels | Must | Active | Research P2, P3 | UC-23 | _TBD_ | _TBD_ | _TBD_ |
| INB-02 | Takeover | Must | Active | Research P2, P3; IMDA Agentic AI v1.5 – human checkpoints for high-stakes or irreversible actions | UC-23, UC-31 | _TBD_ | _TBD_ | _TBD_ |
| INB-03 | AI-suggested replies for staff (draft only) | Must | Active | Research P2, P3 | UC-16, UC-23 | _TBD_ | _TBD_ | _TBD_ |
| INB-04 | Conversation sidebar | Must | Active | Research P2, P3 | UC-23 | _TBD_ | _TBD_ | _TBD_ |
| INB-05 | Escalation routing | Must | Active | Research P2, P3; Appx A A12 | UC-23 | _TBD_ | _TBD_ | _TBD_ |
| INB-06 | Mobile-first responsive inbox (as a PWA) so owners can reply from their phone | Should | Active | Research P2, P3 | UC-23 | _TBD_ | _TBD_ | _TBD_ |
| INB-07 | Internal notes and conversation tags | Should | Active | Research P2, P3 | UC-23 | _TBD_ | _TBD_ | _TBD_ |
| INB-08 | Conversation lifecycle | Must | Active | Gap review v0.3; Appx A A14 | UC-20, UC-22, UC-23 | _TBD_ | _TBD_ | _TBD_ |
| INB-09 | Concurrent staff | Must | Active | Gap review v0.3; Appx A A14 | UC-23 | _TBD_ | _TBD_ | _TBD_ |
| INB-10 | Saved replies | Could | Active | Gap review v0.3 | UC-23 | _TBD_ | _TBD_ | _TBD_ |
| INB-11 | Conversation search by contact name, email, phone or message text, within the… | Must | Active | Gap review v0.3; Appx A A21 | UC-23 | _TBD_ | _TBD_ | _TBD_ |
| LED-01 | Lead capture | Must | Active | Research P3 | UC-21 | _TBD_ | _TBD_ | _TBD_ |
| LED-02 | PDPA consent | Must | Active | Research P3; PDPA – consent and purpose limitation | UC-03, UC-21 | _TBD_ | _TBD_ | _TBD_ |
| LED-03 | Lead qualification | Must | Active | Research P3 | UC-21 | _TBD_ | _TBD_ | _TBD_ |
| LED-04 | Owner alerts for new hot leads, escalations and pending approvals, by email and… | Must | Active | Research P3; Appx A A12 | UC-21, UC-22, UC-25 | _TBD_ | _TBD_ | _TBD_ |
| LED-05 | Leads list with status pipeline (New → Contacted → Won / Lost) and CSV export | Must | Active | Research P3 | UC-24, UC-28 | _TBD_ | _TBD_ | _TBD_ |
| LED-06 | Outbound webhook on lead created/updated (for Zapier/Make/CRMs) | Should | Active | Research P3; D2 | UC-28 | _TBD_ | _TBD_ | _TBD_ |
| LED-07 | Consent withdrawal | Must | Active | Gap review v0.3; Appx A A8; PDPA – withdrawal of consent | UC-28, UC-30 | _TBD_ | _TBD_ | _TBD_ |
| LED-08 | Marketing consent is asked for separately from enquiry consent, and is off… | Should | Active | Gap review v0.3; Appx A A8; PDPA – consent and purpose limitation; Do Not Call provisions (PDPA Part 9) | UC-21 | _TBD_ | _TBD_ | _TBD_ |
| LED-09 | Duplicate leads | Must | Active | Gap review v0.3; Appx A A21 | UC-21 | _TBD_ | _TBD_ | _TBD_ |
| APR-01 | Boundary rule configuration | Must | Active | Research P2; IMDA Agentic AI v1.5 – defined operational boundaries | UC-03, UC-22, UC-29 | _TBD_ | _TBD_ | _TBD_ |
| APR-02 | Approval queue | Must | Active | Research P2; D3; IMDA Agentic AI v1.5 – human checkpoints for high-stakes or irreversible actions | UC-22 | _TBD_ | _TBD_ | _TBD_ |
| APR-03 | Approve from mobile through a secure link in the alert (signed, single-use,… | Must | Active | Research P2; IMDA Agentic AI v1.5 – human checkpoints for high-stakes or irreversible actions | UC-22 | _TBD_ | _TBD_ | _TBD_ |
| APR-04 | While waiting, the agent tells the visitor the team is checking and gives an… | Must | Active | Research P2; IMDA Agentic AI v1.5 – human checkpoints for high-stakes or irreversible actions | UC-22 | _TBD_ | _TBD_ | _TBD_ |
| APR-05 | Approval analytics | Should | Active | Research P2; IMDA – reducing automation bias | UC-36, UC-37 | _TBD_ | _TBD_ | _TBD_ |
| APR-06 | Approval concurrency and expiry | Must | Active | Gap review v0.3; Appx A A14; IMDA Agentic AI v1.5 – human checkpoints for high-stakes or irreversible actions | UC-22 | _TBD_ | _TBD_ | _TBD_ |
| GOV-01 | Immutable audit log | Must | Active | Research P2; Appx A A2; D7; IMDA Agentic AI v1.5 – logging and audit trails | UC-12, UC-15, UC-16, UC-20, UC-22, UC-24, UC-29, UC-30, UC-31, UC-32, UC-33, UC-35 | _TBD_ | _TBD_ | _TBD_ |
| GOV-02 | Audit viewer with filters and export (CSV/JSON) for a conversation or a date… | Must | Active | Research P2; IMDA Agentic AI v1.5 – logging and audit trails | UC-32 | _TBD_ | _TBD_ | _TBD_ |
| GOV-03 | Tenant isolation | Must | Active | Research P2; IMDA Agentic AI v1.5 – agent identity and access limits; PDPA – protection obligation | — (system-level) | _TBD_ | _TBD_ | _TBD_ |
| GOV-04 | PII handling | Must | Active | Research P2; PDPA – protection obligation | UC-11, UC-20, UC-30 | _TBD_ | _TBD_ | _TBD_ |
| GOV-05 | Data-subject requests (PDPA) | Must | Active | Research P2; Appx A A2, A4, A12; PDPA – access and correction (including vector stores) | UC-28, UC-30 | _TBD_ | _TBD_ | _TBD_ |
| GOV-06 | Retention | Must | Active | Research P2; Appx A A2; D7; PDPA – retention limitation | UC-35 | _TBD_ | _TBD_ | _TBD_ |
| GOV-07 | Data-intermediary documentation available in-app | Must | Active | Research P2; Appx A A3; PDPC GenAI guidelines – data-intermediary documentation | UC-01 | _TBD_ | _TBD_ | _TBD_ |
| GOV-08 | Kill switch | Must | Active | Research P2; IMDA Agentic AI v1.5 – human checkpoints for high-stakes or irreversible actions | UC-31 | _TBD_ | _TBD_ | _TBD_ |
| GOV-09 | Periodic oversight review | Should | Active | Research P2; IMDA Agentic AI v1.5 – testing before and after deployment; IMDA – reducing automation bias | UC-16, UC-36 | _TBD_ | _TBD_ | _TBD_ |
| GOV-10 | Security incidents | Must | Active | Gap review v0.3; Appx A A8; PDPA – data breach notification (organisation notifies PDPC; data intermediary notifies organisation) | UC-38 | _TBD_ | _TBD_ | _TBD_ |
| GOV-11 | Cross-border transfers | Must | Active | Gap review v0.3; Appx A A3; D5; PDPA – transfer limitation | — (system-level) | _TBD_ | _TBD_ | _TBD_ |
| GOV-12 | Tenant data export | Must | Active | Gap review v0.3; Appx A A21 | UC-08, UC-24 | _TBD_ | _TBD_ | _TBD_ |
| GOV-13 | Abuse protection | Must | Active | Gap review v0.3; Appx A A9; PDPA – protection obligation | UC-20, UC-34 | _TBD_ | _TBD_ | _TBD_ |
| GOV-14 | Visitor privacy notice | Must | Active | Gap review v0.3; Appx A A8; PDPA – notification (privacy notice) | UC-03, UC-20 | _TBD_ | _TBD_ | _TBD_ |
| DSH-01 | Home dashboard | Must | Active | Research P5, P6 | UC-37 | _TBD_ | _TBD_ | _TBD_ |
| DSH-02 | Analytics | Must | Active | Research P5, P6 | UC-37 | _TBD_ | _TBD_ | _TBD_ |
| DSH-03 | Team management | Must | Active | Research P5, P6 | UC-06 | _TBD_ | _TBD_ | _TBD_ |
| DSH-04 | Plan stubs | Must | Active | Research P5; Appx A A5; D2, D6 | UC-25, UC-34 | _TBD_ | _TBD_ | _TBD_ |
| DSH-05 | EIS-ready expense report | Should | Active | Research P6; EIS AI-adoption deduction | UC-37 | _TBD_ | _TBD_ | _TBD_ |
| DSH-06 | Platform operator console | Must | Active | Research P5, P6; IMDA Agentic AI v1.5 – agent identity and access limits | UC-33, UC-34 | _TBD_ | _TBD_ | _TBD_ |
| DSH-07 | Plan lifecycle | Must | Active | Gap review v0.3; Appx A A18; D10 | UC-01, UC-34 | _TBD_ | _TBD_ | _TBD_ |
| DSH-08 | Usage meter | Must | Active | Gap review v0.3; Appx A A18 | UC-34, UC-37 | _TBD_ | _TBD_ | _TBD_ |
| DSH-09 | Notification preferences | Must | Active | Gap review v0.3; Appx A A12, A18 | UC-21, UC-37 | _TBD_ | _TBD_ | _TBD_ |
| DSH-10 | Help and support | Should | Active | Gap review v0.3; Appx A A21 | UC-33 | _TBD_ | _TBD_ | _TBD_ |
| NFR-01 | Performance — Agent first token p95 ≤ 3 s | Must | Active | SRS v0.1 (C1, A1); Appx A A20 | UC-20 | _TBD_ | _TBD_ | _TBD_ |
| NFR-02 | Performance — Widget ≤ 30 KB gzipped initial load | Must | Active | SRS v0.1 (C1, A1) | — (system-level) | _TBD_ | _TBD_ | _TBD_ |
| NFR-03 | Scalability — MVP target | Must | Active | SRS v0.1 (C1, A1) | — (system-level) | _TBD_ | _TBD_ | _TBD_ |
| NFR-04 | Availability — 99.5% monthly for the agent and widget API, and for the… | Must | Active | SRS v0.1 (C1, A1) | — (system-level) | _TBD_ | _TBD_ | _TBD_ |
| NFR-05 | Security — OWASP ASVS Level 1; TLS 1.2+; encryption at rest (RDS, S3, KMS) | Must | Active | SRS v0.1 (C1, A1); PDPA – protection obligation | — (system-level) | _TBD_ | _TBD_ | _TBD_ |
| NFR-06 | Security — Controls aligned with Cyber Essentials (SG) to prepare for IMDA… | Must | Active | SRS v0.1 (C1, A1) | — (system-level) | _TBD_ | _TBD_ | _TBD_ |
| NFR-07 | Privacy — All tenant data and backups stored in ap-southeast-1. LLM calls under… | Must | Active | SRS v0.1 (C1, C2); Appx A A3; D5; PDPA – transfer limitation | — (system-level) | _TBD_ | _TBD_ | _TBD_ |
| NFR-08 | Reliability — Database point-in-time recovery for 7 days and daily backups kept… | Must | Active | SRS v0.1 (C1, A1) | — (system-level) | _TBD_ | _TBD_ | _TBD_ |
| NFR-09 | Accessibility — WCAG 2.1 AA for the widget and dashboard | Must | Active | SRS v0.1 (C1, A1) | — (system-level) | _TBD_ | _TBD_ | _TBD_ |
| NFR-10 | Localisation — UI in English for the MVP (Chinese UI could come later) | Must | Active | SRS v0.1 (C1, A1) | — (system-level) | _TBD_ | _TBD_ | _TBD_ |
| NFR-11 | Observability — Structured logs, traces and metrics | Must | Active | SRS v0.1 (C1, A1) | UC-38 | _TBD_ | _TBD_ | _TBD_ |
| NFR-12 | Maintainability — Monorepo with CI (lint, typecheck, unit, integration, AI eval) | Must | Active | SRS v0.1 (C1, A1) | — (system-level) | _TBD_ | _TBD_ | _TBD_ |
| NFR-13 | Cost — Average LLM cost per conversation tracked | Must | Active | SRS v0.1 (C1, A1); Appx A A5; D6 | — (system-level) | _TBD_ | _TBD_ | _TBD_ |
| NFR-14 | Compatibility — Dashboard and widget support the latest two versions of Chrome,… | Must | Active | Gap review v0.3; Appx A A20 | — (system-level) | _TBD_ | _TBD_ | _TBD_ |
| NFR-15 | Security — Dependency and container scanning in CI; critical vulnerabilities… | Must | Active | Gap review v0.3; Appx A A20; PDPA – protection obligation | — (system-level) | _TBD_ | _TBD_ | _TBD_ |
| NFR-16 | Performance — Ingestion throughput | Must | Active | Gap review v0.3; Appx A A20 | UC-10 | _TBD_ | _TBD_ | _TBD_ |
| NFR-17 | Reliability — No inbound or outbound message is lost | Must | Active | Gap review v0.3; Appx A A19, A20 | UC-27 | _TBD_ | _TBD_ | _TBD_ |
| NFR-18 | Interoperability — Platform-sent email (alerts, email channel) uses SPF, DKIM… | Must | Active | Gap review v0.3; Appx A A10, A20 | UC-27 | _TBD_ | _TBD_ | _TBD_ |
| NFR-19 | Usability — Every list, form and long-running job shows explicit empty, loading… | Must | Active | Gap review v0.3; Appx A A20 | — (system-level) | _TBD_ | _TBD_ | _TBD_ |
| NFR-20 | Operability — During the pilot, operator alerts are acknowledged within 1 hour… | Must | Active | Gap review v0.3; Appx A A20 | UC-38 | _TBD_ | _TBD_ | _TBD_ |

## Summary
| Measure | Count |
|---|---|
| Functional requirements | 117 (Must 99, Should 16, Could 2) |
| Non-functional requirements | 20 |
| Use cases | 34 |
| Functional requirements with no use case (system-level) | 3 |
| Removed requirements | 1 |
