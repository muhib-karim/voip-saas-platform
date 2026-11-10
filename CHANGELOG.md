# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

Production-readiness pass. Run `npm run db:migrate` after updating: there is one new migration.

### Security
- Telnyx webhooks are now authenticated (Ed25519 signature over the raw body, 5-minute timestamp window). Previously any request was accepted.
- Production refuses to start without `JWT_SECRET` and the Stripe/Telnyx settings; the hard-coded fallback JWT secret is gone.
- JWT verification pins HS256, issuer and audience and requires an access-token payload. Existing access tokens stop working on deploy (clients refresh automatically).
- `GET /api/calls/:id` only returns the caller's own calls.
- Refresh-token rotation is atomic, and reuse of a rotated token revokes that session.
- Rate limiting no longer fails open when Redis is unavailable; purchase, search, call setup, refresh and password change now have limits.
- Error responses never include internal error messages.
- The web app no longer keeps the access token in `localStorage`.

### Fixed
- Wallet debits and credits could be lost or double-spent under concurrency.
- A Stripe event delivered more than once credited the wallet each time; unpaid sessions were credited; the credited amount came from metadata.
- `/api/webhooks/telnyx/call`, the URL given to Telnyx for outbound calls, never answered.
- Duplicate `call.hangup` events billed a call twice; unanswered calls were billed; later events reset the call duration; unknown hangup causes returned 500.
- Wallet transactions, call history and all rates endpoints returned 500 on PostgreSQL.
- Buying a number ordered it from Telnyx before checking the balance and never charged for it; two users could buy the same number.
- Calls could be placed with an empty wallet.
- Requests with the wrong JSON types, non-UUID ids or unknown filter values returned 500 instead of 400.
- The production web build shipped a leftover JavaScript copy of the app instead of the TypeScript one; a failed login in the TypeScript app caused an endless stream of refresh requests.
- Mobile: wrong `main` entry, an invalid icon name, and an API URL pointing at a domain outside this project.

### Changed
- A `package-lock.json` is committed; CI installs with `npm ci`.
- Node.js 20 or newer is required.
- Dev tooling: Vite 6 and Vitest 3. Unused dependencies removed (`uuid`, `express-rate-limit`, `nodemon`, `@telnyx/webrtc`, `@stripe/stripe-js`).
- CI gates lint, type-check, tests and build for every workspace, `npm audit` (high and above) for backend and frontend, and a gitleaks scan.
- `JWT_EXPIRES_IN`, `REFRESH_TOKEN_EXPIRES_IN`, `BCRYPT_ROUNDS` and `RATE_LIMIT_*` from `.env.example` are now honoured. New: `TRUST_PROXY`, `MAX_CONCURRENT_CALLS`, `DB_SCHEMA`, `TEST_DATABASE_URL`, `EXPO_PUBLIC_API_URL`. `TELNYX_WEBHOOK_SECRET` was never used and is removed; `TELNYX_PUBLIC_KEY` is what verifies webhooks.

## [1.0.0] - 2025-12-30

### 🎉 Initial Release

Complete VoIP SaaS platform with full-stack implementation.

### Added

#### Backend
- **Authentication System**
  - JWT access tokens (15min) + refresh tokens (7 days)
  - HTTP-only cookie storage for refresh tokens
  - Token rotation on refresh
  - Rate limiting with Redis

- **DID Number Management**
  - Telnyx integration for number search
  - Purchase numbers with wallet deduction
  - Release numbers back to pool
  - Support for 140+ countries

- **Wallet & Payments**
  - Stripe Checkout for top-ups
  - Transaction history tracking
  - Payment method management
  - Webhook handling for payments

- **Calling Rates**
  - Rates lookup by country/number type
  - Redis caching for performance
  - Call cost estimation

- **WebRTC**
  - Telnyx credential generation
  - Call initiation endpoints
  - CDR (Call Detail Records) tracking

#### Web Frontend
- **Design System**
  - Skype-inspired dark theme
  - CSS custom properties
  - Glassmorphism effects
  - Smooth animations

- **UI Components**
  - Button (variants, loading, icons)
  - Input (labels, errors, password toggle)
  - Card (header/content/footer, glass variant)
  - Modal (portal, keyboard handling)
  - Toast (types, auto-dismiss)

- **Pages**
  - Login/Register with animated backgrounds
  - Dashboard with stats and quick actions
  - Numbers with search and purchase flow
  - Wallet with Stripe top-up
  - Calls with history and softphone
  - Settings with profile management

- **Softphone**
  - Dialpad with keyboard support
  - Caller ID selection
  - Call controls (mute, hold, hangup)
  - Duration timer

#### Mobile App (React Native/Expo)
- **Screens**
  - Login/Register with validation
  - Dashboard with stats grid
  - Dialer with haptic feedback
  - Calls history
  - Settings with logout

- **Features**
  - SecureStore for tokens
  - Bottom tab navigation
  - Dark theme matching web

#### Testing
- **Playwright E2E Tests**
  - Authentication flow tests
  - Dashboard and navigation
  - Numbers page interactions
  - Wallet top-up flow
  - Multi-browser support

### Tech Stack
- Backend: Node.js, Express (JavaScript, ES modules)
- Frontend: React, Vite, TypeScript, Zustand
- Mobile: React Native, Expo, TypeScript
- Database: PostgreSQL
- Cache: Redis
- VoIP: Telnyx
- Payments: Stripe
- Testing: Playwright
