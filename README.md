<p align="center">
  <img src="docs/banner.svg" alt="VoIP SaaS Platform" width="100%">
</p>

<p align="center"><b>Browser softphone, phone numbers &amp; prepaid billing: a full-stack VoIP SaaS reference implementation.</b></p>

<p align="center">
  <a href="https://github.com/muhib-karim/voip-saas-platform/actions/workflows/ci.yml"><img src="https://github.com/muhib-karim/voip-saas-platform/actions/workflows/ci.yml/badge.svg?branch=master" alt="CI"></a>
  <a href="https://github.com/muhib-karim/voip-saas-platform/actions/workflows/security.yml"><img src="https://github.com/muhib-karim/voip-saas-platform/actions/workflows/security.yml/badge.svg?branch=master" alt="Security"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/muhib-karim/voip-saas-platform" alt="License"></a>
  <img src="https://img.shields.io/github/languages/top/muhib-karim/voip-saas-platform" alt="Top language">
</p>

---

## What it is

A **reference implementation** of a Skype-style VoIP SaaS: users sign up, buy virtual phone numbers (DIDs), top up a prepaid wallet with Stripe, and place calls from a web softphone. Telephony goes through the [Telnyx](https://telnyx.com) API.

It's an npm-workspaces monorepo with three apps:

| Package | Stack | What's in it |
|---|---|---|
| `packages/backend` | Node.js, Express, Knex, PostgreSQL, Redis | REST API, 6 route modules (30 endpoints plus `/health`), Telnyx and Stripe integrations, 3 Knex migrations (11 tables) |
| `packages/frontend` | React 18, Vite, TypeScript, Zustand | Dashboard, Numbers, Wallet, Calls, Settings, Login/Register, dialpad softphone |
| `packages/mobile` | React Native, Expo | 6 screens (login, register, dashboard, dialer, calls, settings) |

> **Status: reference implementation, not a hosted product.** There is no public demo. Running it end-to-end needs your own Telnyx and Stripe accounts plus PostgreSQL and Redis. The automated tests cover the HTTP layer offline and the wallet, webhook, billing and token logic against a real PostgreSQL; nothing is tested against the live Telnyx or Stripe APIs. See [Limitations](#limitations).

## Key features (as implemented)

- **Auth:** registration and login with bcrypt-hashed passwords. You get a 15-minute HS256 access token (algorithm, issuer and audience are pinned on verification) and a 7-day refresh token in an HTTP-only, `SameSite=Strict` cookie. Refresh tokens are stored hashed (SHA-256) and rotated on every use; presenting a token that was already rotated revokes that whole session. Sessions can be listed and revoked.
- **Phone numbers:** search available Telnyx numbers by country, area code and type (local / toll-free / mobile), then buy them or release them. Buying reserves the number and charges setup plus the first month in one transaction before Telnyx is contacted, and refunds if the order fails.
- **Wallet and payments:** prepaid balance, Stripe Checkout top-ups ($5 to $1,000), transaction history, saved cards. Balance changes are single atomic SQL statements, so concurrent requests cannot double-spend. Stripe webhooks are checked against their signature, credited from the amount Stripe collected, and credited once however often the event is delivered.
- **Calling:** outbound calls go through Telnyx Call Control after the backend checks that the user owns the caller ID, has balance for at least a minute, and has fewer than `MAX_CONCURRENT_CALLS` calls open. Telnyx is told to end the call when the balance would run out. It can also issue Telnyx WebRTC credentials (`GET /api/calls/token`).
- **Call detail records:** Telnyx call webhooks must carry a valid Ed25519 signature and a recent timestamp. They update a `cdr` table and tolerate duplicated and out-of-order delivery; an answered call is billed exactly once, from the event timestamps. There are history and stats endpoints, scoped to the caller.
- **Rates:** a per-country rate table with Redis caching and a call-cost estimator.
- **Hardening:** helmet headers, CORS limited to the frontend origin, a 10 kB JSON body limit, rate limiting backed by Redis with a per-process fallback (stricter limits on login, register, password change, purchases and call setup), request validation on every route that takes input, and error responses that never include internal messages. In production the server refuses to start without its secrets.

## Demo

There's no hosted demo. This is real output from the backend test suite (abridged and re-rendered as SVG; per-test timings removed):

<p align="center"><img src="docs/test-run.svg" alt="Backend test run: 200 tests passing" width="820"></p>

## Quick start

**Prerequisites:** Node.js 20+ (CI uses 22), PostgreSQL 15 and Redis 7. You can run both with `docker-compose up -d postgres redis`. For calls and payments you also need Telnyx and Stripe credentials.

```bash
git clone https://github.com/muhib-karim/voip-saas-platform.git
cd voip-saas-platform

# Install the backend + web frontend from the lockfile (the Expo app is installed separately)
npm ci -w packages/backend -w packages/frontend

cp .env.example .env          # then fill in Telnyx / Stripe keys and a strong JWT_SECRET
npm run db:migrate            # creates the schema in PostgreSQL
npm run dev                   # backend on :5000, Vite dev server on :3000 (proxies /api)
```

With `NODE_ENV=production` the backend will not start unless `JWT_SECRET` (32+ characters, not a placeholder), `DATABASE_URL`, the Stripe and Telnyx settings and https `FRONTEND_URL` / `BACKEND_URL` are all set. `.env.example` lists every variable.

Mobile app (optional): `npm ci -w packages/mobile`, set `EXPO_PUBLIC_API_URL` to your backend (including `/api`), then `npm run dev:mobile`.

## Usage

```bash
# Health check
curl http://localhost:5000/health

# Register, then use the returned accessToken
curl -X POST http://localhost:5000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"a-long-password","firstName":"Ada","lastName":"Lovelace"}'

# Estimate a 3-minute call to the UK
curl -X POST http://localhost:5000/api/rates/estimate \
  -H 'Content-Type: application/json' -d '{"countryCode":"GB","duration":3}'
```

### API overview

| Area | Endpoints |
|---|---|
| Auth `/api/auth` | `POST /register`, `POST /login`, `POST /refresh`, `POST /logout`, `POST /logout-all`, `GET /me`, `PATCH /profile`, `POST /change-password`, `GET /sessions`, `DELETE /sessions/:id` |
| Numbers `/api/numbers` | `GET /`, `GET /search`, `POST /purchase`, `DELETE /:id` |
| Wallet `/api/wallet` | `GET /`, `POST /topup`, `GET /transactions`, `GET /payment-methods`, `POST /setup-payment` |
| Calls `/api/calls` | `GET /token`, `POST /`, `GET /history`, `GET /stats`, `GET /:id` |
| Rates `/api/rates` | `GET /`, `GET /:countryCode`, `POST /estimate` |
| Webhooks `/api/webhooks` | `POST /stripe`, `POST /telnyx`, `POST /telnyx/call` |

## Architecture

```mermaid
flowchart LR
    subgraph Clients
        W["Web app<br/>React + Vite + Zustand"]
        M["Mobile app<br/>React Native / Expo"]
    end

    subgraph API["Backend (Express)"]
        MW["helmet · CORS · rate limiter<br/>JWT auth · validation"]
        R["Routes<br/>auth · numbers · wallet · calls · rates · webhooks"]
        S["Services<br/>auth · telnyx · billing · wallet · cdr · rates"]
        MW --> R --> S
    end

    W -->|REST /api| MW
    M -->|REST /api| MW
    S --> PG[("PostgreSQL<br/>Knex migrations")]
    S --> RD[("Redis<br/>rate limits · rate cache")]
    S -->|numbers · calls · WebRTC creds| TX["Telnyx API"]
    S -->|Checkout · cards| ST["Stripe API"]
    TX -->|call webhooks → CDR| R
    ST -->|signed webhooks → wallet credit| R
```

`src/app.js` builds the Express app and `src/index.js` connects Redis and starts the server. Keeping them apart lets the tests load the app without opening a port.

## Testing

```bash
npm ci                                            # all workspaces, from the lockfile

npm test                                          # backend + frontend
npm run lint                                      # ESLint in all three workspaces
npm run type-check --workspace=packages/frontend  # tsc --noEmit
npm run build                                     # production Vite build
```

**Backend: 200 tests** (node:test + supertest).

- 109 run offline with no services: both validation middlewares, the JWT guard (wrong algorithm, wrong issuer or audience, missing claims, expired), production config validation, the error handler, the rate limiter without Redis, Telnyx and Stripe signature checks, and input that used to crash handlers.
- 91 need PostgreSQL and run when `TEST_DATABASE_URL` is set; otherwise they are reported as skipped. They cover wallet concurrency, Stripe redelivery, call billing under duplicated and out-of-order Telnyx events, refresh-token rotation and reuse, access control between users, the list and rates endpoints, number purchase, and the migration itself (up, down, and against legacy duplicate rows).

```bash
docker-compose up -d postgres
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/voip_saas npm test --workspace=packages/backend
```

Each DB test file creates its own schema and drops it afterwards, so pointing this at a development database does not touch your data.

**Frontend: 26 tests** (Vitest): the API client's 401 and refresh handling, the auth store (the access token is never written to storage), a guard against a second copy of the app shadowing the TypeScript sources, and the Button component.

[CI](.github/workflows/ci.yml) runs lint, type-check, tests and build for every workspace on each push and pull request, with a PostgreSQL service for the backend, where a skipped DB test is a failure. [Security](.github/workflows/security.yml) runs `npm audit --audit-level=high` for the backend and frontend and a gitleaks scan of the full history, on every push and pull request and weekly.

`tests/e2e/` holds Playwright specs (`npm run test:e2e`). They need the full stack running and aren't part of CI.

Test data only uses phone numbers reserved for fiction (US 555-0100 to 555-0199, UK 020 7946 0000 to 0999); a test enforces this.

## Project structure

```
.
├── packages/
│   ├── backend/
│   │   ├── src/
│   │   │   ├── app.js           # Express app (middleware + routes)
│   │   │   ├── index.js         # server bootstrap, Redis init, graceful shutdown
│   │   │   ├── config/          # env config, Knex, Redis cache wrapper
│   │   │   ├── middleware/      # auth, validation, rate limiting, error handler
│   │   │   ├── utils/           # HTTP errors, input validators
│   │   │   ├── routes/          # auth, numbers, wallet, calls, rates, webhooks
│   │   │   └── services/        # auth, telnyx, billing (Stripe), wallet, cdr, rates
│   │   ├── migrations/          # Knex schema migrations
│   │   └── test/                # node:test unit + HTTP tests; test/db/ needs PostgreSQL
│   ├── frontend/src/            # React app: pages/, components/, store/, services/
│   └── mobile/src/              # Expo app: screens/, store/, services/
├── tests/e2e/                   # Playwright specs
├── deploy/                      # Kubernetes manifest + deploy script (templates)
├── docker-compose.yml           # Postgres, Redis, backend, frontend for local dev
└── .github/workflows/           # ci.yml (lint/type-check/test/build), security.yml (npm audit, gitleaks), ci-cd.yml (Docker images)
```

## Limitations

- **The browser doesn't carry call audio.** The web softphone places calls through the backend (Telnyx Call Control) and keeps call state in the browser. The backend issues WebRTC tokens, but no in-browser media session is wired up. Mute, hold and DTMF only change local UI state, and there's no hangup endpoint on the backend yet.
- **Without Redis, rate limits are per process.** If Redis is down the limits are still enforced, but each server process counts on its own, so with several replicas the effective limit is multiplied.
- **Live Stripe and Telnyx are not integration-tested.** Webhooks are tested with correctly signed fixtures and API calls are stubbed; none of it runs against the real services.
- **Calls are billed at a flat $0.01 per started minute.** The rates table feeds the estimator only. A wallet can go slightly negative when a call outlasts its balance or several calls run at once; new calls are refused until it is topped up.
- **Stripe refunds and disputes are not handled.** A refunded top-up is not taken back out of the wallet.
- **Number purchase is not fully automatic to reconcile.** A number is reserved as `pending` before Telnyx is called. If the process dies between the order and the final update, the row stays `pending` with the charge applied and has to be resolved by hand. Releasing a number marks it released even if Telnyx's delete call fails. There is no recurring monthly billing.
- **The mobile app is linted and type-checked in CI but not built.** It has no token refresh, so a session ends when the 15-minute access token expires, and the `assets/` images referenced by `app.json` are not in the repo.
- **The frontend Docker image runs the Vite dev server.** It is fine for `docker-compose.yml`; `docker-compose.prod.yml` and the Kubernetes manifest need a static build behind a web server before real use.
- **`ci-cd.yml` only triggers on `main`/`develop`.** The default branch is `master`, so the Docker image workflow is effectively dormant.

## Known advisories

`npm audit --audit-level=high` is clean for the backend and the frontend, including development dependencies, and CI fails if that changes. What remains is below the gate or outside it:

| Where | Advisory | Why it is still here |
|---|---|---|
| backend | `uuid` < 11.1.1 via `telnyx` 1.x (moderate) | The fix is `telnyx` 7, a major rewrite of the SDK. |
| frontend | `react-router` 6 (moderate) | The fix is v7. The advisories concern SSR hydration and navigation to attacker-controlled targets; this app is a client-only SPA with static routes. |
| frontend (dev) | `minimatch` via `@typescript-eslint` 6, `vitest` 3 (moderate) | Clearing them needs `@typescript-eslint` 8 and `vitest` 4; the latter does not currently resolve in this workspace. |
| mobile | 1 critical, 20 high, 22 moderate in the Expo 50 / React Native 0.73 tree | Every one needs an Expo, React Native or React Navigation major upgrade. The mobile audit runs in CI as a report, not a gate. |

Two `overrides` in the root `package.json` pin patched transitive versions (`minimatch` under `@typescript-eslint`, `tinypool` under `vitest`); remove them when those tools are upgraded.

## Tech stack

- **Language:** JavaScript
- **Frameworks and tools:** Playwright, Express, PostgreSQL, Stripe, React, Vite, TypeScript, Vitest, React Native, Docker
- **CI:** GitHub Actions

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow. Before opening a pull request, run `npm test` and `npm run lint` (and the backend tests with `TEST_DATABASE_URL` set if you touched the wallet, webhooks, billing or auth). Please keep each pull request focused and say how you tested it.

## License

[MIT](LICENSE) © 2026 Muhib Al Karim
