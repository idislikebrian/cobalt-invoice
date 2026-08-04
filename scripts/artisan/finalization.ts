import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  calculateDiscount,
  calculateSubtotal,
  calculateTotal,
} from '../../src/invoice/calculations.ts'
import { invoiceSchema, type InvoiceData } from '../../src/invoice/schema.ts'
import type { WeeklyAudit } from '../../src/artisan/types.ts'

export const ARTISAN_FINAL_INVOICE_NUMBERS = [
  '000702',
  '000703',
  '000704',
  '000705',
  '000706',
] as const

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
})

export type PreviewManifest = z.infer<typeof previewManifestSchema>

export interface ValidatedFinalizationSource {
  invoiceNumber: string
  invoice: InvoiceData
  audit: WeeklyAudit
  invoiceSha256: string
  auditSha256: string
  totalCents: number
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
      if (entry.isFile() && /^\d{6}\.pdf$/.test(entry.name)) {
        found.add(entry.name.slice(0, -4))
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return found
}

export function assertExplicitInvoiceNumbers(invoiceNumbers: string[]): void {
  if (
    invoiceNumbers.length !== ARTISAN_FINAL_INVOICE_NUMBERS.length ||
    invoiceNumbers.some((value, index) => value !== ARTISAN_FINAL_INVOICE_NUMBERS[index])
  ) {
    throw new Error(`Explicitly confirm invoice numbers in this order: ${ARTISAN_FINAL_INVOICE_NUMBERS.join(',')}`)
  }
}

export async function validateFinalizationSource(options: {
  previewDirectory: string
  invoiceNumbers: string[]
  finalRoot: string
}): Promise<{ manifest: PreviewManifest; sources: ValidatedFinalizationSource[] }> {
  const previewDirectory = path.resolve(options.previewDirectory)
  try {
    if (!(await stat(previewDirectory)).isDirectory()) throw new Error()
  } catch {
    throw new Error(`Preview directory is missing: ${previewDirectory}`)
  }

  assertExplicitInvoiceNumbers(options.invoiceNumbers)

  let manifestRaw: string
  try {
    manifestRaw = await readFile(path.join(previewDirectory, 'preview-manifest.json'), 'utf8')
  } catch {
    throw new Error('preview-manifest.json is missing or malformed')
  }
  const manifestResult = previewManifestSchema.safeParse(parseJson(manifestRaw, 'preview-manifest.json'))
  if (!manifestResult.success) throw new Error('preview-manifest.json is missing or malformed')
  const manifest = manifestResult.data
  if (manifest.invoiceNumbers.join(',') !== options.invoiceNumbers.join(',')) {
    throw new Error('Expected invoice numbers are absent from the preview manifest')
  }

  const duplicateNumbers = await existingFinalNumbers(path.resolve(options.finalRoot))
  const duplicate = options.invoiceNumbers.find((number) => duplicateNumbers.has(number))
  if (duplicate) throw new Error(`Final PDF already exists for invoice ${duplicate}`)

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
      invoice.lineItems[0]?.quantityQuarterUnits !== audit.weeklyBilledQuarterUnits ||
      calculateSubtotal(invoice.lineItems) !== audit.standardRateSubtotalCents ||
      calculateDiscount(invoice) !== audit.discountCents ||
      calculateTotal(invoice) !== audit.finalTotalCents ||
      record.totalCents !== audit.finalTotalCents
    ) {
      throw new Error(`Invoice data differs from its audit for ${invoiceNumber}`)
    }
    sources.push({
      invoiceNumber,
      invoice,
      audit,
      invoiceSha256: record.invoiceSha256,
      auditSha256: record.auditSha256,
      totalCents: audit.finalTotalCents,
    })
  }
  return { manifest, sources }
}
