# ADR-006: Claude inference route and processing location (settles D5)

**Status:** Accepted — Q1 decided by the product owner on 2026-10-19 (Bedrock Australia, no automatic Global failover)
**Date:** 2026-10-19
**Requirements addressed:** D5, C2, C4, NFR-07, GOV-07, GOV-11, NFR-04, NFR-01, NFR-17, AGT-01, AGT-02

**Context**
D5 says: store everything in Singapore; allow transient LLM processing outside Singapore under zero-retention terms; and in architecture, prefer a route that processes in Singapore or APAC if one exists for the chosen Claude model, verified against live documentation. We checked the live documentation on 2026-10-19 (sources below). The findings were:

| Route | Where inference runs | Retention | Notes |
|---|---|---|---|
| **Bedrock from ap-southeast-1** | Sonnet 5.5 and Haiku 5.5 are **Global profile only** in Singapore (`global.anthropic.claude-sonnet-5-5`, `global.anthropic.claude-haiku-5-5`). No in-region and no geography profile exists for Singapore. Global destinations are "all commercial Regions". | Bedrock retention mode is configurable per Region; `none` means no request/response data is written to durable storage by AWS or shared with the model provider. | Cheapest Bedrock option (global is ~10% below geographic). |
| **Bedrock from ap-southeast-2, `au.` profile** | `au.anthropic.claude-sonnet-5-5` and `au.anthropic.claude-haiku-5-5` route only to ap-southeast-2 (Sydney) and ap-southeast-4 (Melbourne); the AU profile's source Regions are those two Regions. | As above, with retention mode `none` set in ap-southeast-2 and ap-southeast-4 as applicable. | Geographic profiles carry about a 10% premium over global. The model provider has no access to prompts or completions. |
| **Claude API (first party)** | `inference_geo` accepts only `"global"` (default, any geography) or `"us"` (1.1× price). No APAC value. Workspace data geo is `"us"` only. | Zero data retention available by contract for Opus/Sonnet/Haiku 5.5 (not for Fable models). | Same-day feature parity. Adds Anthropic as a direct sub-processor. |
| **Claude Platform on AWS** | Workspace region does not pin inference; `inference_geo` again only `global`/`us`. | ZDR on request. | Anthropic-operated. |

No route processes Claude Sonnet 5.5 or Haiku 5.5 in Singapore. The only route that keeps processing inside APAC is the Bedrock **`au.` geographic profile**, called from the Sydney Region.

**Decision**
1. **All Claude inference goes through Amazon Bedrock using the `au.` geographic cross-Region inference profiles, invoked against the ap-southeast-2 Bedrock runtime endpoint** from our Singapore workloads (IAM role, SigV4 signing, TLS; AWS documents that cross-Region inference traffic stays on the AWS network). Processing therefore happens only in Sydney or Melbourne, and only transiently.
2. **Bedrock data retention mode is set to `none`** for our accounts in every Region the profile can route to, and **Bedrock model-invocation logging stays off**. Our own logs of prompts and replies live only in ap-southeast-1 (and are PII-masked, ADR-015).
3. **Nothing else leaves Singapore.** Embeddings (ADR-019) run in-region in ap-southeast-1. Uploaded files and transcripts are never sent to Bedrock as stored objects; only the text needed for one call is sent in the request.
4. **Model IDs and the endpoint are configuration**, so moving to an in-region Singapore endpoint, if AWS adds one, is a configuration change with no code change. A quarterly check of the Bedrock model cards is added to the operations runbook.
4a. **Development** may use an Anthropic API key (pay-as-you-go, not a consumer subscription) through the same `llm-gateway` interface, with test data only. Real visitor or tenant data goes only through the production route above.
5. **Failure handling:** calls have a 2 s connect / 20 s total timeout with one retry on a fresh request. If AU inference is unavailable, the visitor gets the NFR-04 fallback ("the team will get back to you" plus lead capture) and the turn is queued for a retry (NFR-17). **By default there is no automatic failover to the Global profile**, because that would send data to Regions outside APAC. The owner may approve a Global failover as a declared, disabled-by-default switch (sign-off Q1).
6. **GOV-07/GOV-11 declaration:** the data-flow PDF lists "Model inference: Amazon Web Services (Amazon Bedrock), Sydney and Melbourne, Australia; transient processing, no retention; purpose: generate replies and extract facts; safeguard: AWS DPA / service terms." The model provider (Anthropic) does not receive the data on this route.
7. Use the Bedrock **runtime** endpoint with the Anthropic Messages request body, implemented as the Bedrock Claude provider of the `llm-gateway` component (ADR-007 decision 5), using the official Anthropic TypeScript Bedrock client (the exact client class is chosen against the SDK docs in detailed design, since AWS's model cards show the Mantle endpoint is not offered for these models outside GovCloud).

**Options considered**
- **Bedrock `au.` profile (chosen)** — meets D5's "APAC if available"; one cloud vendor and one DPA; AWS's zero-operator-access model; retention configurable to `none`. Cons: about 10% more per token than Global; Bedrock can lag the first-party API for beta features (some are "unconfirmed" on Bedrock); requests cross from Singapore to Sydney (roughly 90–100 ms extra round trip, acceptable within NFR-01's 3 s).
- **Bedrock Global from Singapore** — cheapest and simplest. Lost on D5: processing can occur in any commercial Region worldwide, which is the weaker sales and PDPA-transfer story D5 asked us to avoid if possible.
- **Claude API first party** — best feature parity and ZDR by contract. Lost: processing is global or US only, and it adds a second processor and DPA. Kept as the documented fallback if Bedrock's feature lag blocks a Must requirement.
- **Claude Platform on AWS** — Anthropic-operated with AWS billing. Lost for the same reason as the first-party API: inference is not pinned to APAC.

**Consequences**
The DPA can state "stored in Singapore, processed transiently in Australia, never retained". Bedrock quotas in ap-southeast-2 must be raised before pilot (tokens per minute for NFR-03's 1,000 concurrent conversations), and the account needs Bedrock model access for both models there. Prices on Bedrock must be confirmed in the AWS Pricing Calculator; the cost model in ADR-007 assumes the Claude list price plus 10%. Revisit when AWS offers in-region Singapore access for the chosen models, or if Bedrock lacks a feature a Must requirement needs.

**Sources checked 2026-10-19:** AWS Bedrock model cards for Claude Sonnet 5.5 and Haiku 5.5, `inference-profiles-support.html`, `models-region-compatibility.html`, `data-retention.html`, `abuse-detection.html`, `cross-region-inference.html`; Claude docs: `claude-in-amazon-bedrock`, `data-residency`, `api-and-data-retention`, `claude-platform-on-aws`, `pricing`.
