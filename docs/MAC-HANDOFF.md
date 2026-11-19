# Continuing development on macOS

This branch records the accumulated source changes after commit `26f25e8` (2 October 2026).
It is a development handoff, not a release tag or permission to deploy the whole branch.
The commits group shared/backend work, web interfaces, native Android changes, and the
selected-branch registration fix. Their dates reflect this handoff; they do not reconstruct
the dates on which individual features were originally developed or published.

## Install and verify

Install Git and Node.js 24, then run:

```sh
git clone --branch codex/mac-handoff https://github.com/Badee-Salloum/ash-delivery.git
cd ash-delivery
npm install -g pnpm@11.3.0
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
pnpm build:apps
```

The branch must first be pushed from the original computer. Do not copy Windows
`node_modules`, generated builds, or Capacitor platform directories to the Mac.
Dependencies must be installed for the Mac's architecture.

## Start without production access

Use three terminals from the repository root:

```sh
# API: development-only memory store; no production credentials or database.
env -u DATABASE_URL NODE_ENV=development OCR_DRIVER=none pnpm --filter @ash/api dev
```

```sh
pnpm --filter @ash/admin dev
```

```sh
pnpm --filter @ash/driver dev
```

Use the addresses Vite prints. The SPAs proxy `/api` to the API on port 3000.
Memory mode does not contain production accounts or records and loses changes on restart.
API tests create synthetic users through `apps/api/test/harness.ts`; browser fixtures intercept
requests locally. A persistent development environment needs its own isolated database and
separately prepared test accounts.

The server does not automatically load a root `.env.local`. If a local environment file is
needed, use Node's `--env-file` explicitly when starting the server. Do not copy production
connection strings into the development startup commands.

## What stays outside Git

- Plaintext environment files, API/session credentials, signing keys, and database backups.
- `outputs/`, `output/`, `tmp/`, and `.release/`: local reports, operational scripts, release
  evidence, and generated bundles. Some contain real business data. Transfer only material
  needed for the next task through a private channel.
- Driver screenshots and other original evidence outside the repository.
- Thread-local visualizations under the original computer's `.codex/visualizations/` directory.

Some historical operational tools live under the excluded directories. They are not application
dependencies. Preserve them privately if needed, inspect them before running, and replace any
Windows-specific absolute paths. Do not execute financial correction, migration, restoration,
or deployment scripts merely to complete the machine setup.

## Production and pending work

The published admin was last verified at deployment
`dpl_6MkmQe7mq1zjo6gVebLorUMrMKPP` for the selected-branch income/advance fix.
That release changed only the admin bundle. The API and Driver were not redeployed for it.
Recheck live deployment state before any future release; this is a dated handoff record.

The working source includes administrative shift-intake changes that previous narrow releases
explicitly excluded. Committing them preserves local work; it does not establish that the
entire source checkpoint matches production or authorizes publishing those changes.

Schema files through `0115` are included as source. Do not automatically apply them to an
existing database: verify its migration history and checksums first. This handoff itself
does not run migrations or change shifts, journals, balances, or subscriptions.

New daily-summary fixtures use anonymous case IDs and synthetic image identifiers while
retaining the numeric regression examples. Real image evidence stays outside Git.

## Handoff validation

`pnpm check` passed on the final source: type checking, repository guards, local OCR
regressions, and 3,935 tests. Forty database integration tests were skipped because no
disposable database was connected. This does not claim a new PostgreSQL integration run.
`pnpm build:apps` also passed for both Driver and Admin. Committed migration files were
compared byte-for-byte with the local SQL files; all 111 matched without rewriting checksums.
Native APK compilation and physical Android device testing were not run during this handoff.

## Android

The separate `android/` package uses its own npm lockfile. Its generated Android platform is
ignored and recreated by the Android workflow. Existing release signing material must be
transferred privately; do not create replacement signing keys for an update to an installed app.
The repository's Android workflow builds on pushes affecting `android/**`; it is distinct
from publishing the web applications.

## Switch between computers

Commit and push before leaving one machine. On the other machine, start with:

```sh
git status
git pull --ff-only
pnpm install --frozen-lockfile
```

Keep unrelated work on separate branches. Review and test the intended release scope before
merging or deploying. This task creates local commits only; pushing is a separate action.
