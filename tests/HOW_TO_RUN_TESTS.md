# How to Run Playwright E2E Tests

This repo keeps the browser extension test setup self-contained. Tests run in mock mode and do not require Salesforce CLI, Salesforce DX metadata, or a real Salesforce org.

## Prerequisites

- Node.js 20 or higher
- npm
- The `addon/` directory with a valid extension manifest

## Run Tests

Install dependencies and Playwright's Chromium build:

```bash
npm ci
npx playwright install chromium
```

Run the mocked e2e suite:

```bash
npm run test:e2e:mock
```

Run the suite with Playwright UI:

```bash
npm run test:e2e:debug
```

Run a single file:

```bash
npx playwright test tests/e2e/popup.spec.js
```

## Test Constants

`tests/e2e/test-constants.template.js` is copied to `tests/e2e/test-constants.local.js` when needed. The local file is gitignored and defaults to mock mode.

The checked-in tests and mocks provide the Salesforce API responses needed by the extension, so no org metadata deployment is required.

## Troubleshooting

If the extension does not load, check that `addon/manifest.json` exists and that Playwright is launching Chromium with the extension path from `tests/e2e/fixtures.js`.

If tests unexpectedly call a live Salesforce host, confirm `mockEnabled: true` in `tests/e2e/test-constants.local.js` or regenerate it with:

```bash
npm run test:e2e:mock
```
