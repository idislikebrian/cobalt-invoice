# Invoice Studio

Invoice Studio is Cobalt's invoice rendering system.

It supports two workflows:

1. **Generic invoices** — explicit JSON data → validated React invoice → preview/final PDF.
2. **Artisan Barber invoices** — Toggl Track time entries → weekly reconciliation → frozen preview snapshots → explicitly approved final PDFs.

The system intentionally separates **data acquisition**, **review**, **finalization**, and **delivery**. Generating a final PDF does not send an invoice or update external systems such as Airtable.

## Requirements

- Node.js version specified by `.nvmrc`
- npm
- Playwright Chromium
- Toggl credentials only if using the Artisan Barber workflow

Use the repository's pinned Node version when possible:

```sh
nvm use
npm install
````

If Playwright's Chromium browser is not installed:

```sh
npx playwright install chromium
```

## Local setup

Copy `.env.example` to `.env.local` and keep the local file uncommitted. `.env.local` is ignored by Git.

For the Artisan Barber integration, set:

```dotenv
TOGGL_API_TOKEN="[your Toggl API token]"
TOGGL_WORKSPACE_ID="[the PRACTICE workspace ID]"
```

Both variables are server-only.

Do not rename them with a `VITE_` prefix. The Toggl API token is used only to construct Basic Auth in the Node preview process; it is never logged, placed in an invoice artifact, or sent to browser code.

Real client invoice inputs belong under:

```text
input/invoices/
```

That directory is ignored by Git. Do not commit real client invoice data.

---

## Standard operating workflow

For any invoice:

1. Confirm the invoice number is available.
2. Generate a preview.
3. Review invoice number, client, dates, scope, hours/quantity, rate, discounts, and total.
4. Resolve any blockers or numbering issues.
5. Generate the final PDF explicitly.
6. Preserve the final artifact and its manifest/hash.
7. Update Airtable or other bookkeeping separately.
8. Send the invoice separately.

Never treat preview generation as authorization to send or finalize an invoice.

---

## Generic invoice flow

Use `examples/invoice.example.json` as a sanitized shape reference.

Prepare a real invoice JSON file under `input/invoices/`.

Render a preview:

```sh
npm run invoice:render -- \
  --input input/invoices/example.json \
  --output output/previews/example.preview.pdf \
  --mode preview
```

Inspect the PDF.

Then render the final explicitly:

```sh
npm run invoice:render -- \
  --input input/invoices/example.json \
  --output output/final/example.pdf \
  --mode final
```

The generic flow is:

```text
explicit invoice JSON
→ invoiceSchema validation
→ React/Vite renderer
→ PDF
```

Malformed invoice data is rejected. Existing PDF outputs are not overwritten by default.

### Guarded generic workflow

The shared OpenClaw skill uses the guarded generic workflow instead of choosing
output paths directly. On the canonical installation, run:

```sh
npm run invoice:generic -- inspect --invoice-number 000700 --json
npm run invoice:generic -- validate --input /path/to/candidate.json --json
npm run invoice:generic -- prepare --source /path/to/candidate.json --key client-000700 --json
npm run invoice:generic -- preview --input /srv/cobalt-invoice/runtime/input/invoices/client-000700.json --json
npm run invoice:generic -- finalize --preview-id generic-000700-<hash> --invoice-number 000700 --json
npm run invoice:generic -- report --invoice-number 000700 --json
```

The guarded workflow uses these fixed runtime locations:

```text
/srv/cobalt-invoice/runtime/input/invoices/
/srv/cobalt-invoice/runtime/output/previews/<preview-id>/
/srv/cobalt-invoice/runtime/output/final/<finalization-id>/
/srv/cobalt-invoice/runtime/state/invoice-studio/
```

`inspect`, `validate`, and `report` are read-only. `prepare`, `preview`,
and `finalize` are explicit mutations:

* `prepare` validates a draft and creates a new canonical input without
  overwriting an existing file or reusing an invoice number.
* `preview` freezes the validated draft, renders it through
  `invoice:render --mode preview`, and records source, snapshot, and PDF
  hashes.
* `finalize` requires the exact preview ID and invoice number. It verifies the
  frozen preview and unchanged source, promotes only the frozen snapshot to
  `finalized`, and renders it through `invoice:render --mode final`.
* `report` recomputes the final PDF hash and verifies it against the
  finalization manifest. A single legacy PDF can also be reported, marked as
  unverified by a managed manifest.

Preview and finalization artifacts are content-addressed and committed through
same-filesystem staging directories. A retry of the exact same operation
returns the already verified artifact. Conflicting or malformed state fails
closed.

Finalized snapshots, manifests, and PDFs are read-only. The canonical draft is
left unchanged so a failed final render cannot leave it incorrectly marked
finalized.

Pre-workflow PDFs, such as invoice `000699`, are treated as legacy occupied
numbers. They are not imported into the managed manifest system and can never
be overwritten or reused.

The workflow never sends email, updates Airtable, records payment, or performs
bookkeeping. Those remain separate operations.

---

## Artisan Barber workflow

### 1. Test first

```sh
npm test
```

### 2. Generate previews from Toggl

Example:

```sh
npm run invoice:artisan:preview -- \
  --from 2026-08-02 \
  --through 2026-08-15 \
  --start-number 000708
```

The requested range should normally contain complete Sunday–Saturday billing weeks.

The preview command uses read-only Toggl Track API v9 endpoints for:

* workspace validation
* project metadata
* tag metadata
* requested time entries

Toggl Pro is not required.

The command does **not**:

* mutate Toggl
* send email
* write to Airtable
* finalize invoices
* permanently allocate invoice numbers

The supplied invoice numbers are candidate labels until the resulting preview batch is reviewed and approved.

### 3. Inspect the batch summary

The command prints a weekly summary containing:

* invoice number
* billing period
* raw hours
* billed hours
* subtotal
* discount
* total
* blocker count

Review every week before finalization.

### Zero-dollar weeks

A mixed batch can contain a valid week with zero accepted billable time.

A zero-dollar week should not automatically consume an invoice number just because it appeared in the preview batch.

If a zero-dollar week should not become an invoice:

1. Do not finalize that preview batch as-is.
2. Exclude the empty week.
3. Re-run the billable ranges with the intended contiguous invoice numbers.
4. Confirm the new `preview-manifest.json`.
5. Finalize only the corrected batches.

For example, if three requested weeks produce:

```text
000708 — billable
000709 — $0
000710 — billable
```

and the empty week should not be invoiced, regenerate the last billable week as `000709` rather than manually renaming artifacts.

**Never manually rename frozen invoice JSON, audit files, manifests, or final PDFs to repair numbering. Regenerate the preview instead.**

### 4. Inspect preview artifacts

Artifacts are written beneath:

```text
output/previews/<preview-id>/
```

This directory is ignored by Git.

Each batch may contain:

* `<invoice-number>.preview.pdf` — client-facing draft
* `<invoice-number>.invoice.json` — frozen invoice snapshot used by finalization
* `<invoice-number>.audit.json` — internal reconciliation details
* `acquisition-audit.json` — acquisition diagnostics
* `batch-summary.json` — weekly totals and blocker counts
* `preview-manifest.json` — invoice numbers, snapshot hashes, audit hashes, and totals

Every preview PDF is visibly marked:

```text
DRAFT · PREVIEW
```

Preview mode never suppresses Draft indicators.

Before finalizing, confirm that `preview-manifest.json` contains exactly the invoice numbers and totals you intend to issue.

### 5. Finalize a frozen preview batch

Finalize using the exact reviewed preview directory:

```sh
npm run invoice:artisan:finalize -- \
  --preview-dir output/previews/<preview-id> \
  --invoice-numbers 000708,000709
```

The explicit invoice-number list must match the frozen preview manifest.

Finalization does not contact Toggl.

It validates:

* frozen invoice snapshots
* reconciliation audits
* snapshot hashes
* blocker state
* explicitly confirmed invoice numbers
* duplicate-final protection

Finals are written once beneath:

```text
output/final/<finalization-id>/
```

Each finalization directory contains the final PDFs plus:

```text
finalization-manifest.json
```

The manifest records:

* source preview
* invoice numbers
* invoice snapshot hashes
* audit hashes
* final PDF SHA-256 hashes
* totals
* finalization timestamp

Final directories and PDFs are made read-only.

Existing finalized invoice numbers are never overwritten.

### 6. Delivery and bookkeeping

Invoice Studio currently stops at artifact generation.

It does not automatically:

* email invoices
* mark invoices Sent
* record payment
* upload files to Dropbox
* update Airtable

Those actions must happen separately.

A final PDF means **the artifact is final**, not that the invoice has been issued.

---

## Artisan billing behavior

Toggl timestamps are converted to:

```text
America/New_York
```

Entries crossing local midnight are split before billing calculations.

Entries are then grouped by:

1. Sunday–Saturday billing week
2. local date
3. exact recognized Artisan tag

Each grouped cell is rounded once:

```ts
Math.round(rawSeconds / 900)
```

This rounds to quarter-hour units.

Currency calculations use integer cents. Weekly time calculations use integer quarter units.

The Artisan billing configuration currently uses the established Cobalt/Artisan rate and discount rules encoded by the pipeline.

### Description matching

The acquisition layer canonically treats these as equivalent:

```text
Cobalt -- Production
Cobalt — Production
Cobalt – Production
```

Other descriptions remain nonmatches. No loose substring filtering is used.

The acquisition audit intentionally excludes:

* Toggl record IDs
* individual unrelated durations
* notes
* unrelated descriptions
* credentials

### Blockers

Malformed or ambiguous source entries are blockers and are not automatically repaired.

A blocked week receives an audit artifact but no invoice PDF.

If the entire requested batch contains zero accepted entries, the batch fails closed and the renderer is not started.

If only an individual week is empty while other weeks contain accepted entries, review that week manually and regenerate the desired ranges before finalization if the empty week should not consume an invoice number.

### Toggl API

The implementation follows Toggl's official documentation for:

* [Time entries](https://engineering.toggl.com/docs/track/api/time_entries/)
* [Projects](https://engineering.toggl.com/docs/track/api/projects/)
* [Tags](https://engineering.toggl.com/docs/track/api/tags/)
* [Authentication](https://engineering.toggl.com/docs/track/authentication/)

Track API v9 is the primary acquisition source.

The Artisan preview does not depend on Toggl's Pro-only Detailed Reports endpoint.

If a raw time-entry response reaches Toggl's 1,000-entry response ceiling, acquisition fails closed rather than producing potentially incomplete invoices.

---

## Output safety

These directories contain local operational data and are ignored by Git:

```text
input/invoices/
output/previews/
output/final/
```

Do not commit real invoice inputs, PDFs, Toggl reconciliation data, credentials, or client-specific generated artifacts.

Reusable source code, tests, documentation, and sanitized examples belong in Git.

---

## Development

```sh
npm run dev
npm test
npm run lint
npm run build
```

Before committing reusable changes:

```sh
npm test
npm run lint
npm run build
```