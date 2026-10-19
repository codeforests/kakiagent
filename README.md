# KakiAgent

A multi-tenant AI customer agent for Singapore SMEs: a knowledge base built from the business's own website, files and chats, answering on a web widget (and later email, Telegram and Meta), with human takeover, approvals, PDPA tooling and IMDA-aligned governance.

**Status:** the walking skeleton (FEAT-001). A widget message travels through every runtime role and comes back as an echo, live in the widget and in the dashboard inbox. Features are built next in the order of the [implementation plan](docs/03-planning/implementation-plan.md).

## Quick start

Needs Node 22, pnpm 10 and Docker.

```sh
pnpm install
node scripts/gen-local-env.mjs   # local .env files with random secrets
pnpm stack:up                    # Postgres + pgvector, Valkey, LocalStack, Mailpit
pnpm db:setup                    # roles, migrations, RLS, two dev tenants
pnpm dev
```

Then open the widget host page at http://localhost:5175 and the dashboard at http://localhost:5173/sign-in (sign in as the Kaki Bakery owner). Messages sent in the widget appear in the inbox as they arrive.

`pnpm test:e2e` runs the skeleton end-to-end test against the running stack.

## Where things are

- [AGENTS.md](AGENTS.md): repository layout, every command, conventions and the architecture invariants.
- [docs/](docs/): requirements (SRS, use cases, RTM), architecture and ADRs, UX foundations and the design system, the implementation plan.
- [docs/scaffold-notes.md](docs/scaffold-notes.md): how the skeleton was built, what is stubbed, and what waits for the first deployment.
