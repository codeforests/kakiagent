# Software Requirements Specification (SRS)
## AI Customer Agent SaaS for Singapore SMEs — MVP

| Field | Value |
|---|---|
| Version | 0.2 (decisions D1–D4 added) |
| Date | 2026-10-18 |
| Status | Awaiting product-owner sign-off |
| Sources | `Singapore SME AI Agent Analysis.docx`, `Singapore SME SaaS PEST Analysis.docx` |

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
**In MVP:** tenant onboarding, KB ingestion and structuring, AI agent, web widget with intent tracking, email channel, Telegram channel, Instagram/Facebook Messenger channel (built in sandbox, going live depends on Meta app review), shared inbox with human takeover, lead capture, approval queue, owner alerts, boundary rules, audit log, PDPA data-subject tooling, analytics, team roles, stubbed plans, EIS report.

**Out of MVP (Phase 2+):** WhatsApp Business API (the channel adapter is designed for it now), agency/reseller console, Stripe billing, appointment booking, order capture and status lookup, Xero/Shopify/HubSpot connectors, Malay/Tamil, native mobile apps, voice.

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

### 1.5 Constraints and assumptions
- C1: TypeScript full stack; hosted on AWS ap-southeast-1 (Singapore). All tenant data is stored in Singapore.
- C2: LLM is the Anthropic Claude API under zero-data-retention terms. Customer data is never used for model training.
- C3: Meta app review is needed before Instagram/Messenger can go live with real customers.
- A1: Pilot tenants are small (1–20 staff), with fewer than 5,000 conversations per month each.
- A2: Tenants are responsible for the accuracy of the source material they upload. The platform flags conflicts but does not verify facts against the outside world.

---

## 2. Stakeholders and users

| Role | Description | Key needs |
|---|---|---|
| **Owner** (tenant) | SME founder or manager. Busy, often on mobile. | Set up fast, trust the bot, approve on the go, see the leads. |
| **Admin** (tenant) | Office manager or marketing staff. | Maintain the KB, configure channels and rules, manage the team. |
| **Agent** (tenant staff) | Sales or service staff. | Take over chats, reply, work through escalations. |
| **Visitor** | Prospective customer of the SME. | Fast, accurate answers in their own language; a human when needed. |
| **Platform Operator** | Us (the SaaS provider). | Tenant support, monitoring, abuse handling. Never reads tenant data casually. |

### 2.1 Role permissions
| Capability | Owner | Admin | Agent |
|---|:-:|:-:|:-:|
| Billing / plan, delete tenant, transfer ownership | ✔ | | |
| Team management | ✔ | ✔ | |
| KB, channels, boundary rules, widget settings | ✔ | ✔ | |
| Approve / reject approvals | ✔ | ✔ | configurable |
| Inbox: view, take over, reply | ✔ | ✔ | ✔ |
| Leads: view / export | ✔ | ✔ | view |
| Audit log, PDPA requests | ✔ | ✔ | |
| Analytics | ✔ | ✔ | own stats |

---

## 3. Functional requirements

Priority uses MoSCoW: **M** = Must, **S** = Should, **C** = Could. Each requirement has an ID for traceability to design and tests.

### 3.1 Account and onboarding (ONB)
| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| ONB-01 | M | Sign up with an email magic link or Google. | A new user can create a tenant and land in the wizard within 1 minute. |
| ONB-02 | M | Guided wizard: business profile → sources → KB review → boundaries → channels → go live. Progress is saved at every step. | The wizard can be left and resumed. Steps after the profile can be skipped and finished later. |
| ONB-03 | M | Business profile: name, UEN (format-validated), industry (picklist), operating hours and public holidays (SG calendar preloaded), contact email/phone, default languages. | Invalid UEN format is rejected. Hours drive the "after-hours" behaviour. |
| ONB-04 | M | "Paste your website URL" as the first and quickest path to a working bot. | For a typical 30-page SME site, a draft KB is ready in ≤ 5 minutes. |
| ONB-05 | M | Test-your-bot playground before going live. | The owner can chat with the draft bot. Each answer shows the KB sources it used. |
| ONB-06 | S | Industry templates (F&B, retail, beauty/wellness, education/tuition, professional services, home services) that preload suggested boundary rules, lead fields and FAQs. | Choosing an industry pre-fills rules and lead form fields, which can be edited. |
| ONB-07 | M | Widget install: copy a one-line snippet; instructions for WordPress, Wix, Shopify and plain HTML; an "install check" that detects the snippet. | The install check turns green once the widget loads on the tenant's domain. |
| ONB-08 | S | Median time from sign-up to going live is ≤ 15 minutes for a website-only tenant. | Measured through product analytics on pilot tenants. |

### 3.2 Knowledge base ingestion and structuring (KB)
| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| KB-01 | M | Website crawl: same domain, respects robots.txt, page limit set by plan (default 200), renders JavaScript pages. | Crawl status and page list are visible. Excluded or failed pages are listed with a reason. |
| KB-02 | M | File upload: PDF, DOCX, PPTX, TXT, images (JPG/PNG, OCR), up to 25 MB each. | Text is extracted, including scanned PDFs through OCR. English and Chinese text supported. |
| KB-03 | M | Spreadsheet upload (CSV/XLSX) with column mapping to Product, Service, Price, Stock and SKU fields; mappings are auto-suggested. | A 500-row price list imports into structured records. The owner confirms or edits the mapping. |
| KB-04 | M | Chat-history import (WhatsApp `.txt` export, Telegram JSON export). Mines question-and-answer pairs from the business's replies. | Mined pairs land in "Suggested FAQs" for owner approval and are never live without review. Visitor personal data in the exports is redacted before storage. |
| KB-05 | M | LLM extraction into typed entities: **Product/Service**, **Price** (amount, currency, unit, validity), **Policy** (refund, delivery, booking, etc.), **FAQ**, **Business hours/location**, **Promotion** (with validity dates). | Every entity links to its source document and location (provenance). |
| KB-06 | M | Conflict detection: the same entity with different values from different sources (such as two prices for one SKU) is flagged and blocked from use until resolved. | Conflicting prices are never quoted. The owner sees a "Resolve" list with both sources side by side. |
| KB-07 | M | KB manager: browse, search, edit, disable and delete entities and documents; manual FAQ entry. | An edit takes effect in agent answers within 60 seconds. |
| KB-08 | S | Freshness: scheduled re-crawl (weekly by default); changed pages are re-extracted; expired promotions are disabled automatically. | Changes since the last crawl are shown as a diff for review. |
| KB-09 | M | Coverage report: lists common customer topics for the industry that the KB cannot yet answer. | Shows the top gaps after go-live, based on escalated or unanswered questions. |
| KB-10 | C | Learn from human replies: when staff answer an escalated question, suggest it as a new FAQ. | Suggestion appears in the KB manager for approval. |

### 3.3 AI agent behaviour (AGT)
| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| AGT-01 | M | Answers only from the tenant's KB and profile (grounded). Each answer stores the IDs of the KB items it used. | On the evaluation set: groundedness ≥ 95%; no answer cites non-existent sources. |
| AGT-02 | M | **Price and fact integrity:** prices, stock, dates and policies in a reply must match a structured KB entity exactly; otherwise the reply is blocked and regenerated or escalated. | 100% price accuracy on the evaluation set. Zero invented prices. |
| AGT-03 | M | Understands English, Singlish (code-switching, particles such as "lah"/"leh"/"can or not", local terms such as "tapau", "chope", HDB, MRT) and Simplified Chinese. Replies in the visitor's language or matches their register. | Intent accuracy ≥ 90% on the Singlish/Chinese evaluation subsets. |
| AGT-04 | M | When confidence is low or the question is out of scope, the agent says it will check with the team, offers handoff or lead capture, and never guesses. | Out-of-scope questions trigger a refusal or escalation ≥ 95% of the time. |
| AGT-05 | M | Uses web context: current page, pages viewed, dwell time and returning-visitor status, to personalise (for example, "I see you're looking at the Premium package"). | Context is passed to the agent and recorded in the audit log. Never reveals tracking details beyond what is on the page. |
| AGT-06 | M | Tools available to the agent: `capture_lead`, `escalate_to_human`, `draft_approval` (quote, discount, custom commitment), `lookup_kb`, `handoff_channel`. No tool may take an irreversible external action without approval. | Tool calls are audited. `draft_approval` never sends to the visitor before approval. |
| AGT-07 | M | Prompt-injection resistance: visitor text and KB content are treated as data; attempts to change the agent's rules, reveal the system prompt or other tenants' data are refused. | Passes the red-team suite (≥ 50 cases) with zero data leaks. |
| AGT-08 | M | Configurable persona: bot name, tone (friendly / professional), greeting, emoji on or off. | Settings are reflected in replies. |
| AGT-09 | M | After hours: tells the visitor when staff will be back, still answers from the KB and captures leads. | Behaviour follows the tenant's hours and SG public holidays. |
| AGT-10 | S | Proactive greeting triggered by intent signals (for example, ≥ 30 seconds on the pricing page, or a second visit). Tenant can configure or turn it off. | Fires at most once per session. Respects "do not disturb" rules. |
| AGT-11 | M | Discloses that it is an AI assistant at the start of a conversation. | Disclosure text appears in the first message and can be edited but not removed. |

### 3.4 Channels (CHN)
| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| CHN-01 | M | Single `ChannelAdapter` abstraction (receive → normalise → agent → send) so new channels, including WhatsApp in Phase 2, plug in without changing the core. | Adding a channel needs only a new adapter module and a config entry. |
| CHN-02 | M | **Web widget:** async snippet, ≤ 30 KB gzipped, no measurable impact on the page's Largest Contentful Paint (LCP); brandable colour, logo and position; mobile responsive; WCAG 2.1 AA; streaming replies; file/image attachments from visitor (S). | Lighthouse performance change ≤ 2 points on the test site. Passes an axe scan. |
| CHN-03 | M | **First-party intent tracking** (inside the widget script): page views, dwell time, scroll depth, UTM parameters, referrer, returning visitor. Uses a first-party ID only and no third-party cookies. A consent mode is available. | Events show in the conversation sidebar. Tracking can be turned off per tenant. |
| CHN-04 | M | **Email channel:** each tenant gets a forwarding address (`<tenant>@in.<domain>`) or connects a custom domain; the agent replies by email in the same thread. | Replies thread correctly in Gmail and Outlook. Attachments are stored. |
| CHN-05 | M | **Telegram:** connect a bot token created with BotFather; supports 1:1 chats. | Messages flow both ways. The owner's alerts can also go to Telegram. |
| CHN-06 | S | **Facebook Messenger and Instagram DM** via the Meta Graph API: connect a Page / IG business account. | Works in Meta sandbox; going live depends on Meta app review. |
| CHN-07 | M | **Channel handoff:** from the widget, the visitor can continue on Telegram or email (deep link or form); the conversation history and context follow. | The new channel's thread is linked to the same Contact and conversation. |
| CHN-08 | M | Contact identity: a single contact record across channels, merged by verified email, phone or Telegram ID; staff can merge manually. | No automatic merge on unverified data. |

### 3.5 Inbox and human handoff (INB)
| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| INB-01 | M | Unified real-time inbox across all channels. Filters: open, escalated, waiting for approval, closed, by channel, by assignee. | New messages appear in ≤ 2 seconds without refreshing. |
| INB-02 | M | Takeover: staff can pause the AI in a conversation and reply directly; hand back to the AI when done. | While a human has taken over, the AI does not send any messages. The visitor sees a "staff joined" notice. |
| INB-03 | M | AI-suggested replies for staff (draft only). | Staff can edit and then send. |
| INB-04 | M | Conversation sidebar: contact info, channel, intent signals, lead status, KB sources used. | Visible for every conversation. |
| INB-05 | M | Escalation routing: round-robin or a specific person; notifies by email/Telegram and web push; reminders if not picked up within N minutes. | Unclaimed escalations trigger reminders until claimed. |
| INB-06 | S | Mobile-first responsive inbox (as a PWA) so owners can reply from their phone. | Usable at 375 px width. |
| INB-07 | S | Internal notes and conversation tags. | Notes are never visible to the visitor. |

### 3.6 Leads and automations (LED)
| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| LED-01 | M | Lead capture: the agent collects tenant-configured fields (name, phone, email, need, budget, preferred time) in conversation. | Captured fields are validated (SG phone format, email). |
| LED-02 | M | **PDPA consent:** before collecting personal data, the agent shows the tenant's purpose statement and gets explicit consent; consent is recorded with a timestamp and the wording used. | No lead is stored without a consent record. |
| LED-03 | M | Lead qualification: score (hot / warm / cold) using tenant-configurable criteria plus intent signals. | Score and reasons are visible on the lead. |
| LED-04 | M | Owner alerts for new hot leads, escalations and pending approvals, by email and Telegram (S: web push). | Alert arrives within 1 minute. Quiet hours are respected, except for items marked urgent. |
| LED-05 | M | Leads list with status pipeline (New → Contacted → Won / Lost) and CSV export. | The export is recorded in the audit log. |
| LED-06 | S | Outbound webhook on lead created/updated (for Zapier/Make/CRMs). | Signed payload; retries with backoff. |

### 3.7 Approvals and boundary rules (APR)
| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| APR-01 | M | Boundary rule configuration: allowed topics, blocked topics, maximum discount (default 0%), whether quotes need approval (default yes), forbidden commitments (delivery guarantees, refunds, legal or medical advice). | Defaults are safe. Changes are recorded in the audit log. |
| APR-02 | M | Approval queue: the AI drafts a quote, discount or commitment → it appears in the queue with the conversation context → Owner/Admin approves, edits and approves, or rejects with a reason → the result is sent to the visitor. | Nothing is sent before a decision. Each decision is audited with the approver and timestamp. |
| APR-03 | M | Approve from mobile through a secure link in the alert (signed, single-use, 24-hour expiry, needs login). | Expired or reused links are rejected. |
| APR-04 | M | While waiting, the agent tells the visitor the team is checking and gives an expected response time. If there is no decision within the SLA, the conversation is escalated. | The SLA can be configured (default 2 business hours). |
| APR-05 | S | Approval analytics: average time to decide, approval rate, most common reasons for edits. | Shown on the analytics page. |

### 3.8 Governance, privacy and audit (GOV)
| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| GOV-01 | M | **Immutable audit log:** append-only, hash-chained entries for agent decisions (summary of reasoning, KB IDs retrieved, tool calls, guardrail results), human actions (takeover, approval, KB and rule edits, exports) and admin events. | Any tampering breaks the hash-chain check. A verification tool is provided. |
| GOV-02 | M | Audit viewer with filters and export (CSV/JSON) for a conversation or a date range. | Export completes for 30 days of data in ≤ 1 minute. |
| GOV-03 | M | **Tenant isolation:** every tenant-scoped row is protected by Postgres row-level security (RLS) in addition to application checks; vector search is always filtered by tenant. | Automated cross-tenant access tests pass in CI. |
| GOV-04 | M | PII handling: detect and mask NRIC/FIN, card numbers and bank accounts in visitor messages before storage and before sending to the LLM; mask other PII in logs. | NRIC/card numbers never appear unmasked in the database or the LLM payload (verified by tests). |
| GOV-05 | M | Data-subject requests (PDPA): find a contact's data across conversations, leads and the KB; export it, correct it, or delete it (including vector chunks and attachments) within a set SLA. | Deletion removes data from primary storage immediately and from backups within the backup retention window. Documented. |
| GOV-06 | M | Retention: tenant-configurable conversation retention (default 24 months); automatic purge job. | Purge is recorded in the audit log. |
| GOV-07 | M | Data-intermediary documentation available in-app: data flows, sub-processors (AWS, Anthropic), zero-retention terms, storage location (SG). | A downloadable Data Processing Agreement (DPA) and data-flow PDF. |
| GOV-08 | M | Kill switch: the owner can pause the AI on all channels instantly (human-only mode). | Takes effect within 5 seconds. |
| GOV-09 | S | Periodic oversight review: a monthly prompt to the owner to review a sample of AI conversations (helps counter automation bias, as the IMDA framework recommends). | Review completion is tracked. |

### 3.9 Dashboard, analytics and plans (DSH)
| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| DSH-01 | M | Home dashboard: conversations, AI resolution rate, escalations, leads (after-hours leads highlighted), pending approvals, KB health. | Data is at most 5 minutes old. |
| DSH-02 | M | Analytics: trends by channel, top questions, unanswered topics, conversion of visitors to leads, response times. | Date-range filter; CSV export. |
| DSH-03 | M | Team management: invite by email, assign role, deactivate. | Deactivated users lose access immediately. |
| DSH-04 | M | **Plan stubs:** Starter / Growth / Pro tiers modelled with limits (channels, KB pages and files, seats unlimited, conversations fair-use). Limits are enforced, with an upgrade prompt; no payment processing. | An operator can change a tenant's plan in the admin console. |
| DSH-05 | S | **EIS-ready expense report:** monthly and annual statement of subscription spend, with the fields an accountant needs for the EIS AI-adoption deduction claim. | PDF/CSV export. Includes a disclaimer that it is not tax advice. |
| DSH-06 | M | Platform operator console: list tenants, change plan, suspend, view health and usage. No access to tenant conversations without a recorded, time-limited "support access" grant from the tenant. | Support access is audited and visible to the tenant. |

---

## 4. Non-functional requirements (NFR)

| ID | Category | Requirement |
|---|---|---|
| NFR-01 | Performance | Agent first token p95 ≤ 3 s; full reply p95 ≤ 8 s; dashboard pages p95 ≤ 1.5 s. |
| NFR-02 | Performance | Widget ≤ 30 KB gzipped initial load; the rest is lazy-loaded; never blocks rendering. |
| NFR-03 | Scalability | MVP target: 200 tenants, 50 concurrent conversations per tenant at peak, 1 million KB chunks in total. Workers scale horizontally. |
| NFR-04 | Availability | 99.5% monthly for the agent and widget API. If the LLM provider is down, fall back to "team will get back to you" plus lead capture. |
| NFR-05 | Security | OWASP ASVS Level 1; TLS 1.2+; encryption at rest (RDS, S3, KMS); secrets in AWS Secrets Manager; MFA available for tenant users and required for operators. |
| NFR-06 | Security | Controls aligned with Cyber Essentials (SG) to prepare for IMDA pre-approval: asset inventory, patching, access control, backups, malware protection. |
| NFR-07 | Privacy | All tenant data and backups stored in ap-southeast-1. LLM calls under zero-retention terms. |
| NFR-08 | Reliability | Daily backups with point-in-time recovery for 7 days; recovery point objective (RPO) ≤ 24 h, recovery time objective (RTO) ≤ 4 h. |
| NFR-09 | Accessibility | WCAG 2.1 AA for the widget and dashboard. |
| NFR-10 | Localisation | UI in English for the MVP (Chinese UI could come later); the agent handles EN/Singlish/Simplified Chinese; SG time zone, SGD currency, SG phone and address formats. |
| NFR-11 | Observability | Structured logs, traces and metrics; per-tenant LLM cost and token tracking; alerts on error rate, latency and job backlog. |
| NFR-12 | Maintainability | Monorepo with CI (lint, typecheck, unit, integration, AI eval); infrastructure as code (Terraform); test coverage ≥ 70% on core packages. |
| NFR-13 | Cost | Average LLM cost per conversation tracked; target ≤ S$0.02 so flat-rate pricing stays viable. |

---

## 5. Compliance traceability

| Obligation (source) | Requirements |
|---|---|
| IMDA Agentic AI v1.5 – defined operational boundaries | APR-01, AGT-06 |
| IMDA Agentic AI v1.5 – human checkpoints for high-stakes or irreversible actions | APR-02–04, INB-02, GOV-08 |
| IMDA Agentic AI v1.5 – logging and audit trails | GOV-01, GOV-02 |
| IMDA Agentic AI v1.5 – agent identity and access limits | AGT-06, GOV-03, DSH-06 |
| IMDA – reducing automation bias | GOV-09, APR-05 |
| IMDA GenAI framework – prompt injection, transparency | AGT-07, AGT-11 |
| PDPA – consent and purpose limitation | LED-02 |
| PDPA – protection obligation | GOV-03, GOV-04, NFR-05 |
| PDPA – access and correction (including vector stores) | GOV-05 |
| PDPA – retention limitation | GOV-06 |
| PDPC GenAI guidelines – data-intermediary documentation | GOV-07 |
| EIS AI-adoption deduction | DSH-05 |

---

## 6. Key user journeys (for E2E acceptance)

1. **J1 Onboard:** The owner of a bakery signs up → enters the website URL → uploads a price-list XLSX and a WhatsApp export → resolves 2 price conflicts → tests the bot in the playground → installs the widget → goes live in under 15 minutes.
2. **J2 Visitor Q&A (Singlish):** A visitor on the cakes page asks "got eggless cake or not? how much ah" → the agent answers with the exact KB price and a source, in a matching register.
3. **J3 Quote approval:** A visitor asks for 200 corporate cupcakes with a discount → the agent captures the lead (with consent) and drafts a quote → the owner gets a Telegram alert → approves an edited quote on their phone → the visitor receives it → every step appears in the audit log.
4. **J4 Takeover:** The visitor asks to speak to a person → escalation → staff take over in the inbox → hand back to the AI.
5. **J5 Channel handoff:** The visitor moves from the widget to Telegram → the history continues.
6. **J6 PDPA deletion:** A contact asks for deletion → the Admin finds and deletes their data across all stores → the action is recorded in the audit log.
7. **J7 Chinese enquiry:** "请问周末营业时间？" (What are your weekend opening hours?) → the agent answers from the hours entity in Chinese.

---

## 7. Decisions (v0.2, 2026-10-18)

| # | Topic | Decision |
|---|---|---|
| D1 | Pilot vertical | **F&B, bakery and catering.** Industry template (ONB-06), evaluation datasets and the J1–J3 journeys use this vertical first. Other templates are "Should". |
| D2 | Plan tiers (stub, DSH-04) | **Starter S$49/mo:** widget + 1 other channel, 100 KB pages, 50 files. **Growth S$129/mo:** all channels, 500 pages, 200 files, proactive greetings. **Pro S$299/mo:** 2,000 pages, 1,000 files, outbound webhooks, priority support. Unlimited seats and AI conversations on every tier (fair use). Meta fees, when relevant, passed through at cost. |
| D3 | Approval rights (APR-02) | Owner/Admin only by default. The Owner can grant approval rights to individual Agents. |
| D4 | Branding | Placeholder codename **"KakiAgent"**, domain `kakiagent.example`. Name and domain come from config so they can be renamed later. |

## 8. Remaining open items
1. Pilot SMEs available for UAT (needed before Phase 4).
2. Meta developer account for Instagram/Messenger sandbox, and AWS + Anthropic accounts (needed in M0/M4).
