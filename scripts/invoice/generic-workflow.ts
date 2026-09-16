import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { z } from 'zod'
import { readInvoiceFile } from './render.ts'
import type { InvoiceData } from '../../src/invoice/schema.ts'

const DEFAULT_APP_ROOT = '/srv/cobalt-invoice/app'
const DEFAULT_RUNTIME_ROOT = '/srv/cobalt-invoice/runtime'
const SECRETS_ROOT = '/srv/cobalt-invoice/secrets'
const NUMBER_PATTERN = /^\d{6}$/
const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/
const PREVIEW_ID_PATTERN = /^generic-\d{6}-[a-f0-9]{12}$/

const artifactNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)

export const genericPreviewManifestSchema = z.object({
  version: z.literal(1),
  kind: z.literal('generic-invoice-preview'),
  previewId: z.string().regex(PREVIEW_ID_PATTERN),
  createdAt: z.iso.datetime(),
  invoiceNumber: z.string().regex(NUMBER_PATTERN),
  sourceFile: artifactNameSchema,
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  snapshotFile: artifactNameSchema,
  snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  previewPdfFile: artifactNameSchema,
  previewPdfSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export const genericFinalizationManifestSchema = z.object({
  version: z.literal(1),
  kind: z.literal('generic-invoice-finalization'),
  finalizationId: z.string().regex(PREVIEW_ID_PATTERN),
  finalizedAt: z.iso.datetime(),
  invoiceNumber: z.string().regex(NUMBER_PATTERN),
  sourcePreviewId: z.string().regex(PREVIEW_ID_PATTERN),
  sourcePreviewManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceInvoiceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  previewPdfSha256: z.string().regex(/^[a-f0-9]{64}$/),
  finalizedSnapshotFile: artifactNameSchema,
  finalizedSnapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  finalPdfFile: artifactNameSchema,
  finalPdfSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export type GenericPreviewManifest = z.infer<typeof genericPreviewManifestSchema>
export type GenericFinalizationManifest = z.infer<typeof genericFinalizationManifestSchema>
type RenderMode = 'preview' | 'final'

export interface Renderer {
  (options: { input: string; output: string; mode: RenderMode }): Promise<void>
}

export interface WorkflowContext {
  appRoot: string
  runtimeRoot: string
  now: () => Date
  render: Renderer
}

export interface InspectResult {
  ok: true
  operation: 'inspect'
  invoiceNumber: string
  available: boolean
  occupied: boolean
  inputFiles: string[]
  previewIds: string[]
  managedFinalizationIds: string[]
  legacyFinalArtifacts: string[]
  blockers: string[]
}

function jsonArtifact(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

async function sha256File(filePath: string): Promise<string> {
  return sha256(await readFile(filePath))
}

function assertInvoiceNumber(invoiceNumber: string): void {
  if (!NUMBER_PATTERN.test(invoiceNumber)) {
    throw new Error('Invoice number must contain exactly six digits')
  }
}

function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new Error('Key must use lowercase letters, digits, dots, underscores, or hyphens')
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function assertReadablePathIsNotSecret(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath)
  if (isWithin(SECRETS_ROOT, resolved)) {
    throw new Error('Secret paths are not valid invoice inputs')
  }
  const actual = await realpath(resolved)
  if (isWithin(SECRETS_ROOT, actual)) {
    throw new Error('Secret paths are not valid invoice inputs')
  }
  const fileStat = await lstat(resolved)
  if (fileStat.isSymbolicLink() || !(await stat(actual)).isFile()) {
    throw new Error('Invoice input must be a regular, non-symlink file')
  }
  return actual
}

async function canonicalInputPath(runtimeRoot: string, filePath: string): Promise<string> {
  const inputRoot = path.resolve(runtimeRoot, 'input', 'invoices')
  const actual = await assertReadablePathIsNotSecret(filePath)
  const actualRoot = await realpath(inputRoot)
  if (path.dirname(actual) !== actualRoot) {
    throw new Error('Invoice input must be directly inside the canonical runtime input directory')
  }
  return actual
}

function safeArtifactPath(directory: string, fileName: string): string {
  if (path.basename(fileName) !== fileName || !artifactNameSchema.safeParse(fileName).success) {
    throw new Error('Manifest contains an unsafe artifact filename')
  }
  return path.join(directory, fileName)
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = []
  async function visit(directory: string): Promise<void> {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(entryPath)
      else if (entry.isFile()) files.push(entryPath)
    }
  }
  await visit(root)
  return files.sort()
}

async function loadJson<T>(filePath: string, schema: z.ZodType<T>, label: string): Promise<T> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    throw new Error(`${label} is missing or malformed`)
  }
  const result = schema.safeParse(parsed)
  if (!result.success) throw new Error(`${label} is missing or malformed`)
  return result.data
}

async function loadPreviewManifest(previewDirectory: string): Promise<GenericPreviewManifest> {
  return loadJson(
    path.join(previewDirectory, 'preview-manifest.json'),
    genericPreviewManifestSchema,
    'Preview manifest',
  )
}

async function loadFinalizationManifest(finalDirectory: string): Promise<GenericFinalizationManifest> {
  return loadJson(
    path.join(finalDirectory, 'finalization-manifest.json'),
    genericFinalizationManifestSchema,
    'Finalization manifest',
  )
}

async function writeAtomicExclusive(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o2770 })
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o640)
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await link(temporary, filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Destination already exists: ${filePath}`, {
        cause: error,
      })
    }
    throw error
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

async function acquireInvoiceLock(runtimeRoot: string, invoiceNumber: string): Promise<string> {
  const lockRoot = path.join(runtimeRoot, 'state', 'invoice-studio', 'locks')
  await mkdir(lockRoot, { recursive: true, mode: 0o2770 })
  const lockPath = path.join(lockRoot, `${invoiceNumber}.lock`)
  try {
    await mkdir(lockPath, { mode: 0o750 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Invoice ${invoiceNumber} is locked by another operation`, {
        cause: error,
      })
    }
    throw error
  }
  return lockPath
}

async function releaseInvoiceLock(lockPath: string): Promise<void> {
  await rm(lockPath, { recursive: true, force: true })
}

function fileNameContainsInvoiceNumber(filePath: string, invoiceNumber: string): boolean {
  const escaped = invoiceNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^0-9])${escaped}([^0-9]|$)`).test(path.basename(filePath))
}

async function manifestInventory<T>(options: {
  root: string
  fileName: string
  schema: z.ZodType<T>
}): Promise<{ valid: Array<{ path: string; value: T }>; invalid: string[] }> {
  const valid: Array<{ path: string; value: T }> = []
  const invalid: string[] = []
  for (const filePath of (await listFiles(options.root)).filter((candidate) => path.basename(candidate) === options.fileName)) {
    try {
      valid.push({ path: filePath, value: await loadJson(filePath, options.schema, options.fileName) })
    } catch {
      invalid.push(filePath)
    }
  }
  return { valid, invalid }
}

export async function inspectInvoice(
  context: WorkflowContext,
  invoiceNumber: string,
): Promise<InspectResult> {
  assertInvoiceNumber(invoiceNumber)
  const inputRoot = path.join(context.runtimeRoot, 'input', 'invoices')
  const previewRoot = path.join(context.runtimeRoot, 'output', 'previews')
  const finalRoot = path.join(context.runtimeRoot, 'output', 'final')
  const inputFiles: string[] = []
  const blockers: string[] = []

  for (const filePath of (await listFiles(inputRoot)).filter((candidate) => path.extname(candidate) === '.json')) {
    try {
      const invoice = await readInvoiceFile(filePath)
      if (invoice.invoiceNumber === invoiceNumber) inputFiles.push(filePath)
    } catch {
      if (fileNameContainsInvoiceNumber(filePath, invoiceNumber)) {
        blockers.push(`Unparseable input may use invoice ${invoiceNumber}: ${filePath}`)
      }
    }
  }

  const previews = await manifestInventory({
    root: previewRoot,
    fileName: 'preview-manifest.json',
    schema: genericPreviewManifestSchema,
  })
  const finals = await manifestInventory({
    root: finalRoot,
    fileName: 'finalization-manifest.json',
    schema: genericFinalizationManifestSchema,
  })
  const previewIds = previews.valid
    .filter(({ value }) => value.invoiceNumber === invoiceNumber)
    .map(({ value }) => value.previewId)
    .sort()
  const matchingFinals = finals.valid.filter(({ value }) => value.invoiceNumber === invoiceNumber)
  const managedFinalizationIds = matchingFinals.map(({ value }) => value.finalizationId).sort()
  const managedPdfPaths = new Set(
    finals.valid.map(({ path: manifestPath, value }) =>
      path.resolve(path.dirname(manifestPath), value.finalPdfFile)),
  )
  const legacyFinalArtifacts = (await listFiles(finalRoot))
    .filter((filePath) => path.extname(filePath).toLowerCase() === '.pdf')
    .filter((filePath) => !managedPdfPaths.has(path.resolve(filePath)))
    .filter((filePath) => fileNameContainsInvoiceNumber(filePath, invoiceNumber))

  for (const filePath of [...previews.invalid, ...finals.invalid]) {
    if (filePath.includes(invoiceNumber)) {
      blockers.push(`Malformed manifest may use invoice ${invoiceNumber}: ${filePath}`)
    }
  }

  const occupied = managedFinalizationIds.length > 0 || legacyFinalArtifacts.length > 0
  return {
    ok: true,
    operation: 'inspect',
    invoiceNumber,
    available:
      !occupied && inputFiles.length === 0 && previewIds.length === 0 && blockers.length === 0,
    occupied,
    inputFiles,
    previewIds,
    managedFinalizationIds,
    legacyFinalArtifacts,
    blockers,
  }
}

export async function validateInvoice(input: string): Promise<{
  ok: true
  operation: 'validate'
  invoiceNumber: string
  status: InvoiceData['status']
  input: string
}> {
  const actual = await assertReadablePathIsNotSecret(input)
  const invoice = await readInvoiceFile(actual)
  return {
    ok: true,
    operation: 'validate',
    invoiceNumber: invoice.invoiceNumber,
    status: invoice.status,
    input: actual,
  }
}

export async function prepareInvoice(
  context: WorkflowContext,
  source: string,
  key: string,
): Promise<{
  ok: true
  operation: 'prepare'
  invoiceNumber: string
  status: 'draft'
  input: string
}> {
  assertKey(key)
  const actualSource = await assertReadablePathIsNotSecret(source)
  const invoice = await readInvoiceFile(actualSource)
  assertInvoiceNumber(invoice.invoiceNumber)
  if (invoice.status !== 'draft') throw new Error('Prepared invoices must have draft status')
  const lockPath = await acquireInvoiceLock(context.runtimeRoot, invoice.invoiceNumber)
  try {
    const state = await inspectInvoice(context, invoice.invoiceNumber)
    if (!state.available) throw new Error(`Invoice ${invoice.invoiceNumber} is already in use or blocked`)
    const destination = path.join(context.runtimeRoot, 'input', 'invoices', `${key}.json`)
    await writeAtomicExclusive(destination, jsonArtifact(invoice))
    return {
      ok: true,
      operation: 'prepare',
      invoiceNumber: invoice.invoiceNumber,
      status: 'draft',
      input: destination,
    }
  } finally {
    await releaseInvoiceLock(lockPath)
  }
}

async function verifyPreviewArtifacts(
  context: WorkflowContext,
  previewDirectory: string,
  manifest: GenericPreviewManifest,
): Promise<void> {
  const sourcePath = path.join(context.runtimeRoot, 'input', 'invoices', manifest.sourceFile)
  const sourceActual = await canonicalInputPath(context.runtimeRoot, sourcePath)
  if (await sha256File(sourceActual) !== manifest.sourceSha256) {
    throw new Error(`Invoice source changed after preview ${manifest.previewId}`)
  }
  const snapshotPath = safeArtifactPath(previewDirectory, manifest.snapshotFile)
  const previewPdfPath = safeArtifactPath(previewDirectory, manifest.previewPdfFile)
  if (
    await sha256File(snapshotPath) !== manifest.snapshotSha256 ||
    await sha256File(previewPdfPath) !== manifest.previewPdfSha256
  ) {
    throw new Error(`Preview artifacts failed integrity verification for ${manifest.previewId}`)
  }
}

function previewResult(manifest: GenericPreviewManifest, previewDirectory: string, replayed: boolean) {
  return {
    ok: true as const,
    operation: 'preview' as const,
    invoiceNumber: manifest.invoiceNumber,
    status: 'draft' as const,
    previewId: manifest.previewId,
    artifactPath: safeArtifactPath(previewDirectory, manifest.previewPdfFile),
    sha256: manifest.previewPdfSha256,
    replayed,
  }
}

export async function previewInvoice(context: WorkflowContext, input: string) {
  const inputPath = await canonicalInputPath(context.runtimeRoot, input)
  const invoice = await readInvoiceFile(inputPath)
  assertInvoiceNumber(invoice.invoiceNumber)
  if (invoice.status !== 'draft') throw new Error('Preview requires an invoice with draft status')
  const sourceRaw = await readFile(inputPath)
  const sourceSha256 = sha256(sourceRaw)
  const previewId = `generic-${invoice.invoiceNumber}-${sourceSha256.slice(0, 12)}`
  const previewRoot = path.join(context.runtimeRoot, 'output', 'previews')
  const previewDirectory = path.join(previewRoot, previewId)
  const lockPath = await acquireInvoiceLock(context.runtimeRoot, invoice.invoiceNumber)
  let stagingDirectory: string | undefined
  try {
    const state = await inspectInvoice(context, invoice.invoiceNumber)
    if (state.occupied || state.blockers.length > 0) {
      throw new Error(`Invoice ${invoice.invoiceNumber} is already finalized or blocked`)
    }
    if (await pathExists(previewDirectory)) {
      const existing = await loadPreviewManifest(previewDirectory)
      if (
        existing.previewId !== previewId ||
        existing.invoiceNumber !== invoice.invoiceNumber ||
        existing.sourceFile !== path.basename(inputPath) ||
        existing.sourceSha256 !== sourceSha256
      ) {
        throw new Error(`Preview destination conflicts with existing artifacts: ${previewId}`)
      }
      await verifyPreviewArtifacts(context, previewDirectory, existing)
      return previewResult(existing, previewDirectory, true)
    }

    await mkdir(previewRoot, { recursive: true, mode: 0o2770 })
    stagingDirectory = await mkdtemp(path.join(previewRoot, `.staging-${previewId}-`))
    await chmod(stagingDirectory, 0o750)
    const snapshotFile = `${invoice.invoiceNumber}.invoice.json`
    const previewPdfFile = `${invoice.invoiceNumber}.preview.pdf`
    const snapshotPath = path.join(stagingDirectory, snapshotFile)
    const previewPdfPath = path.join(stagingDirectory, previewPdfFile)
    await writeFile(snapshotPath, jsonArtifact(invoice), { flag: 'wx', mode: 0o640 })
    await context.render({ input: snapshotPath, output: previewPdfPath, mode: 'preview' })
    await chmod(previewPdfPath, 0o640)
    const manifest: GenericPreviewManifest = {
      version: 1,
      kind: 'generic-invoice-preview',
      previewId,
      createdAt: context.now().toISOString(),
      invoiceNumber: invoice.invoiceNumber,
      sourceFile: path.basename(inputPath),
      sourceSha256,
      snapshotFile,
      snapshotSha256: await sha256File(snapshotPath),
      previewPdfFile,
      previewPdfSha256: await sha256File(previewPdfPath),
    }
    const manifestPath = path.join(stagingDirectory, 'preview-manifest.json')
    await writeFile(manifestPath, jsonArtifact(manifest), { flag: 'wx', mode: 0o640 })
    await Promise.all([
      chmod(snapshotPath, 0o440),
      chmod(previewPdfPath, 0o440),
      chmod(manifestPath, 0o440),
    ])
    await chmod(stagingDirectory, 0o550)
    await rename(stagingDirectory, previewDirectory)
    stagingDirectory = undefined
    return previewResult(manifest, previewDirectory, false)
  } finally {
    if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true })
    await releaseInvoiceLock(lockPath)
  }
}

async function verifyExistingFinal(
  finalDirectory: string,
  expectedPreview: GenericPreviewManifest,
): Promise<ReturnType<typeof finalResult>> {
  const manifest = await loadFinalizationManifest(finalDirectory)
  if (
    manifest.finalizationId !== expectedPreview.previewId ||
    manifest.sourcePreviewId !== expectedPreview.previewId ||
    manifest.invoiceNumber !== expectedPreview.invoiceNumber ||
    manifest.sourceInvoiceSha256 !== expectedPreview.sourceSha256 ||
    manifest.previewPdfSha256 !== expectedPreview.previewPdfSha256
  ) {
    throw new Error(`Final destination conflicts with existing artifacts: ${expectedPreview.previewId}`)
  }
  const snapshotPath = safeArtifactPath(finalDirectory, manifest.finalizedSnapshotFile)
  const pdfPath = safeArtifactPath(finalDirectory, manifest.finalPdfFile)
  if (
    await sha256File(snapshotPath) !== manifest.finalizedSnapshotSha256 ||
    await sha256File(pdfPath) !== manifest.finalPdfSha256
  ) {
    throw new Error(`Final artifacts failed integrity verification for ${manifest.finalizationId}`)
  }
  return finalResult(manifest, finalDirectory, true)
}

function finalResult(manifest: GenericFinalizationManifest, finalDirectory: string, replayed: boolean) {
  return {
    ok: true as const,
    operation: 'finalize' as const,
    invoiceNumber: manifest.invoiceNumber,
    status: 'finalized' as const,
    finalizationId: manifest.finalizationId,
    artifactPath: safeArtifactPath(finalDirectory, manifest.finalPdfFile),
    sha256: manifest.finalPdfSha256,
    replayed,
  }
}

export async function finalizeInvoice(
  context: WorkflowContext,
  previewId: string,
  invoiceNumber: string,
) {
  assertInvoiceNumber(invoiceNumber)
  if (!PREVIEW_ID_PATTERN.test(previewId)) throw new Error('Preview ID is invalid')
  const previewDirectory = path.join(context.runtimeRoot, 'output', 'previews', previewId)
  const previewManifestPath = path.join(previewDirectory, 'preview-manifest.json')
  const previewManifest = await loadPreviewManifest(previewDirectory)
  if (previewManifest.previewId !== previewId || previewManifest.invoiceNumber !== invoiceNumber) {
    throw new Error('Explicit invoice number does not match the preview manifest')
  }
  const lockPath = await acquireInvoiceLock(context.runtimeRoot, invoiceNumber)
  const finalRoot = path.join(context.runtimeRoot, 'output', 'final')
  const finalDirectory = path.join(finalRoot, previewId)
  let stagingDirectory: string | undefined
  try {
    await verifyPreviewArtifacts(context, previewDirectory, previewManifest)
    const previewSnapshotPath = safeArtifactPath(previewDirectory, previewManifest.snapshotFile)
    const draftInvoice = await readInvoiceFile(previewSnapshotPath)
    if (draftInvoice.status !== 'draft' || draftInvoice.invoiceNumber !== invoiceNumber) {
      throw new Error('Preview snapshot is not the expected draft invoice')
    }
    if (await pathExists(finalDirectory)) {
      return await verifyExistingFinal(finalDirectory, previewManifest)
    }
    const state = await inspectInvoice(context, invoiceNumber)
    if (state.occupied || state.blockers.length > 0) {
      throw new Error(`Invoice ${invoiceNumber} is already finalized or blocked`)
    }

    await mkdir(finalRoot, { recursive: true, mode: 0o2770 })
    stagingDirectory = await mkdtemp(path.join(finalRoot, `.staging-${previewId}-`))
    await chmod(stagingDirectory, 0o750)
    const finalizedSnapshotFile = `${invoiceNumber}.invoice.json`
    const finalPdfFile = `${invoiceNumber}.pdf`
    const finalizedSnapshotPath = path.join(stagingDirectory, finalizedSnapshotFile)
    const finalPdfPath = path.join(stagingDirectory, finalPdfFile)
    const finalizedInvoice: InvoiceData = { ...draftInvoice, status: 'finalized' }
    await writeFile(finalizedSnapshotPath, jsonArtifact(finalizedInvoice), {
      flag: 'wx',
      mode: 0o640,
    })
    await context.render({ input: finalizedSnapshotPath, output: finalPdfPath, mode: 'final' })
    await chmod(finalPdfPath, 0o640)
    const manifest: GenericFinalizationManifest = {
      version: 1,
      kind: 'generic-invoice-finalization',
      finalizationId: previewId,
      finalizedAt: context.now().toISOString(),
      invoiceNumber,
      sourcePreviewId: previewId,
      sourcePreviewManifestSha256: await sha256File(previewManifestPath),
      sourceInvoiceSha256: previewManifest.sourceSha256,
      previewPdfSha256: previewManifest.previewPdfSha256,
      finalizedSnapshotFile,
      finalizedSnapshotSha256: await sha256File(finalizedSnapshotPath),
      finalPdfFile,
      finalPdfSha256: await sha256File(finalPdfPath),
    }
    const manifestPath = path.join(stagingDirectory, 'finalization-manifest.json')
    await writeFile(manifestPath, jsonArtifact(manifest), { flag: 'wx', mode: 0o640 })
    await Promise.all([
      chmod(finalizedSnapshotPath, 0o440),
      chmod(finalPdfPath, 0o440),
      chmod(manifestPath, 0o440),
    ])
    await chmod(stagingDirectory, 0o550)
    await rename(stagingDirectory, finalDirectory)
    stagingDirectory = undefined
    return finalResult(manifest, finalDirectory, false)
  } finally {
    if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true })
    await releaseInvoiceLock(lockPath)
  }
}

export async function reportInvoice(context: WorkflowContext, invoiceNumber: string) {
  assertInvoiceNumber(invoiceNumber)
  const finalRoot = path.join(context.runtimeRoot, 'output', 'final')
  const finals = await manifestInventory({
    root: finalRoot,
    fileName: 'finalization-manifest.json',
    schema: genericFinalizationManifestSchema,
  })
  const matches = finals.valid.filter(({ value }) => value.invoiceNumber === invoiceNumber)
  if (matches.length > 1) throw new Error(`Multiple managed finals exist for invoice ${invoiceNumber}`)
  if (matches.length === 1) {
    const match = matches[0]
    const artifactPath = safeArtifactPath(path.dirname(match.path), match.value.finalPdfFile)
    const actualHash = await sha256File(artifactPath)
    if (actualHash !== match.value.finalPdfSha256) {
      throw new Error(`Final artifact failed integrity verification for invoice ${invoiceNumber}`)
    }
    return {
      ok: true as const,
      operation: 'report' as const,
      invoiceNumber,
      status: 'finalized' as const,
      artifactPath,
      sha256: actualHash,
      managed: true,
      verifiedAgainstManifest: true,
    }
  }

  const state = await inspectInvoice(context, invoiceNumber)
  if (state.legacyFinalArtifacts.length !== 1) {
    throw new Error(
      state.legacyFinalArtifacts.length === 0
        ? `No final artifact exists for invoice ${invoiceNumber}`
        : `Multiple legacy final artifacts exist for invoice ${invoiceNumber}`,
    )
  }
  const artifactPath = state.legacyFinalArtifacts[0]
  return {
    ok: true as const,
    operation: 'report' as const,
    invoiceNumber,
    status: 'finalized' as const,
    artifactPath,
    sha256: await sha256File(artifactPath),
    managed: false,
    verifiedAgainstManifest: false,
  }
}

export function createCanonicalRenderer(appRoot: string, runtimeRoot: string): Renderer {
  return async ({ input, output, mode }) => {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        'npm',
        ['run', 'invoice:render', '--', '--input', input, '--output', output, '--mode', mode],
        {
          cwd: appRoot,
          env: {
            ...process.env,
            PLAYWRIGHT_BROWSERS_PATH:
              process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(runtimeRoot, 'ms-playwright'),
          },
          stdio: ['ignore', 'ignore', 'ignore'],
        },
      )
      child.once('error', () => reject(new Error('Canonical invoice renderer could not start')))
      child.once('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`Canonical invoice renderer failed in ${mode} mode`))
      })
    })
  }
}

export function createWorkflowContext(options: {
  appRoot?: string
  runtimeRoot?: string
  now?: () => Date
  render?: Renderer
} = {}): WorkflowContext {
  const appRoot = path.resolve(options.appRoot ?? process.env.INVOICE_STUDIO_APP_ROOT ?? DEFAULT_APP_ROOT)
  const runtimeRoot = path.resolve(
    options.runtimeRoot ?? process.env.INVOICE_STUDIO_RUNTIME_ROOT ?? DEFAULT_RUNTIME_ROOT,
  )
  return {
    appRoot,
    runtimeRoot,
    now: options.now ?? (() => new Date()),
    render: options.render ?? createCanonicalRenderer(appRoot, runtimeRoot),
  }
}

interface ParsedCommand {
  operation: string
  flags: Map<string, string | true>
  json: boolean
}

export function parseCommand(argv: string[]): ParsedCommand {
  const [operation, ...rest] = argv
  if (!operation) throw new Error('Expected an operation: inspect, validate, prepare, preview, finalize, or report')
  const flags = new Map<string, string | true>()
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]
    if (!flag?.startsWith('--')) throw new Error(`Unexpected argument: ${flag ?? ''}`)
    if (flags.has(flag)) throw new Error(`Duplicate option: ${flag}`)
    if (flag === '--json') {
      flags.set(flag, true)
      continue
    }
    const value = rest[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Expected a value for ${flag}`)
    flags.set(flag, value)
    index += 1
  }
  return { operation, flags, json: flags.get('--json') === true }
}

function requiredFlag(command: ParsedCommand, name: string): string {
  const value = command.flags.get(name)
  if (typeof value !== 'string') throw new Error(`Expected ${name}`)
  return value
}

function assertAllowedFlags(command: ParsedCommand, allowed: string[]): void {
  const allowedSet = new Set([...allowed, '--json'])
  const unexpected = [...command.flags.keys()].find((flag) => !allowedSet.has(flag))
  if (unexpected) throw new Error(`Unexpected option for ${command.operation}: ${unexpected}`)
}

async function executeCommand(command: ParsedCommand): Promise<unknown> {
  const context = createWorkflowContext()
  switch (command.operation) {
    case 'inspect':
      assertAllowedFlags(command, ['--invoice-number'])
      return inspectInvoice(context, requiredFlag(command, '--invoice-number'))
    case 'validate':
      assertAllowedFlags(command, ['--input'])
      return validateInvoice(requiredFlag(command, '--input'))
    case 'prepare':
      assertAllowedFlags(command, ['--source', '--key'])
      return prepareInvoice(
        context,
        requiredFlag(command, '--source'),
        requiredFlag(command, '--key'),
      )
    case 'preview':
      assertAllowedFlags(command, ['--input'])
      return previewInvoice(context, requiredFlag(command, '--input'))
    case 'finalize':
      assertAllowedFlags(command, ['--preview-id', '--invoice-number'])
      return finalizeInvoice(
        context,
        requiredFlag(command, '--preview-id'),
        requiredFlag(command, '--invoice-number'),
      )
    case 'report':
      assertAllowedFlags(command, ['--invoice-number'])
      return reportInvoice(context, requiredFlag(command, '--invoice-number'))
    default:
      throw new Error('Expected an operation: inspect, validate, prepare, preview, finalize, or report')
  }
}

async function main(): Promise<void> {
  let command: ParsedCommand | undefined
  try {
    command = parseCommand(process.argv.slice(2))
    const result = await executeCommand(command)
    console.log(command.json ? JSON.stringify(result) : JSON.stringify(result, null, 2))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invoice workflow failed'
    if (command?.json || process.argv.includes('--json')) {
      console.error(JSON.stringify({ ok: false, error: message }))
    } else {
      console.error(message)
    }
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main()
}
