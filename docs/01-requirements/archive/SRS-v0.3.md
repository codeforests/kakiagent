# Software Requirements Specification (SRS)
## AI Customer Agent SaaS for Singapore SMEs — MVP

| Field | Value |
|---|---|
| Version | 0.3 (review gaps closed; decisions D5–D10 confirmed) |
| Date | 2026-10-18 |
| Status | D1–D10 confirmed; awaiting product-owner sign-off of the SRS |
| Requirement syntax | shall (free-form statements, each with acceptance criteria) |
| Companion documents | [use-cases.md](use-cases.md), [rtm.md](rtm.md) |
| Sources | `Singapore SME AI Agent Analysis.docx`, `Singapore SME SaaS PEST Analysis.docx` |

### Revision history
| Version | Date | Author | Changes |
|---|---|---|---|
| 0.3 | 2026-10-18 | Claude (for product owner) | Gap review (see Appendix A). **Added** AUTH-01..08 (new area), ONB-09..10, KB-11..15, AGT-12..15, CHN-09..13, INB-08..11, LED-07..09, APR-06, GOV-10..14, DSH-07..10, NFR-14..20, terms in §1.4, C4, A3, journeys J8–J10, compliance rows. **Modified** ONB-03, ONB-05, ONB-07, KB-01, KB-03, KB-04, KB-05, KB-09, AGT-02, AGT-05, AGT-08, AGT-10, CHN-02, CHN-03, CHN-04, CHN-05, CHN-06, CHN-08, INB-01, INB-03, INB-05, INB-06, LED-04, LED-05, LED-06, APR-02, APR-04, GOV-01, GOV-05, GOV-06, GOV-07, GOV-08, DSH-01, DSH-02, DSH-03, DSH-04, DSH-06, NFR-01, NFR-03, NFR-04, NFR-05, NFR-07, NFR-08, NFR-11, NFR-13; §1.3, §1.5, §2, §2.1, §5, §6, §8. **Removed** none. Decisions D5–D10 proposed and confirmed by the product owner on 2026-10-18. Use-case document and RTM created. |
| 0.2 | 2026-10-18 | — | Decisions D1–D4 added. |
| 0.1 | 2026-10-18 | — | First draft from research documents. |

---

## 1. Introduction

### 1.1 Purpose
This document defines the requirements for the MVP of a multi-tenant SaaS platform. The platform lets Singapore SMEs onboard themselves in minutes, build a knowledge base automatically from the material they already have, and engage potential customers through an AI agent across web, email and messaging channels. It also builds in governance aligned with IMDA's Model AI Governance Framework for Agentic AI (v1.5) and the PDPA.

### 1.2 Problem statement (from research)
| # | Finding | Product response |
|---|---|---|
| P1 | Owner **attention** and **fragmented data** block AI adoption, not licence cost. 76.6% of SMEs have not adopted AI yet. | Zero-ETL onboarding: automatic ingestion and structuring of websites, documents, spreadsheets and chat exports. |
| P2 | Fear of hallucinated prices, unauthorised commitments and PDPA breaches. Rated the single biggest external risk. | Grounded answers, boundary rules, human approval for commitments, immutable audit log. |
| P3 | Consumers use web chat for a first enquiry, then move to messaging apps. | Widget acts as an intent-capture layer and hands off to messaging channels with the context kept. |
| P4 | Western LLM templates misread Singlish and code-switching. | Local-language understanding (EN, Singlish, Simplified Chinese). |
| P5 | Dislike of per-resolution fees and API markups. | Flat-rate plan tiers (stubbed in MVP). |
| P6 | EIS 400% AI tax deduction (YA2027–28) and EDGE grant. | EIS-ready expense report; controls designed with future IMDA pre-approval and Cyber Essentials in mind. |

### 1.3 Scope
**In MVP:** tenant sign-up and account management, onboarding, KB ingestion and structuring, AI agent, web widget with intent tracking, email channel, Telegram channel, Instagram/Facebook Messenger channel (a *Should*: built and tested in the Meta sandbox; going live depends on Meta app review), shared inbox with human takeover, lead capture, approval queue, owner alerts, boundary rules, audit log, PDPA data-subject tooling, analytics, team roles, stubbed plans with trial and usage metering, EIS report, platform operator console.

**Out of MVP (Phase 2+):** WhatsApp Business API (the channel adapter is designed for it now), agency/reseller console, Stripe billing, appointment booking, order capture and status lookup, Xero/Shopify/HubSpot connectors, Malay/Tamil, Chinese dashboard UI, native mobile apps, voice, DNS-based website ownership verification (see D9).

### 1.4 Definitions
| Term | Meaning |
|---|---|
| Tenant | One SME customer organisation. |
| Visitor / Contact | An end customer of the SME who talks to the agent. A Contact is a visitor who has been identified. |
| KB | Knowledge base: structured entities plus indexed text chunks. |
| HITL | Human in the loop: a person approves before an action takes effect. |
| Boundary rule | A tenant-defined limit on what the AI may say or do by itself. |
| Escalation | The conversation is handed to a human staff member. |
| Approval | A draft the AI prepares (quote, discount, commitment) that needs a human decision before it is sent. |
| Conversation | One thread with one contact on one or more linked channels, from the first message until it is closed (INB-08). Fair-use limits and cost targets count conversations, not messages. |
| AI-resolved conversation | A conversation closed without escalation, takeover or a pending approval, and not marked unhelpful by the visitor (AGT-15). The "AI resolution rate" (DSH-01) is AI-resolved conversations ÷ all closed conversations. |
| Business hours | The tenant's operating hours (ONB-03), excluding SG public holidays unless the tenant marks itself open on them. SLAs stated in business hours count only these hours. |
| Urgent item | An escalation the visitor explicitly requested, or an approval within 30 minutes of breaching its SLA (APR-04). Urgent items bypass quiet hours (LED-04). |
| Evaluation set | The versioned test dataset defined in AGT-14. Acceptance criteria that say "on the evaluation set" refer to it. |
| Fair use | The per-tier monthly conversation volume (D6) above which the operator may contact the tenant. It is not a hard cut-off. |
| Data intermediary | Under the PDPA, an organisation that processes personal data on behalf of another. The platform is a data intermediary for each tenant. |

### 1.5 Constraints and assumptions
- C1: TypeScript full stack; hosted on AWS ap-southeast-1 (Singapore). All tenant data at rest, including backups, is stored in Singapore.
- C2: LLM is Anthropic Claude under zero-data-retention terms. Customer data is never used for model training.
- C3: Meta app review is needed before Instagram/Messenger can go live with real customers.
- C4: Inference (LLM and embedding calls) may be processed outside Singapore, depending on D5. Any such processing is transient, under zero-retention terms, and covered by the transfer safeguards in GOV-11.
- A1: Pilot tenants are small (1–20 staff), with fewer than 5,000 conversations per month each.
- A2: Tenants are responsible for the accuracy of the source material they upload. The platform flags conflicts but does not verify facts against the outside world.
- A3: Tenants are responsible for having the right to use the websites and files they ingest (KB-13), and for their own privacy policy towards their customers. The platform supplies templates and the consent mechanism.

---

## 2. Stakeholders and users

| Role | Description | Key needs |
|---|---|---|
| **Owner** (tenant) | SME founder or manager. Busy, often on mobile. | Set up fast, trust the bot, approve on the go, see the leads. |
| **Admin** (tenant) | Office manager or marketing staff. | Maintain the KB, configure channels and rules, manage the team. |
| **Agent** (tenant staff) | Sales or service staff. | Take over chats, reply, work through escalations. |
| **Visitor** | Prospective customer of the SME. | Fast, accurate answers in their own language; a human when needed; control over their personal data. |
| **Platform Operator** | Us (the SaaS provider). | Tenant support, monitoring, abuse handling. Never reads tenant data casually. |

### 2.1 Role permissions
| Capability | Owner | Admin | Agent |
|---|:-:|:-:|:-:|
| Billing / plan, delete tenant, transfer ownership, grant support access, require MFA | ✔ | | |
| Team management | ✔ | ✔ | |
| KB, channels, boundary rules, widget settings | ✔ | ✔ | |
| Kill switch (GOV-08) | ✔ | ✔ | |
| Approve / reject approvals | ✔ | ✔ | if granted by Owner (D3) |
| Inbox: view, take over, reply | ✔ | ✔ | ✔ |
| Leads: view / export | ✔ | ✔ | view |
| Audit log, PDPA requests, tenant data export | ✔ | ✔ | |
| Analytics | ✔ | ✔ | own stats |
| Own notification preferences, own profile, own sessions | ✔ | ✔ | ✔ |

Platform Operators are not tenant members. Their capabilities are limited to the operator console (DSH-06); they reach tenant content only through a support-access grant.

---

## 3. Functional requirements

Priority uses MoSCoW: **M** = Must, **S** = Should, **C** = Could. Each requirement has an ID for traceability to design and tests. IDs are permanent: a removed requirement keeps its row, marked *Removed*, and its number is never reused.

### 3.1 Account and onboarding (ONB)
| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| ONB-01 | M | Sign up with an email magic link or Google. | A new user can create a tenant and land in the wizard within 1 minute. |
| ONB-02 | M | Guided wizard: business profile → sources → KB review → boundaries → channels → go live. Progress is saved at every step. | The wizard can be left and resumed. Steps after the profile can be skipped and finished later. |
| ONB-03 | M | Business profile: name, UEN (format-validated), industry (picklist), operating hours and public holidays (SG calendar preloaded), contact email/phone, default languages, GST-registered (yes/no). | Invalid UEN format is rejected. Hours drive the "after-hours" behaviour. The GST flag drives price display (KB-15). |
| ONB-04 | M | "Paste your website URL" as the first and quickest path to a working bot. | For a typical 30-page SME site, a draft KB is ready in ≤ 5 minutes. |
| ONB-05 | M | Test-your-bot playground before going live. | The owner can chat with the draft bot. Each answer shows the KB sources it used. Playground conversations are excluded from analytics and fair-use counts. |
| ONB-06 | S | Industry templates (F&B, retail, beauty/wellness, education/tuition, professional services, home services) that preload suggested boundary rules, lead fields and FAQs. | Choosing an industry pre-fills rules and lead form fields, which can be edited. |
| ONB-07 | M | Widget install: copy a one-line snippet; instructions for WordPress, Wix, Shopify and plain HTML; an "install check" that detects the snippet. | The install check turns green once the widget loads on one of the tenant's allowed origins (CHN-11). |
| ONB-08 | S | Median time from sign-up to going live is ≤ 15 minutes for a website-only tenant. | Measured through product analytics on pilot tenants. |
| ONB-09 | M | Go-live readiness check. Before the first go-live, the system checks for: a completed business profile, at least one KB source in "ready" state, the AI disclosure (AGT-11), the PDPA purpose statement (LED-02), a privacy-notice link (GOV-14), accepted current terms (AUTH-08) and saved boundary rules (APR-01). Unresolved conflicts (KB-06) are shown as warnings. | Go-live is blocked until the required items pass. The owner can go live with warnings; conflicting entities stay blocked from answers. |
| ONB-10 | M | Going live and going offline are explicit owner/admin actions per channel. A tenant that is not live never answers real visitors. | Before go-live the widget shows only a configurable "coming soon / contact us" message with lead capture, or stays hidden, as the tenant chooses. |

### 3.2 Authentication and account management (AUTH)
| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| AUTH-01 | M | Sign in with a magic link or Google. Magic links are single-use and expire after 15 minutes. Link requests are rate-limited per email and per IP address. | Expired or reused links are rejected with an option to request a new one. More than 5 link requests per email in 15 minutes are refused. The sign-in response does not reveal whether an email is registered. |
| AUTH-02 | M | Session management: sessions expire after 12 hours of inactivity and 30 days absolute; users can sign out, and sign out of all devices. | After sign-out, or after a role change or deactivation (DSH-03), the old session cannot call any API. |
| AUTH-03 | M | MFA: tenant users can enrol a TOTP authenticator; the Owner can require MFA for everyone in the tenant; MFA is mandatory for Platform Operators. Sensitive actions require re-authentication within the last 10 minutes: delete tenant, transfer ownership, grant support access, export leads or audit data, PDPA deletion, change boundary rules. | Sensitive actions are refused without a fresh re-authentication. Enforced MFA blocks dashboard access until the user has enrolled. Recovery codes are issued at enrolment. |
| AUTH-04 | M | Team invitations: invite links are single-use, expire after 7 days and bind to the invited email. One person (email) can belong to more than one tenant and switch between them. | An invite opened by a different email is rejected. The tenant switcher only lists tenants the user is an active member of. |
| AUTH-05 | M | Users can change their profile name and email. A new email takes effect only after it is verified. | The old email receives a notice of the change. Until verified, sign-in still uses the old email. |
| AUTH-06 | M | Ownership transfer: the Owner can transfer ownership to an active Admin, who must accept. A tenant always has exactly one Owner. | The old Owner becomes Admin on acceptance. The transfer is recorded in the audit log. |
| AUTH-07 | M | Tenant deletion: the Owner can delete the tenant. The tenant enters a 30-day grace period (AI off, channels disconnected, restore possible), after which all tenant data is hard-deleted from primary stores, including vector chunks and files. A data export (GOV-12) is offered first. | After the grace period, no tenant rows, chunks or files remain in primary storage; backups age out within the backup retention window (NFR-08). A PII-free deletion record is kept by the platform. |
| AUTH-08 | M | At sign-up the user accepts the Terms of Service, Acceptable Use Policy and the Data Processing Agreement (GOV-07). The acceptance is recorded with the document version and a timestamp. Material changes require re-acceptance by the Owner. | No tenant can go live without a recorded acceptance of the current versions. |

### 3.3 Knowledge base ingestion and structuring (KB)
| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| KB-01 | M | Website crawl: authorised domains only (KB-13), respects robots.txt, page limit set by the tenant's plan (D2), renders JavaScript pages. | Crawl status and page list are visible. Excluded or failed pages are listed with a reason. Pages beyond the plan limit are listed as "skipped: plan limit". |
| KB-02 | M | File upload: PDF, DOCX, PPTX, TXT, images (JPG/PNG, OCR), up to 25 MB each. | Text is extracted, including scanned PDFs through OCR. English and Chinese text supported. |
| KB-03 | M | Spreadsheet upload (CSV/XLSX) with column mapping to Product, Service, Price, Stock and SKU fields; mappings are auto-suggested. | A 500-row price list imports into structured records. The owner confirms or edits the mapping. Rows that fail validation are listed with the reason and are not imported. |
| KB-04 | M | Chat-history import (WhatsApp `.txt` export, Telegram JSON export). Mines question-and-answer pairs from the business's replies. | Mined pairs land in "Suggested FAQs" for owner approval and are never live without review. Visitor personal data in the exports is redacted before storage, and the original export file is deleted once mining finishes. |
| KB-05 | M | LLM extraction into typed entities: **Product/Service**, **Price** (amount, currency, unit, GST-inclusive or not, validity), **Policy** (refund, delivery, booking, etc.), **FAQ**, **Business hours/location**, **Promotion** (with validity dates). | Every entity links to its source document and location (provenance). |
| KB-06 | M | Conflict detection: the same entity with different values from different sources (such as two prices for one SKU) is flagged and blocked from use until resolved. | Conflicting prices are never quoted. The owner sees a "Resolve" list with both sources side by side. |
| KB-07 | M | KB manager: browse, search, edit, disable and delete entities and documents; manual FAQ entry. | An edit takes effect in agent answers within 60 seconds. |
| KB-08 | S | Freshness: scheduled re-crawl (weekly by default); changed pages are re-extracted; expired promotions are disabled automatically. | Changes since the last crawl are shown as a diff for review. |
| KB-09 | M | Coverage report: lists common customer topics for the industry that the KB cannot yet answer. | Before go-live it uses the industry template's topic list (ONB-06). After go-live it shows the top gaps from escalated or unanswered questions. |
| KB-10 | C | Learn from human replies: when staff answer an escalated question, suggest it as a new FAQ. | Suggestion appears in the KB manager for approval. |
| KB-11 | M | Upload safety: every uploaded file is checked by content type (not just extension) and scanned for malware before processing. Encrypted or password-protected files are rejected with a reason. | An EICAR test file is rejected and never processed or indexed. A renamed executable is rejected. |
| KB-12 | M | Processing status: every source (crawl, file, spreadsheet, chat export) shows its state — queued, processing, ready, failed — with a reason on failure and a retry action. | A failed source never leaves partial entities live. The owner is alerted when a source they added fails. |
| KB-13 | M | Website authorisation: before a crawl, the tenant confirms it owns or is authorised to use the domain (attestation, D9). Crawls stay within the confirmed domain and any subdomains the tenant lists. Confirmed domains become the widget's default allowed origins (CHN-11). | A crawl without an attestation cannot start. Links to other domains are not followed. The attestation is recorded in the audit log. |
| KB-14 | S | Entity history: every KB entity edit keeps the previous version, and an earlier version can be restored. | The history shows who changed what and when. A restore is recorded in the audit log. |
| KB-15 | M | GST-aware prices: when the tenant is GST-registered (ONB-03), the agent quotes prices to visitors inclusive of GST, and the KB marks prices whose GST treatment is unknown for owner review. | For a GST-registered tenant, no quoted price is GST-exclusive unless the reply also states the GST-inclusive amount. Prices with unknown treatment are flagged and are not quoted until reviewed. |

### 3.4 AI agent behaviour (AGT)
| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| AGT-01 | M | Answers only from the tenant's KB and profile (grounded). Each answer stores the IDs of the KB items it used. | On the evaluation set: groundedness ≥ 95%; no answer cites non-existent sources. |
| AGT-02 | M | **Price and fact integrity:** prices, stock, dates and policies in a reply must match a structured KB entity exactly; otherwise the reply is blocked and regenerated or escalated. The check runs before any part of the reply reaches the visitor, including streamed replies. | 100% price accuracy on the evaluation set. Zero invented prices. No unverified price, stock, date or policy value is ever displayed, even briefly during streaming. |
| AGT-03 | M | Understands English, Singlish (code-switching, particles such as "lah"/"leh"/"can or not", local terms such as "tapau", "chope", HDB, MRT) and Simplified Chinese. Replies in the visitor's language or matches their register. | Intent accuracy ≥ 90% on the Singlish/Chinese evaluation subsets. |
| AGT-04 | M | When confidence is low or the question is out of scope, the agent says it will check with the team, offers handoff or lead capture, and never guesses. | Out-of-scope questions trigger a refusal or escalation ≥ 95% of the time. |
| AGT-05 | M | Uses web context: current page, pages viewed, dwell time and returning-visitor status, to personalise (for example, "I see you're looking at the Premium package"). When tracking is off or the visitor has not consented in consent mode (CHN-03), only the current page is used. | Context is passed to the agent and recorded in the audit log. Never reveals tracking details beyond what is on the page. |
| AGT-06 | M | Tools available to the agent: `capture_lead`, `escalate_to_human`, `draft_approval` (quote, discount, custom commitment), `lookup_kb`, `handoff_channel`. No tool may take an irreversible external action without approval. | Tool calls are audited. `draft_approval` never sends to the visitor before approval. |
| AGT-07 | M | Prompt-injection resistance: visitor text and KB content are treated as data; attempts to change the agent's rules, reveal the system prompt or other tenants' data are refused. | Passes the red-team suite (≥ 50 cases) with zero data leaks. |
| AGT-08 | M | Configurable persona: bot name, tone (friendly / professional), greeting, emoji on or off. Register matching (AGT-03) stays within the chosen tone. | Settings are reflected in replies. |
| AGT-09 | M | After hours: tells the visitor when staff will be back, still answers from the KB and captures leads. | Behaviour follows the tenant's hours and SG public holidays. |
| AGT-10 | S | Proactive greeting triggered by intent signals (for example, ≥ 30 seconds on the pricing page, or a second visit). Tenant can configure or turn it off. Available on plans that include it (D2). | Fires at most once per session. Respects "do not disturb" rules. |
| AGT-11 | M | Discloses that it is an AI assistant at the start of a conversation. | Disclosure text appears in the first message and can be edited but not removed. |
| AGT-12 | M | Conversation memory: the agent uses the conversation's history, including history carried over from a linked channel (CHN-07). Long conversations are summarised so that facts the visitor gave (name, need, quantities) are not lost. | In a 40-turn evaluation conversation, the agent still uses details given in turn 2. |
| AGT-13 | M | Harmful and abusive content: the agent declines harassment, illegal requests, and medical, legal or financial advice with a safe, polite reply; mentions of self-harm get a reply with SG crisis-support contacts and an escalation. Repeated abuse ends the AI conversation and flags it to staff. | Passes the harmful-content subset of the evaluation set. Flagged conversations appear in the inbox under "flagged". |
| AGT-14 | M | Evaluation suite: a versioned evaluation set for the pilot vertical (D1) with at least 300 cases — groundedness, prices (≥ 50), Singlish (≥ 100), Simplified Chinese (≥ 50), out-of-scope (≥ 50), harmful content (≥ 20) — plus the red-team suite (AGT-07). It runs in CI; a release that lowers any threshold in AGT-01..04, AGT-07 or AGT-13 is blocked. | Scores are produced automatically. The automated scorer agrees with human labels on ≥ 90% of a 10% sample, re-checked for each new evaluation-set version. |
| AGT-15 | S | Visitor feedback: thumbs up/down on AI replies and an optional rating at the end of the conversation. | Feedback shows on the conversation and in analytics (DSH-02). A thumbs-down makes the conversation count as not AI-resolved. |

### 3.5 Channels (CHN)
| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| CHN-01 | M | Single `ChannelAdapter` abstraction (receive → normalise → agent → send) so new channels, including WhatsApp in Phase 2, plug in without changing the core. | Adding a channel needs only a new adapter module and a config entry. |
| CHN-02 | M | **Web widget:** async snippet, ≤ 30 KB gzipped, does not block page rendering; brandable colour, logo and position; mobile responsive; WCAG 2.1 AA; streaming replies (subject to AGT-02). | Lighthouse performance change ≤ 2 points on the test site. Passes an axe scan with no serious or critical issues. |
| CHN-03 | M | **First-party intent tracking** (inside the widget script): page views, dwell time, scroll depth, UTM parameters, referrer, returning visitor. Uses a first-party ID only and no third-party cookies. Tracking data stays pseudonymous until the visitor gives consent under LED-02. A consent mode is available that collects nothing beyond the current page until the visitor accepts (default per D8). | Events show in the conversation sidebar. Tracking can be turned off per tenant. In consent mode, no tracking event is sent before acceptance. |
| CHN-04 | M | **Email channel:** each tenant gets a forwarding address (`<tenant>@in.<domain>`) or connects a custom domain; the agent replies by email in the same thread. A custom sending domain requires verified SPF, DKIM and DMARC records. | Replies thread correctly in Gmail and Outlook. Attachments are stored, after the checks in KB-11. Sending from an unverified custom domain is not possible. |
| CHN-05 | M | **Telegram:** connect a bot token created with BotFather; supports 1:1 chats only. | Messages flow both ways. The owner's alerts can also go to Telegram. Messages from group chats are ignored and the bot replies that it works only in private chats. |
| CHN-06 | S | **Facebook Messenger and Instagram DM** via the Meta Graph API: connect a Page / IG business account. | Works in Meta sandbox; going live depends on Meta app review. Meta's messaging-window rules are respected (no reply outside the allowed window). |
| CHN-07 | M | **Channel handoff:** from the widget, the visitor can continue on Telegram or email (deep link or form); the conversation history and context follow. | The new channel's thread is linked to the same Contact and conversation. |
| CHN-08 | M | Contact identity: a single contact record across channels, merged by verified email, phone or Telegram ID; staff can merge manually. | No automatic merge on unverified data. A manual merge can be undone and is recorded in the audit log. |
| CHN-09 | S | Visitor attachments in the widget: JPG, PNG and PDF up to 10 MB, checked as in KB-11 and handled under GOV-04. The agent may read an attached image or PDF to answer. | Unsupported or unsafe files are refused with a message. Attachments are deleted with the conversation (GOV-06). |
| CHN-10 | M | Email safety: the email channel does not auto-reply to auto-replies, bounces, mailing lists or bulk mail (detected from standard headers), limits AI replies per thread (default 10 per 24 hours) and filters spam. | A test out-of-office reply never gets an AI response. A mail loop between two auto-responders stops at the cap. |
| CHN-11 | M | Widget allowed origins: the widget only works on the tenant's allowed domains (KB-13 plus any the tenant adds). Requests from other origins are rejected. | Embedding a tenant's snippet on an unlisted domain shows nothing and creates no conversation. |
| CHN-12 | M | Channel health: a disconnected or revoked channel credential (Telegram token, Meta token, custom email domain) is detected, the channel is shown as degraded, and the Owner/Admin is alerted. | Detection within 15 minutes. Outbound messages that fail are queued and retried (NFR-19), never silently dropped. |
| CHN-13 | M | Visitor controls in the widget: an always-visible "talk to a person" option, a link to the tenant's privacy notice (GOV-14), and a way to end the chat. | "Talk to a person" triggers escalation (INB-05), or after hours lead capture with a callback promise (AGT-09). |

### 3.6 Inbox and human handoff (INB)
| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| INB-01 | M | Unified real-time inbox across all channels. Filters: open, escalated, waiting for approval, flagged, closed, by channel, by assignee. Lists are paginated. | New messages appear in ≤ 2 seconds without refreshing. |
| INB-02 | M | Takeover: staff can pause the AI in a conversation and reply directly; hand back to the AI when done. | While a human has taken over, the AI does not send any messages. The visitor sees a "staff joined" notice. |
| INB-03 | M | AI-suggested replies for staff (draft only). | Staff can edit and then send. Suggested replies pass the same AGT-02 checks. |
| INB-04 | M | Conversation sidebar: contact info, channel, intent signals, lead status, KB sources used. | Visible for every conversation. |
| INB-05 | M | Escalation routing: round-robin or a specific person; notifies by email/Telegram and web push; reminders if not picked up within N minutes (default 10, configurable). | Unclaimed escalations trigger reminders until claimed. After hours, the visitor is told when staff will respond (AGT-09). |
| INB-06 | S | Mobile-first responsive inbox (as a PWA) so owners can reply from their phone. | All inbox actions can be completed at 375 px width without horizontal scrolling. |
| INB-07 | S | Internal notes and conversation tags. | Notes are never visible to the visitor. |
| INB-08 | M | Conversation lifecycle: states are AI-handling, escalated, human, waiting-for-approval and closed. Conversations close automatically after inactivity (widget 30 minutes; email, Telegram and Meta 72 hours) or when staff close them. A new message within 7 days reopens the same conversation; later messages start a new one linked to the same contact. | State changes are shown in the inbox and recorded in the audit log. |
| INB-09 | M | Concurrent staff: only one staff member can own a taken-over conversation at a time; others see who owns it and can request it. | When two staff press "take over" at the same moment, exactly one succeeds and the other is told who has it. |
| INB-10 | C | Saved replies: staff can save and insert reusable replies. | Saved replies are shared across the tenant. |
| INB-11 | M | Conversation search by contact name, email, phone or message text, within the tenant. | Results in ≤ 2 seconds for 12 months of data at A1 volumes. |

### 3.7 Leads and automations (LED)
| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| LED-01 | M | Lead capture: the agent collects tenant-configured fields (name, phone, email, need, budget, preferred time) in conversation. | Captured fields are validated (SG phone format, email). |
| LED-02 | M | **PDPA consent:** before collecting personal data, the agent shows the tenant's purpose statement and gets explicit consent; consent is recorded with a timestamp and the wording used. | No lead is stored without a consent record. |
| LED-03 | M | Lead qualification: score (hot / warm / cold) using tenant-configurable criteria plus intent signals. | Score and reasons are visible on the lead. |
| LED-04 | M | Owner alerts for new hot leads, escalations and pending approvals, by email and Telegram (S: web push). Each user sets their channels and quiet hours (DSH-09; default quiet hours 22:00–08:00 SGT). | Alert arrives within 1 minute. Quiet hours are respected, except for urgent items (§1.4). Alerts held during quiet hours are sent as one digest when quiet hours end. |
| LED-05 | M | Leads list with status pipeline (New → Contacted → Won / Lost) and CSV export. | The export is recorded in the audit log. Leads with withdrawn consent (LED-07) are excluded from exports. |
| LED-06 | S | Outbound webhook on lead created/updated (for Zapier/Make/CRMs). Available on plans that include it (D2). | Signed payload; retries with backoff. Leads with withdrawn consent are not sent. |
| LED-07 | M | Consent withdrawal: a contact can withdraw consent in any channel (for example "stop using my details") or through the tenant. The agent recognises the request, confirms it, and records the withdrawal; the lead is marked "consent withdrawn" and the tenant is alerted. | Within 1 minute the lead is excluded from exports and webhooks. A deletion request is routed to GOV-05. Recognised on the evaluation set's withdrawal cases in EN, Singlish and Chinese. |
| LED-08 | S | Marketing consent is asked for separately from enquiry consent, and is off unless the visitor opts in. | The lead and its CSV export show the marketing-consent flag and its timestamp. The export includes a reminder that the Do Not Call Registry applies to phone and SMS marketing. |
| LED-09 | M | Duplicate leads: a returning contact updates their existing open lead instead of creating a new one. | Within the same contact, at most one lead is open at a time. |

### 3.8 Approvals and boundary rules (APR)
| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| APR-01 | M | Boundary rule configuration: allowed topics, blocked topics, maximum discount (default 0%), whether quotes need approval (default yes), forbidden commitments (delivery guarantees, refunds, legal or medical advice). | Defaults are safe. Changes are recorded in the audit log. |
| APR-02 | M | Approval queue: the AI drafts a quote, discount or commitment → it appears in the queue with the conversation context and the KB prices used → an approver (Owner/Admin, or an Agent granted the right under D3) approves, edits and approves, or rejects with a reason → the result is sent to the visitor. | Nothing is sent before a decision. Each decision is audited with the approver and timestamp. |
| APR-03 | M | Approve from mobile through a secure link in the alert (signed, single-use, 24-hour expiry, needs login). | Expired or reused links are rejected. |
| APR-04 | M | While waiting, the agent tells the visitor the team is checking and gives an expected response time. If there is no decision within the SLA, the conversation is escalated. The SLA counts business hours only. | The SLA can be configured (default 2 business hours). A request made after hours tells the visitor to expect a reply the next business day. |
| APR-05 | S | Approval analytics: average time to decide, approval rate, most common reasons for edits. | Shown on the analytics page. |
| APR-06 | M | Approval concurrency and expiry: an approval can be decided only once (the first decision wins). An approved result is delivered on the conversation's latest channel even if the conversation has closed. An undecided approval expires after 7 days and the visitor is told the team will contact them. | Two simultaneous decisions result in exactly one recorded decision. An expired approval can no longer be sent. |

### 3.9 Governance, privacy and audit (GOV)
| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| GOV-01 | M | **Immutable audit log:** append-only, hash-chained entries for agent decisions (summary of reasoning, KB IDs retrieved, tool calls, guardrail results), human actions (takeover, approval, KB and rule edits, exports) and admin events. Entries hold references and masked values only; any personal data an entry needs is kept in a separate store that can be deleted without breaking the chain (D7). | Any tampering breaks the hash-chain check. A verification tool is provided. Deleting a contact (GOV-05) leaves the chain verifiable. |
| GOV-02 | M | Audit viewer with filters and export (CSV/JSON) for a conversation or a date range. | Export completes for 30 days of data in ≤ 1 minute. |
| GOV-03 | M | **Tenant isolation:** every tenant-scoped row is protected by Postgres row-level security (RLS) in addition to application checks; vector search is always filtered by tenant. | Automated cross-tenant access tests pass in CI. |
| GOV-04 | M | PII handling: detect and mask NRIC/FIN, card numbers and bank accounts in visitor messages before storage and before sending to the LLM; mask other PII in logs. | NRIC/card numbers never appear unmasked in the database or the LLM payload (verified by tests). |
| GOV-05 | M | Data-subject requests (PDPA): find a contact's data across conversations, leads, the KB and attachments; export it, correct it, or delete it (including vector chunks and attachments). The tenant records how it verified the requester's identity before acting. The request is tracked with a due date of 30 calendar days. | Deletion removes data from primary storage immediately and from backups within the backup retention window. Requests show their status and due date, and alert the Owner/Admin 7 days before they are due. Documented. |
| GOV-06 | M | Retention: tenant-configurable retention for conversations and attachments (default 24 months) and for leads (default 24 months after last activity); automatic purge job. Audit-log retention follows D7. | Purge is recorded in the audit log. |
| GOV-07 | M | Data-intermediary documentation available in-app: data flows, the complete sub-processor list (hosting, LLM, embeddings, OCR, email delivery, and any others chosen in design), zero-retention terms, storage and processing locations. | A downloadable Data Processing Agreement (DPA) and data-flow PDF. Tenants are notified 30 days before a sub-processor is added. |
| GOV-08 | M | Kill switch: the Owner or an Admin can pause the AI on all channels instantly (human-only mode). | Takes effect within 5 seconds. Visitors see the tenant's fallback message with lead capture. Recorded in the audit log. |
| GOV-09 | S | Periodic oversight review: a monthly prompt to the owner to review a sample of AI conversations (helps counter automation bias, as the IMDA framework recommends). | Review completion is tracked. |
| GOV-10 | M | Security incidents: the platform records suspected data breaches, assesses them, and notifies affected tenants without undue delay — within 24 hours of confirming that their data is affected — with the facts each tenant needs to make its own PDPC notification. | An incident runbook exists and is tested once before pilot go-live. Notifications and their timing are recorded. |
| GOV-11 | M | Cross-border transfers: any processing of tenant data outside Singapore (D5) is listed in GOV-07 with its location, purpose and contractual safeguard, and is limited to what the processing needs. | The data-flow PDF shows each transfer. No tenant data is stored at rest outside Singapore. |
| GOV-12 | M | Tenant data export: the Owner/Admin can export all tenant data — KB entities and files, conversations, contacts, leads, consent records and the audit log — in documented JSON/CSV formats. | Export for an A1-sized tenant with 12 months of data completes within 1 hour and is available through a link valid for 24 hours. The export is recorded in the audit log. |
| GOV-13 | M | Abuse protection: per-visitor message rate limits (default 20 messages per minute), per-tenant limits on new conversations per minute, automated-traffic detection on the widget without CAPTCHAs for normal visitors, and a per-tenant daily LLM spend alert. | Traffic over a limit is refused with a polite message and does not reach the LLM. The operator is alerted when a tenant's daily LLM spend exceeds 3× its 30-day average. |
| GOV-14 | M | Visitor privacy notice: the widget links to the tenant's privacy notice. The platform offers a template the tenant can fill in. Consent and notice wordings are versioned. | A tenant cannot go live without a privacy-notice link or the completed template (ONB-09). |

### 3.10 Dashboard, analytics and plans (DSH)
| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| DSH-01 | M | Home dashboard: conversations, AI resolution rate (§1.4), escalations, leads (after-hours leads highlighted), pending approvals, KB health. | Data is at most 5 minutes old. |
| DSH-02 | M | Analytics: trends by channel, top questions, unanswered topics, conversion of visitors to leads, response times, visitor feedback. | Date-range filter; CSV export. |
| DSH-03 | M | Team management: invite by email (AUTH-04), assign role, deactivate. | Deactivated users lose access immediately. |
| DSH-04 | M | **Plan stubs:** Starter / Growth / Pro tiers as defined in D2, with fair-use thresholds from D6. Limits (channels, KB pages, files and plan features) are enforced with an upgrade prompt; seats are unlimited; conversations are fair-use only; no payment processing. | An operator can change a tenant's plan in the admin console. |
| DSH-05 | S | **EIS-ready expense report:** monthly and annual statement of subscription spend, with the fields an accountant needs for the EIS AI-adoption deduction claim. | PDF/CSV export. Includes a disclaimer that it is not tax advice. |
| DSH-06 | M | Platform operator console: list tenants, change plan, suspend (for example for Acceptable Use Policy breaches), view health and usage. No access to tenant conversations without a recorded, time-limited "support access" grant from the Owner. Every operator action is audited. | Support access is audited and visible to the tenant. Operator sign-in requires MFA (AUTH-03). |
| DSH-07 | M | Plan lifecycle: a new tenant starts on the trial defined in D10. When a plan changes to one with lower limits, content over the new limits is kept but excess sources are paused and excess channels disconnected, chosen by the Owner; nothing is deleted. | The Owner sees what will be paused before a downgrade takes effect. |
| DSH-08 | M | Usage meter: the tenant sees its usage against each limit and the fair-use level. The Owner is alerted at 80% and 100%. | The figures match the enforcement in DSH-04. |
| DSH-09 | M | Notification preferences: each user chooses which events they are notified about, on which channels (email, Telegram, web push), and their quiet hours. | Preferences take effect on the next alert. |
| DSH-10 | S | Help and support: links to help articles from each dashboard page and a contact-support form that reaches the operator. | Support requests are visible in the operator console. |

---

## 4. Non-functional requirements (NFR)

| ID | Category | Requirement |
|---|---|---|
| NFR-01 | Performance | Agent first token p95 ≤ 3 s; full reply p95 ≤ 8 s; dashboard pages p95 ≤ 1.5 s. Measured server-side at the NFR-03 load, excluding third-party channel delivery time (email, Telegram, Meta). |
| NFR-02 | Performance | Widget ≤ 30 KB gzipped initial load; the rest is lazy-loaded; never blocks rendering. |
| NFR-03 | Scalability | MVP target: 200 tenants; 1,000 concurrent conversations platform-wide at peak, with any single tenant up to 50; 1 million KB chunks in total. Workers scale horizontally. |
| NFR-04 | Availability | 99.5% monthly for the agent and widget API, and for the dashboard and inbox; planned maintenance only between 02:00–06:00 SGT with 48 hours' notice. If the LLM provider is down, fall back to "team will get back to you" plus lead capture. |
| NFR-05 | Security | OWASP ASVS Level 1; TLS 1.2+; encryption at rest (RDS, S3, KMS); secrets (including tenant channel tokens) in AWS Secrets Manager or KMS-encrypted; MFA available for tenant users and required for operators. |
| NFR-06 | Security | Controls aligned with Cyber Essentials (SG) to prepare for IMDA pre-approval: asset inventory, patching, access control, backups, malware protection. |
| NFR-07 | Privacy | All tenant data and backups stored in ap-southeast-1. LLM calls under zero-retention terms; processing locations per D5. |
| NFR-08 | Reliability | Database point-in-time recovery for 7 days and daily backups kept for 35 days; recovery point objective (RPO) ≤ 15 minutes, recovery time objective (RTO) ≤ 4 h. A restore is tested before pilot go-live and quarterly after. |
| NFR-09 | Accessibility | WCAG 2.1 AA for the widget and dashboard. |
| NFR-10 | Localisation | UI in English for the MVP (Chinese UI could come later); the agent handles EN/Singlish/Simplified Chinese; SG time zone, SGD currency, SG phone and address formats. |
| NFR-11 | Observability | Structured logs, traces and metrics; per-tenant LLM cost and token tracking; health checks for every service and channel; alerts on error rate, latency, job backlog and channel failures. |
| NFR-12 | Maintainability | Monorepo with CI (lint, typecheck, unit, integration, AI eval); infrastructure as code (Terraform); test coverage ≥ 70% on core packages. |
| NFR-13 | Cost | Average LLM cost per conversation tracked; target per D6 so flat-rate pricing stays viable at fair-use volumes. |
| NFR-14 | Compatibility | Dashboard and widget support the latest two versions of Chrome, Edge, Firefox and Safari, Safari on iOS 16+, and Chrome on Android 10+. On older browsers the widget fails silently without breaking the host page. |
| NFR-15 | Security | Dependency and container scanning in CI; critical vulnerabilities patched within 7 days and high within 30 days; an external penetration test before the first paying tenant. |
| NFR-16 | Performance | Ingestion throughput: 95% of single files ≤ 25 MB are ready within 3 minutes; a 200-page crawl is ready within 15 minutes; a 500-row spreadsheet within 1 minute after mapping is confirmed. |
| NFR-17 | Reliability | No inbound or outbound message is lost. If a dependency (LLM, embeddings, OCR, email provider, Telegram, Meta) is unavailable, work is queued and retried with backoff for at least 24 hours, then surfaced to staff as failed. |
| NFR-18 | Interoperability | Platform-sent email (alerts, email channel) uses SPF, DKIM and DMARC aligned with the sending domain; the bounce rate is monitored and alerted above 5%. |
| NFR-19 | Usability | Every list, form and long-running job shows explicit empty, loading and error states with a next action. Validation errors name the field and the fix. |
| NFR-20 | Operability | During the pilot, operator alerts are acknowledged within 1 hour between 08:00–22:00 SGT and by 09:00 the next morning otherwise; tenant support requests get a first reply within 1 business day. |

---

## 5. Compliance traceability

| Obligation (source) | Requirements |
|---|---|
| IMDA Agentic AI v1.5 – defined operational boundaries | APR-01, AGT-06 |
| IMDA Agentic AI v1.5 – human checkpoints for high-stakes or irreversible actions | APR-02–04, APR-06, INB-02, GOV-08 |
| IMDA Agentic AI v1.5 – logging and audit trails | GOV-01, GOV-02 |
| IMDA Agentic AI v1.5 – agent identity and access limits | AGT-06, GOV-03, DSH-06 |
| IMDA Agentic AI v1.5 – testing before and after deployment | AGT-14, GOV-09 |
| IMDA – reducing automation bias | GOV-09, APR-05 |
| IMDA GenAI framework – prompt injection, transparency, harmful content | AGT-07, AGT-11, AGT-13 |
| PDPA – consent and purpose limitation | LED-02, LED-08, CHN-03 |
| PDPA – withdrawal of consent | LED-07 |
| PDPA – notification (privacy notice) | GOV-14 |
| PDPA – protection obligation | GOV-03, GOV-04, GOV-13, NFR-05, NFR-15 |
| PDPA – access and correction (including vector stores) | GOV-05 |
| PDPA – retention limitation | GOV-06, AUTH-07 |
| PDPA – transfer limitation | GOV-11, NFR-07 |
| PDPA – data breach notification (organisation notifies PDPC; data intermediary notifies organisation) | GOV-10 |
| PDPC GenAI guidelines – data-intermediary documentation | GOV-07, AUTH-08 |
| Do Not Call provisions (PDPA Part 9) | LED-08 |
| GST – price display for GST-registered businesses | KB-15 |
| EIS AI-adoption deduction | DSH-05 |

---

## 6. Key user journeys (for E2E acceptance)

1. **J1 Onboard:** The owner of a bakery signs up → enters the website URL → uploads a price-list XLSX and a WhatsApp export → resolves 2 price conflicts → tests the bot in the playground → installs the widget → goes live in under 15 minutes.
2. **J2 Visitor Q&A (Singlish):** A visitor on the cakes page asks "got eggless cake or not? how much ah" → the agent answers with the exact KB price and a source, in a matching register.
3. **J3 Quote approval:** A visitor asks for 200 corporate cupcakes with a discount → the agent captures the lead (with consent) and drafts a quote → the owner gets a Telegram alert → approves an edited quote on their phone → the visitor receives it → every step appears in the audit log.
4. **J4 Takeover:** The visitor asks to speak to a person → escalation → staff take over in the inbox → hand back to the AI.
5. **J5 Channel handoff:** The visitor moves from the widget to Telegram → the history continues.
6. **J6 PDPA deletion:** A contact asks for deletion → the Admin verifies their identity, finds and deletes their data across all stores → the action is recorded in the audit log and the audit chain still verifies.
7. **J7 Chinese enquiry:** "请问周末营业时间？" (What are your weekend opening hours?) → the agent answers from the hours entity in Chinese.
8. **J8 Kill switch:** The owner sees a bad answer → pauses the AI from their phone → within 5 seconds every channel shows the fallback message → staff answer manually → the owner resumes the AI.
9. **J9 After-hours email:** At 23:00 a customer emails a catering enquiry → the agent replies in the same thread from the KB, captures the lead with consent and says staff will follow up the next business day → the owner's alert waits for the end of quiet hours.
10. **J10 Consent withdrawal:** A contact writes "pls don't keep my number" on Telegram → the agent confirms → the lead is marked "consent withdrawn" and disappears from the next CSV export.

---

## 7. Decisions

### 7.1 Confirmed (v0.2, 2026-10-18)
| # | Topic | Decision |
|---|---|---|
| D1 | Pilot vertical | **F&B, bakery and catering.** Industry template (ONB-06), evaluation datasets and the J1–J3 journeys use this vertical first. Other templates are "Should". |
| D2 | Plan tiers (stub, DSH-04) | **Starter S$49/mo:** widget + 1 other channel, 100 KB pages, 50 files. **Growth S$129/mo:** all channels, 500 pages, 200 files, proactive greetings. **Pro S$299/mo:** 2,000 pages, 1,000 files, outbound webhooks, priority support. Unlimited seats and AI conversations on every tier (fair use, D6). Meta fees, when relevant, passed through at cost. |
| D3 | Approval rights (APR-02) | Owner/Admin only by default. The Owner can grant approval rights to individual Agents. |
| D4 | Branding | Placeholder codename **"KakiAgent"**, domain `kakiagent.example`. Name and domain come from config so they can be renamed later. |

### 7.2 Confirmed (v0.3, 2026-10-18)
| # | Topic | Decision | Why it is needed | Alternatives considered |
|---|---|---|---|---|
| D5 | Where inference runs (C4, GOV-11, NFR-07) | Store everything in Singapore; allow transient LLM and embedding processing outside Singapore under zero-retention terms and contractual safeguards, declared in the DPA. During architecture, prefer a provider route that processes in Singapore or APAC if one is available for the chosen Claude model (for example Claude through Amazon Bedrock), and confirm it then. | v0.2 said "all tenant data is stored in Singapore" but said nothing about where LLM calls are processed. The PDPA Transfer Limitation Obligation applies to processing, not only storage. | (a) Singapore-only processing as a hard rule — may restrict model choice or availability. (b) No regional preference — simplest, weaker sales story. |
| D6 | Fair use and cost target (DSH-04, NFR-13) | Fair-use levels per month: **Starter 1,000**, **Growth 3,000**, **Pro 10,000** conversations. Above that, the operator contacts the tenant; no hard cut-off. LLM cost target: **≤ S$0.03 average per conversation**, using prompt caching and routing simple turns to a smaller model. | "Unlimited conversations" with no defined level, plus A1's up to 5,000 conversations per month, means a Starter tenant could cost more in LLM fees than it pays even at S$0.02 each. The S$0.02 target is also tight for multi-turn grounded replies with AGT-02 regeneration; it should be checked against current model pricing in architecture. | Keep S$0.02 and accept a smaller model for most replies; or set hard caps per tier. |
| D7 | Audit log and deletion (GOV-01, GOV-05, GOV-06) | Hash-chained entries contain only IDs, masked values and hashes. Personal data linked to an entry sits in a separate store and is deleted with the contact. Audit entries are kept for the life of the tenant plus 12 months, and at least 24 months. | v0.2's immutable log would store conversation-derived personal data, which conflicts with PDPA deletion and the retention purge. | Crypto-shredding (per-contact encryption keys destroyed on deletion); or a fixed 7-year audit retention. |
| D8 | Tracking consent default (CHN-03, AGT-05) | Tracking **on** by default as pseudonymous first-party analytics. Consent mode is **off** by default and can be turned on by the tenant. Tracking data is linked to a person only after LED-02 consent. | v0.2 had a consent mode but no default, and no rule for when tracking data becomes personal data. | Consent mode on by default (more conservative, less intent data). |
| D9 | Website authorisation (KB-13) | Attestation checkbox for the MVP; operator review for abuse reports; DNS or meta-tag verification in Phase 2. | Without a check, anyone could crawl a competitor's site into a bot. DNS verification adds friction against the 15-minute go-live target (ONB-08). | DNS/meta-tag verification in the MVP. |
| D10 | Trial (DSH-07) | New tenants get a **14-day Growth trial**. When it ends, the tenant stays on Growth limits until an operator assigns a plan (no billing in the MVP); the dashboard shows a banner. | v0.2 did not say which plan a new tenant starts on. | Start on Starter; or 30-day trial. |

## 8. Remaining open items
1. Pilot SMEs available for UAT (needed before user acceptance testing).
2. Meta developer account for Instagram/Messenger sandbox, and AWS + Anthropic accounts (needed before the build of the first walking skeleton and before the Meta channel work).
3. Legal review of the Terms of Service, Acceptable Use Policy, DPA and privacy-notice template (AUTH-08, GOV-07, GOV-14) before pilot go-live.

---

## Appendix A — v0.3 review findings and how they were resolved

| # | Finding in v0.2 | Severity | Resolution |
|---|---|---|---|
| A1 | No use-case document or RTM, which the design and planning phases need. | Blocker | Created [use-cases.md](use-cases.md) and [rtm.md](rtm.md). |
| A2 | Immutable, hash-chained audit log would hold personal data that PDPA deletion (GOV-05) and the retention purge (GOV-06) must remove. | Blocker | GOV-01, GOV-05, GOV-06 modified; D7. |
| A3 | Data residency covered storage only; LLM processing location and the PDPA Transfer Limitation Obligation were not addressed. | Blocker | C4, GOV-11, GOV-07, NFR-07; D5. |
| A4 | Data-subject requests had no identity check for the requester and no due date. | Blocker | GOV-05 modified. |
| A5 | Unlimited conversations plus the S$0.02 target did not add up against the S$49 Starter tier. | Blocker | DSH-04, NFR-13; D6. |
| A6 | Streaming replies (CHN-02) could show an invented price before the AGT-02 check blocked it. | Blocker | AGT-02, CHN-02 modified. |
| A7 | Authentication area thin: no magic-link expiry, sessions, sign-out, MFA enrolment, re-authentication, invites, email change, ownership transfer, tenant deletion, terms acceptance. | High | New AUTH-01..08. |
| A8 | No PDPA withdrawal of consent, privacy notice, breach notification or DNC handling. | High | LED-07, LED-08, GOV-10, GOV-14; §5. |
| A9 | No abuse protection: visitor rate limits, bots on the widget, LLM-spend spikes, widget embedded on unlisted sites, crawling sites the tenant does not own. | High | GOV-13, CHN-11, KB-13; D9. |
| A10 | Email channel could loop with auto-responders; custom domains had no SPF/DKIM/DMARC check. | High | CHN-04 modified, CHN-10, NFR-18. |
| A11 | No malware scanning or content-type checks for uploaded files and attachments; visitor attachments were an "(S)" hidden inside a Must requirement. | High | KB-11; CHN-02 split into CHN-09. |
| A12 | Undefined terms used in acceptance criteria: conversation, AI resolution rate, business hours, urgent, quiet hours, evaluation set, fair use; INB-05's "N minutes"; GOV-05's "set SLA". | High | §1.4 additions; INB-05, LED-04, GOV-05 modified; AGT-14, DSH-09. |
| A13 | Evaluation set used by many acceptance criteria was never specified (size, composition, scoring, CI gate). | High | AGT-14. |
| A14 | Conversation lifecycle (auto-close, reopen), takeover concurrency, approval concurrency and expiry not defined. | Medium | INB-08, INB-09, APR-06. |
| A15 | GST: no rule on GST-inclusive price display. | Medium | ONB-03, KB-05 modified; KB-15. |
| A16 | KB-01 default 200 pages conflicted with D2's Starter limit of 100. | Medium | KB-01 modified. |
| A17 | Tracking consent default not set; AGT-05 behaviour without consent not defined. | Medium | CHN-03, AGT-05 modified; D8. |
| A18 | No trial, downgrade, usage-meter or notification-preference rules. | Medium | DSH-07, DSH-08, DSH-09; D10. |
| A19 | Channel credential revocation (Telegram, Meta, email domain) not detected; no "no message lost" rule. | Medium | CHN-12, NFR-17. |
| A20 | NFR gaps: browser support, vulnerability management, ingestion throughput, deliverability, empty/error states, operator response times; RPO ≤ 24 h was looser than the 7-day PITR already promised; NFR-03 concurrency was ambiguous. | Medium | NFR-14..20 added; NFR-01, 03, 04, 08, 11 modified. |
| A21 | Smaller gaps: no harmful-content handling, conversation memory, go-live check, explicit go-live switch, conversation search, duplicate leads, visitor feedback, tenant data export, help/support; Telegram groups; Meta messaging window; open items referenced undefined "Phase 4" and "M0/M4". | Low | AGT-12, AGT-13, AGT-15, ONB-09, ONB-10, INB-11, LED-09, GOV-12, DSH-10, CHN-05, CHN-06, §8. |
