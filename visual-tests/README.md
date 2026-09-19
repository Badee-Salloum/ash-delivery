# Visual regression checks

`pnpm exec playwright test` runs deterministic Chromium screenshots of public, credential-free
surfaces only:

- the admin login in Arabic/light and English/dark, the desktop navigation shell, and Treasury
  Movements with rows plus a filtered-empty state;
- driver login and registration at 320px and 390px, across Arabic/English and light/dark, plus an
  authenticated suspended-shift state with its resume alert.

The specs start local Vite servers and intercept every endpoint they exercise with synthetic data.
They never use production URLs, cookies, accounts, or a database. Baselines live beside the specs
under `visual-tests/__screenshots__/` and should be reviewed in a pull request whenever an intended
visual change updates them.

Install Chromium once when it is absent:

```sh
pnpm exec playwright install chromium
```

To intentionally refresh baselines after human review:

```sh
pnpm exec playwright test --update-snapshots
```

Use `ASH_ADMIN_VISUAL_URL` or `ASH_DRIVER_VISUAL_URL` only to point a test at an already-running
local preview; do not point the suite at production.
