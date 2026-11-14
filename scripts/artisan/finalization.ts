import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import {
  ADJUSTMENT_FILE_NAME,
  adjustmentAudits,
  artisanAdjustmentFileSchema,
  artisanAdjustmentSchema,
  presentedWorklogCells,
} from '../../src/artisan/adjustments.ts'
import {
  calculateDiscount,
  calculateSubtotal,
  calculateTotal,
} from '../../src/invoice/calculations.ts'
import { invoiceSchema, type InvoiceData } from '../../src/invoice/schema.ts'
import type { WeeklyAudit } from '../../src/artisan/types.ts'

const reviewMessageSchema = z.object({
  code: z.string(),
  entryId: z.string().nullable(),
  message: z.string(),
})

const weeklyAuditSchema = z.object({
  invoiceNumber: z.string(),
  billingPeriod: z.object({ from: z.iso.date(), through: z.iso.date() }),
  sourceTogglEntryIds: z.array(z.string()),
  entries: z.array(z.object({
    id: z.string(),
    originalStart: z.string().nullable(),
    originalStop: z.string().nullable(),
    localDates: z.array(z.string()),
    project: z.string().nullable(),
    description: z.string().nullable(),
    tags: z.array(z.string()),
    rawSeconds: z.number().nullable(),
    boundarySplits: z.array(z.object({
      localDate: z.string(),
      weekStart: z.string(),
      start: z.string(),
      stop: z.string(),
      rawSeconds: z.number(),
    })),
  })),
  groupedCells: z.array(z.object({
    date: z.string(),
    category: z.enum(['ADMIN', 'DESIGN', 'DEV', 'MEETINGS', 'VIDEO']),
    rawSeconds: z.number(),
    roundedQuarterUnits: z.number().int().nonnegative(),
    roundedDecimalHours: z.string(),
  })),
  weeklyRawDurationSeconds: z.number(),
  weeklyBilledDurationSeconds: z.number(),
  weeklyBilledQuarterUnits: z.number().int().nonnegative(),
  standardRateSubtotalCents: z.number().int().nonnegative(),
  discountCents: z.number().int().nonnegative(),
  finalTotalCents: z.number().int().nonnegative(),
  blockers: z.array(reviewMessageSchema),
  warnings: z.array(reviewMessageSchema),
  documentDates: z.object({
    billingPeriod: z.object({ from: z.iso.date(), through: z.iso.date() }),
    documentDate: z.iso.date(),
    dueDate: z.iso.date(),
    documentDateBasis: z.string().min(1),
    previewGeneratedOn: z.iso.date().nullable(),
    notIssuanceEvidence: z.literal(true),
  }).optional(),
  manualAdjustments: z.array(artisanAdjustmentSchema.extend({
    unitPriceCents: z.number().int().positive(),
    standardRateAmountCents: z.number().int().positive(),
  })).optional(),
  adjustmentSource: z.object({
    file: z.string().regex(ADJUSTMENT_FILE_NAME),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).optional(),
  adjustmentQuarterUnits: z.number().int().positive().optional(),
  invoiceBilledQuarterUnits: z.number().int().nonnegative().optional(),
})

const sourceRecordSchema = z.object({
  invoiceNumber: z.string(),
  invoiceFile: z.string(),
  invoiceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  auditFile: z.string(),
  auditSha256: z.string().regex(/^[a-f0-9]{64}$/),
  totalCents: z.number().int().nonnegative(),
})

export const previewManifestSchema = z.object({
  version: z.literal(1),
  previewId: z.string().min(1),
  createdAt: z.iso.datetime(),
  invoiceNumbers: z.array(z.string()),
  sources: z.array(sourceRecordSchema),
  /** Frozen reference to the manually approved adjustment input, when used. */
  adjustments: z.object({
    invoiceNumber: z.string().regex(/^\d{6}$/),
    file: z.string().regex(ADJUSTMENT_FILE_NAME),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).optional(),
})

export type PreviewManifest = z.infer<typeof previewManifestSchema>

export interface ValidatedFinalizationSource {
  invoiceNumber: string
  invoice: InvoiceData
  audit: WeeklyAudit
  invoiceSha256: string
  auditSha256: string
  totalCents: number
  manualAdjustmentIds: string[]
}

/** Canonical directory for manually approved Artisan adjustment inputs. */
export function defaultAdjustmentsRoot(): string {
  const runtimeRoot = process.env.INVOICE_STUDIO_RUNTIME_ROOT ?? '/srv/cobalt-invoice/runtime'
  return path.resolve(runtimeRoot, 'input', 'artisan-adjustments')
}

/** The fields of a finalization manifest that the exactly-once guard relies on. */
const finalizationAdjustmentRecordSchema = z.object({
  version: z.literal(1),
  manualAdjustments: z.array(z.object({ ids: z.array(z.string().min(1)).min(1) })).optional(),
})

/**
 * Collect every manual adjustment id already consumed by a finalized batch,
 * mapped to the final directory that consumed it. An id may be finalized once.
 *
 * Fails closed: each directory in the final root is a finalization record and
 * must contain a readable, well-formed finalization-manifest.json. Only loose
 * regular files (legacy PDFs predating managed finalization) are skipped.
 */
export async function finalizedAdjustmentIds(finalRoot: string): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  let entries
  try {
    entries = await readdir(finalRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return found
    throw error
  }
  for (const entry of entries) {
    if (entry.isFile()) continue
    if (!entry.isDirectory()) {
      throw new Error(`Unexpected non-directory entry ${entry.name} in final root; cannot verify adjustment usage`)
    }
    let raw: string
    try {
      raw = await readFile(path.join(finalRoot, entry.name, 'finalization-manifest.json'), 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      throw new Error(
        code === 'ENOENT'
          ? `Final directory ${entry.name} has no finalization manifest; cannot verify adjustment usage`
          : `Finalization manifest in ${entry.name} is unreadable; cannot verify adjustment usage`,
        { cause: error },
      )
    }
    let manifest: unknown
    try {
      manifest = JSON.parse(raw)
    } catch {
      throw new Error(`Finalization manifest in ${entry.name} is not valid JSON; cannot verify adjustment usage`)
    }
    const record = finalizationAdjustmentRecordSchema.safeParse(manifest)
    if (!record.success) {
      throw new Error(`Malformed finalization manifest in ${entry.name}; cannot verify adjustment usage`)
    }
    for (const { ids } of record.data.manualAdjustments ?? []) {
      for (const id of ids) found.set(id, entry.name)
    }
  }
  return found
}

async function verifyAdjustments(options: {
  manifest: PreviewManifest
  invoiceNumber: string
  invoice: InvoiceData
  audit: z.infer<typeof weeklyAuditSchema>
  adjustmentsRoot: string | undefined
  consumed: Map<string, string>
}): Promise<string[]> {
  const { manifest, invoiceNumber, invoice, audit } = options
  const declared = manifest.adjustments?.invoiceNumber === invoiceNumber ? manifest.adjustments : undefined
  if (!declared) {
    if (
      audit.manualAdjustments !== undefined ||
      audit.adjustmentSource !== undefined ||
      audit.adjustmentQuarterUnits !== undefined ||
      audit.invoiceBilledQuarterUnits !== undefined ||
      audit.documentDates !== undefined
    ) {
      throw new Error(`Invoice ${invoiceNumber} contains adjustment data that its preview manifest does not declare`)
    }
    return []
  }
  if (manifest.invoiceNumbers.length !== 1) {
    throw new Error('Adjusted previews must contain exactly one invoice')
  }
  if (!options.adjustmentsRoot) throw new Error('An adjustments root is required to finalize an adjusted invoice')
  const sourcePath = safeArtifactPath(path.resolve(options.adjustmentsRoot), declared.file)
  let raw: string
  try {
    raw = await readFile(sourcePath, 'utf8')
  } catch {
    throw new Error(`Adjustment source for invoice ${invoiceNumber} is missing`)
  }
  if (sha256(raw) !== declared.sha256) {
    throw new Error(`Adjustment source changed after preview for invoice ${invoiceNumber}`)
  }
  const parsed = artisanAdjustmentFileSchema.safeParse(parseJson(raw, 'Adjustment source'))
  if (!parsed.success) throw new Error(`Adjustment source is malformed for invoice ${invoiceNumber}`)
  const file = parsed.data
  const ids = file.adjustments.map(({ id }) => id)
  if (new Set(ids).size !== ids.length) throw new Error(`Adjustment source has duplicate ids for invoice ${invoiceNumber}`)
  const adjustmentQuarterUnits = file.adjustments.reduce((sum, adjustment) => sum + adjustment.quarterUnits, 0)
  if (
    file.invoiceNumber !== invoiceNumber ||
    !isDeepStrictEqual(file.billingPeriod, audit.billingPeriod) ||
    !isDeepStrictEqual(audit.adjustmentSource, { file: declared.file, sha256: declared.sha256 }) ||
    !isDeepStrictEqual(audit.manualAdjustments, adjustmentAudits(file.adjustments)) ||
    // Client-facing presentation must be exactly Toggl evidence + frozen adjustments.
    invoice.lineItems[0]?.quantityQuarterUnits !== audit.weeklyBilledQuarterUnits + adjustmentQuarterUnits ||
    !isDeepStrictEqual(
      invoice.weeklyTimeWorklog?.cells,
      presentedWorklogCells(
        audit.groupedCells.map(({ date, category, roundedQuarterUnits }) => ({ date, category, roundedQuarterUnits })),
        file.adjustments,
      ),
    ) ||
    audit.groupedCells.reduce((sum, cell) => sum + cell.roundedQuarterUnits, 0) !== audit.weeklyBilledQuarterUnits ||
    audit.adjustmentQuarterUnits !== adjustmentQuarterUnits ||
    audit.invoiceBilledQuarterUnits !== audit.weeklyBilledQuarterUnits + adjustmentQuarterUnits ||
    audit.documentDates === undefined ||
    !isDeepStrictEqual(audit.documentDates.billingPeriod, audit.billingPeriod) ||
    audit.documentDates.documentDate !== invoice.issueDate ||
    audit.documentDates.dueDate !== invoice.dueDate
  ) {
    throw new Error(`Invoice adjustment data differs from its frozen adjustment source for ${invoiceNumber}`)
  }
  for (const id of ids) {
    const consumedBy = options.consumed.get(id)
    if (consumedBy) throw new Error(`Adjustment ${id} was already finalized in ${consumedBy}`)
  }
  return ids
}

export function jsonArtifact(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`${label} is missing or malformed`)
  }
}

function safeArtifactPath(directory: string, fileName: string): string {
  if (path.basename(fileName) !== fileName) {
    throw new Error(`Unsafe artifact filename: ${fileName}`)
  }
  return path.join(directory, fileName)
}

async function existingFinalNumbers(finalRoot: string): Promise<Set<string>> {
  const found = new Set<string>()
  try {
    for (const entry of await readdir(finalRoot, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) {
        const managed = /^(\d{6})\.pdf$/.exec(entry.name)
        const legacy = /^\d{8}-(\d{6})--[^/]+\.pdf$/.exec(entry.name)
        if (managed || legacy) found.add((managed ?? legacy)![1])
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return found
}

export function assertExplicitInvoiceNumbers(invoiceNumbers: string[], previewInvoiceNumbers: string[]): void {
  if (
    invoiceNumbers.length !== previewInvoiceNumbers.length ||
    invoiceNumbers.some((value, index) => value !== previewInvoiceNumbers[index])
  ) {
    throw new Error(`Explicitly confirm invoice numbers in this order: ${previewInvoiceNumbers.join(',')}`)
  }
}

export async function validateFinalizationSource(options: {
  previewDirectory: string
  invoiceNumbers: string[]
  finalRoot: string
  adjustmentsRoot?: string
}): Promise<{ manifest: PreviewManifest; sources: ValidatedFinalizationSource[] }> {
  const previewDirectory = path.resolve(options.previewDirectory)
  try {
    if (!(await stat(previewDirectory)).isDirectory()) throw new Error()
  } catch {
    throw new Error(`Preview directory is missing: ${previewDirectory}`)
  }

  let manifestRaw: string
  try {
    manifestRaw = await readFile(path.join(previewDirectory, 'preview-manifest.json'), 'utf8')
  } catch {
    throw new Error('preview-manifest.json is missing or malformed')
  }
  const manifestResult = previewManifestSchema.safeParse(parseJson(manifestRaw, 'preview-manifest.json'))
  if (!manifestResult.success) throw new Error('preview-manifest.json is missing or malformed')
  const manifest = manifestResult.data
  assertExplicitInvoiceNumbers(options.invoiceNumbers, manifest.invoiceNumbers)

  const duplicateNumbers = await existingFinalNumbers(path.resolve(options.finalRoot))
  const duplicate = options.invoiceNumbers.find((number) => duplicateNumbers.has(number))
  if (duplicate) throw new Error(`Final PDF already exists for invoice ${duplicate}`)
  if (manifest.adjustments && !manifest.invoiceNumbers.includes(manifest.adjustments.invoiceNumber)) {
    throw new Error('Preview manifest declares adjustments for an invoice outside its invoice set')
  }
  // The exactly-once scan only gates adjusted batches, so unadjusted finalization is unchanged.
  const consumed = manifest.adjustments
    ? await finalizedAdjustmentIds(path.resolve(options.finalRoot))
    : new Map<string, string>()

  const sources: ValidatedFinalizationSource[] = []
  for (const invoiceNumber of options.invoiceNumbers) {
    const record = manifest.sources.find((source) => source.invoiceNumber === invoiceNumber)
    if (!record) throw new Error(`Expected invoice ${invoiceNumber} is absent from preview artifacts`)

    let invoiceRaw: string
    let auditRaw: string
    try {
      [invoiceRaw, auditRaw] = await Promise.all([
        readFile(safeArtifactPath(previewDirectory, record.invoiceFile), 'utf8'),
        readFile(safeArtifactPath(previewDirectory, record.auditFile), 'utf8'),
      ])
    } catch {
      throw new Error(`Required snapshot or audit artifact is missing for invoice ${invoiceNumber}`)
    }
    if (sha256(invoiceRaw) !== record.invoiceSha256) {
      throw new Error(`Invoice data differs from its recorded preview snapshot for ${invoiceNumber}`)
    }
    if (sha256(auditRaw) !== record.auditSha256) {
      throw new Error(`Audit data differs from its recorded preview snapshot for ${invoiceNumber}`)
    }

    const invoiceResult = invoiceSchema.safeParse(parseJson(invoiceRaw, `${invoiceNumber} invoice snapshot`))
    const auditResult = weeklyAuditSchema.safeParse(parseJson(auditRaw, `${invoiceNumber} audit`))
    if (!invoiceResult.success || !auditResult.success) {
      throw new Error(`Snapshot or audit artifact is malformed for invoice ${invoiceNumber}`)
    }
    const invoice = invoiceResult.data
    const audit = auditResult.data as WeeklyAudit
    if (invoice.invoiceNumber !== invoiceNumber || audit.invoiceNumber !== invoiceNumber) {
      throw new Error(`Invoice number mismatch in artifacts for ${invoiceNumber}`)
    }
    if (audit.blockers.length > 0) {
      throw new Error(`Invoice ${invoiceNumber} has ${audit.blockers.length} blocker(s)`)
    }
    if (
      invoice.template !== 'weekly-time' ||
      invoice.weeklyTimeWorklog?.periodStart !== audit.billingPeriod.from ||
      invoice.weeklyTimeWorklog.periodEnd !== audit.billingPeriod.through ||
      invoice.lineItems.length !== 1 ||
      invoice.lineItems[0].quantityQuarterUnits !== (audit.invoiceBilledQuarterUnits ?? audit.weeklyBilledQuarterUnits) ||
      calculateSubtotal(invoice.lineItems) !== audit.standardRateSubtotalCents ||
      calculateDiscount(invoice) !== audit.discountCents ||
      calculateTotal(invoice) !== audit.finalTotalCents ||
      record.totalCents !== audit.finalTotalCents
    ) {
      throw new Error(`Invoice data differs from its audit for ${invoiceNumber}`)
    }
    const manualAdjustmentIds = await verifyAdjustments({
      manifest,
      invoiceNumber,
      invoice,
      audit: auditResult.data,
      adjustmentsRoot: options.adjustmentsRoot,
      consumed,
    })
    sources.push({
      invoiceNumber,
      invoice,
      audit,
      invoiceSha256: record.invoiceSha256,
      auditSha256: record.auditSha256,
      totalCents: audit.finalTotalCents,
      manualAdjustmentIds,
    })
  }
  return { manifest, sources }
}
