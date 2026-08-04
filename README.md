# Invoice Studio

Invoice Studio is a React/TypeScript invoice renderer. The standard invoice remains the default. A server-only, preview-only Artisan Barber pipeline can read Toggl detailed reports, reconcile Sunday–Saturday worklogs, and render draft PDFs.

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

The command calls only Toggl’s detailed Reports search endpoint. It does not mutate Toggl, send email, write to Airtable, finalize invoices, or allocate/consume invoice numbers. The supplied invoice numbers are preview labels only.

Artifacts are written beneath `output/previews/<preview-id>/`, which is ignored by Git:

- `<invoice-number>.preview.pdf` — client-facing draft, generated only when that week has no blockers
- `<invoice-number>.audit.json` — internal reconciliation detail; never embedded in the PDF
- `batch-summary.json` — batch totals and blocker counts

Every weekly PDF is visibly marked `DRAFT · PREVIEW`. Finalization and delivery are intentionally not implemented yet.

## Billing behavior

Toggl timestamps are converted to `America/New_York`. Entries crossing local midnight are split, then grouped by Sunday–Saturday week, local date, and exact Artisan tag. Each grouped cell is rounded once with `Math.round(rawSeconds / 900)`. Currency uses integer cents and weekly time uses integer quarter units.

Malformed or ambiguous source entries are blockers and are not repaired. A blocked week receives an audit artifact but no PDF.

API implementation follows Toggl’s official [Detailed reports](https://engineering.toggl.com/docs/track/reports/detailed_reports/) and [Authentication](https://engineering.toggl.com/docs/track/authentication/) documentation.

## Development

```sh
npm run dev
npm test
npm run lint
npm run build
```
