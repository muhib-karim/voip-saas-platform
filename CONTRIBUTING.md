# Contributing to VoIP SaaS Platform

Thank you for your interest in contributing!

## Development Setup

1. Fork and clone the repository
2. Install dependencies from the lockfile: `npm ci` (or `npm ci -w packages/backend -w packages/frontend` to skip the Expo app)
3. Copy `.env.example` to `.env` and configure
4. Start infrastructure: `npm run docker:dev`
5. Run migrations: `npm run db:migrate`
6. Start development: `npm run dev`

## Code Style

- **TypeScript** for the frontend and mobile app; the backend is JavaScript (ES modules)
- **ESLint** for linting: `npm run lint` must pass in every workspace
- Follow existing patterns in codebase

## Tests

- `npm test` runs the backend and frontend suites
- Backend tests that need PostgreSQL run when `TEST_DATABASE_URL` is set and are skipped otherwise. Run them if you touch the wallet, webhooks, billing, auth or migrations:
  `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/voip_saas npm test --workspace=packages/backend`
- A bug fix comes with a test that fails without it
- Phone numbers in tests must come from the ranges reserved for fiction: US `+1 NXX 555 0100`-`0199` and UK `+44 20 7946 0000`-`0999`

## Branch Naming

- `feature/` - New features
- `fix/` - Bug fixes
- `docs/` - Documentation
- `refactor/` - Code refactoring

## Commit Messages

Use conventional commits:
- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation
- `style:` Formatting
- `refactor:` Code refactoring
- `test:` Adding tests
- `chore:` Maintenance

## Pull Requests

1. Create feature branch from `master`
2. Make changes with clear commits
3. Add/update tests as needed
4. Ensure `npm run lint` and `npm test` pass
5. Submit PR with description

CI runs lint, type-check, tests and build, plus `npm audit` (high and above) and a gitleaks secret scan. All of them must pass.

## Project Structure

```
packages/
├── backend/    # Node.js API
├── frontend/   # React web app
└── mobile/     # React Native app
```

## Questions?

Open an issue for discussion.
