# Invoice Studio

Invoice Studio is a React/TypeScript invoice renderer. The standard invoice remains the default. A server-only, preview-only Artisan Barber pipeline can read Toggl Track time entries, reconcile Sunday–Saturday worklogs, and render draft PDFs.

## Local setup

Install dependencies with `npm install`, copy `.env.example` to `.env.local`, and keep the local file uncommitted. `.env.local` is ignored by Git.

For the Artisan integration, set:

```dotenv
TOGGL_API_TOKEN="[your Toggl API token]"
TOGGL_WORKSPACE_ID="[the PRACTICE workspace ID]"
```

Both variables are server-only. Do not rename them with a `VITE_` prefix. The API token is used only to construct Toggl Basic Auth in the Node preview process; it is never logged, placed in an artifact, or sent to browser code.

## Artisan Barber preview

Run fixture tests first:

```sh
npm test
```

Then run the live, read-only pilot explicitly:

```sh
npm run invoice:artisan:preview -- \
  --from 2026-06-28 \
  --through 2026-08-01 \
  --start-number 000702
```

The command uses only read-only Toggl Track API v9 endpoints for workspace validation, project/tag metadata, and the requested time entries. Toggl Pro is not required. It does not mutate Toggl, send email, write to Airtable, finalize invoices, or allocate/consume invoice numbers. The supplied invoice numbers are preview labels only.

Track API v9 is the primary source; the command does not attempt the Pro-only Detailed Reports endpoint first and does not automatically fall back after unrelated errors. If the raw time-entry response reaches Toggl’s 1,000-entry response ceiling, the command fails closed instead of producing potentially incomplete invoices.

Artifacts are written beneath `output/previews/<preview-id>/`, which is ignored by Git:

- `<invoice-number>.preview.pdf` — client-facing draft, generated only when that week has no blockers
- `<invoice-number>.audit.json` — internal reconciliation detail; never embedded in the PDF
- `acquisition-audit.json` — privacy-bounded aggregate counts, relevant Cobalt/Artisan names, and description Unicode diagnostics
- `batch-summary.json` — batch totals and blocker counts

Every weekly PDF is visibly marked `DRAFT · PREVIEW`. Finalization and delivery are intentionally not implemented yet.

## Billing behavior

Toggl timestamps are converted to `America/New_York`. Entries crossing local midnight are split, then grouped by Sunday–Saturday week, local date, and exact Artisan tag. Each grouped cell is rounded once with `Math.round(rawSeconds / 900)`. Currency uses integer cents and weekly time uses integer quarter units.

The acquisition layer canonically treats `Cobalt -- Production`, `Cobalt — Production`, and `Cobalt – Production` as the same exact description. Other descriptions remain nonmatches; no loose substring filter is used. The acquisition audit never includes record IDs, individual durations, notes, unrelated descriptions, or credentials.

Malformed or ambiguous source entries are blockers and are not repaired. A blocked week receives an audit artifact but no PDF. If an entire requested batch contains zero accepted entries, every week receives a batch blocker and the renderer is not started, preventing zero-dollar PDFs.

API implementation follows Toggl’s official [Time entries](https://engineering.toggl.com/docs/track/api/time_entries/), [Projects](https://engineering.toggl.com/docs/track/api/projects/), [Tags](https://engineering.toggl.com/docs/track/api/tags/), and [Authentication](https://engineering.toggl.com/docs/track/authentication/) documentation. The Detailed Reports client remains available as isolated code for diagnostics and tests, but the Artisan preview does not use it.

## Development

```sh
npm run dev
npm test
npm run lint
npm run build
```
