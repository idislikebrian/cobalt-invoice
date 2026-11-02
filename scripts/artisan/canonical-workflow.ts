import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { previewManifestSchema, validateFinalizationSource } from './finalization.ts'

const APP_ROOT = process.env.INVOICE_STUDIO_APP_ROOT ?? '/srv/cobalt-invoice/app'
const PREVIEW_ROOT = path.resolve(APP_ROOT, 'output', 'previews')
const NUMBER = /^\d{6}$/

export function parseCommand(argv: string[]) {
  const [operation, ...args] = argv
  if (!operation) throw new Error('Expected artisan-preview, artisan-validate, artisan-finalize, or artisan-report')
  const flags = new Map<string, string>()
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i]
    const value = args[i + 1]
    if (!flag?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Expected a value for ${flag ?? 'option'}`)
    }
    if (flags.has(flag)) throw new Error(`Duplicate option: ${flag}`)
    flags.set(flag, value)
    i += 1
  }
  return { operation, flags }
}

export function previewRunnerArgs(from: string, through: string, startNumber: string): string[] {
  return ['run', '--silent', 'invoice:artisan:preview', '--', '--from', from, '--through', through, '--start-number', startNumber]
}

export function finalizeRunnerArgs(previewDirectory: string, invoiceNumbers: string[]): string[] {
  return ['run', '--silent', 'invoice:artisan:finalize', '--', '--preview-dir', previewDirectory, '--invoice-numbers', invoiceNumbers.join(',')]
}

async function canonicalPreview(previewId: string, requestedPath: string): Promise<string> {
  const canonicalRoot = await realpath(PREVIEW_ROOT)
  const canonicalPath = await realpath(requestedPath)
  if (path.dirname(canonicalPath) !== canonicalRoot || path.basename(canonicalPath) !== previewId) {
    throw new Error('Preview path must be the canonical directory for the exact preview ID')
  }
  const rawManifest = await readFile(path.join(canonicalPath, 'preview-manifest.json'), 'utf8')
  const parsed = previewManifestSchema.safeParse(JSON.parse(rawManifest))
  if (!parsed.success || parsed.data.previewId !== previewId) {
    throw new Error('Preview ID does not match its valid manifest')
  }
  return canonicalPath
}

async function validatePreview(flags: Map<string, string>) {
  const previewId = requireFlag(flags, '--preview-id')
  const previewPath = await canonicalPreview(previewId, requireFlag(flags, '--preview-path'))
  const invoiceNumbers = exactSet(requireFlag(flags, '--invoice-numbers'), 'Invoice numbers')
  const rawManifest = await readFile(path.join(previewPath, 'preview-manifest.json'), 'utf8')
  const manifest = previewManifestSchema.parse(JSON.parse(rawManifest))
  if (manifest.invoiceNumbers.length !== invoiceNumbers.length || manifest.invoiceNumbers.some((n) => !invoiceNumbers.includes(n))) {
    throw new Error('Invoice numbers must exactly match the preview manifest invoice set')
  }
  const validated = await validateFinalizationSource({
    previewDirectory: previewPath,
    invoiceNumbers: manifest.invoiceNumbers,
    finalRoot: path.resolve(APP_ROOT, 'output', 'final'),
  })
  console.log(JSON.stringify({ ok: true, operation: 'artisan-validate', previewId, previewPath, invoiceNumbers: validated.sources.map(({ invoiceNumber }) => invoiceNumber) }))
}

export async function reportFinalizedBatch(finalRoot: string, previewId: string, invoiceNumbers: string[]) {
  const matches: Array<{ directory: string; manifest: Record<string, unknown> }> = []
  for (const entry of await readdir(finalRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const manifest = JSON.parse(await readFile(path.join(finalRoot, entry.name, 'finalization-manifest.json'), 'utf8')) as Record<string, unknown>
      if (manifest.sourcePreviewId === previewId) matches.push({ directory: path.join(finalRoot, entry.name), manifest })
    } catch {
      // Unrelated or malformed final directories are not report candidates.
    }
  }
  if (matches.length !== 1) throw new Error('Could not identify exactly one finalization manifest for the reviewed preview')
  const [{ directory, manifest }] = matches
  const manifestNumbers = manifest.invoiceNumbers
  const pdfs = manifest.finalPdfHashes
  if (!Array.isArray(manifestNumbers) || !Array.isArray(pdfs) || manifestNumbers.length !== invoiceNumbers.length || manifestNumbers.some((number) => !invoiceNumbers.includes(String(number)))) {
    throw new Error('Finalization manifest invoice set does not match the approved scope')
  }
  const artifacts = []
  for (const number of invoiceNumbers) {
    const record = pdfs.find((candidate) => typeof candidate === 'object' && candidate !== null && 'invoiceNumber' in candidate && candidate.invoiceNumber === number) as { file?: unknown; sha256?: unknown } | undefined
    if (!record || typeof record.file !== 'string' || path.basename(record.file) !== record.file || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)) {
      throw new Error(`Finalization manifest is missing a valid artifact record for ${number}`)
    }
    const artifactPath = path.join(directory, record.file)
    const actualHash = createHash('sha256').update(await readFile(artifactPath)).digest('hex')
    if (actualHash !== record.sha256) throw new Error(`Final artifact failed integrity verification for ${number}`)
    artifacts.push({ invoiceNumber: number, artifactPath, sha256: actualHash })
  }
  return { ok: true as const, operation: 'artisan-report' as const, previewId, artifacts }
}

function requireFlag(flags: Map<string, string>, key: string): string {
  const value = flags.get(key)
  if (!value) throw new Error(`Expected ${key}`)
  return value
}

function exactSet(csv: string, label: string): string[] {
  const values = csv.split(',').map((value) => value.trim())
  if (values.some((value) => !NUMBER.test(value)) || new Set(values).size !== values.length) {
    throw new Error(`${label} must be a comma-separated set of unique six-digit invoice numbers`)
  }
  return values
}

function runNpm(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', args, { cwd: APP_ROOT, stdio: 'inherit', env: process.env })
    child.once('error', () => reject(new Error('Canonical Artisan workflow could not start')))
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Artisan workflow exited with code ${code}`)))
  })
}

async function preview(flags: Map<string, string>) {
  const from = requireFlag(flags, '--from')
  const through = requireFlag(flags, '--through')
  const startNumber = requireFlag(flags, '--start-number')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(through)) {
    throw new Error('Dates must use YYYY-MM-DD')
  }
  if (!NUMBER.test(startNumber)) throw new Error('Start number must contain exactly six digits')
  await runNpm(previewRunnerArgs(from, through, startNumber))
}

async function finalize(flags: Map<string, string>) {
  const previewId = requireFlag(flags, '--reviewed-preview-id')
  const requestedPath = requireFlag(flags, '--reviewed-preview-path')
  const requestedNumbers = exactSet(requireFlag(flags, '--approved-invoice-numbers'), 'Approved invoice numbers')
  const approvedId = requireFlag(flags, '--approved-preview-id')
  const approvedPath = requireFlag(flags, '--approved-preview-path')
  const approvedNumbers = exactSet(requireFlag(flags, '--approved-invoice-set'), 'Approved invoice set')

  if (previewId !== approvedId || path.resolve(requestedPath) !== path.resolve(approvedPath)) {
    throw new Error('Reviewed preview ID and path must exactly match the approved preview scope')
  }
  if (requestedNumbers.length !== approvedNumbers.length || requestedNumbers.some((n) => !approvedNumbers.includes(n))) {
    throw new Error('Requested invoice numbers must exactly match the approved invoice set')
  }

  const canonicalPath = await canonicalPreview(previewId, requestedPath)
  const rawManifest = await readFile(path.join(canonicalPath, 'preview-manifest.json'), 'utf8')
  const parsed = previewManifestSchema.safeParse(JSON.parse(rawManifest))
  if (!parsed.success) throw new Error('Reviewed preview manifest is invalid')
  const manifestNumbers = parsed.data.invoiceNumbers
  if (manifestNumbers.length !== requestedNumbers.length || manifestNumbers.some((n) => !requestedNumbers.includes(n))) {
    throw new Error('Approved invoice set must exactly match the preview manifest invoice set')
  }

  await validateFinalizationSource({
    previewDirectory: canonicalPath,
    invoiceNumbers: manifestNumbers,
    finalRoot: path.resolve(APP_ROOT, 'output', 'final'),
  })
  await runNpm(finalizeRunnerArgs(canonicalPath, manifestNumbers))
  console.log(JSON.stringify(await reportFinalizedBatch(path.resolve(APP_ROOT, 'output', 'final'), previewId, manifestNumbers)))
}

export async function execute(command: ReturnType<typeof parseCommand>) {
  switch (command.operation) {
    case 'artisan-preview':
      if ([...command.flags.keys()].some((key) => !['--from', '--through', '--start-number'].includes(key))) throw new Error('Unexpected option for artisan-preview')
      return preview(command.flags)
    case 'artisan-validate':
      if ([...command.flags.keys()].some((key) => !['--preview-id', '--preview-path', '--invoice-numbers'].includes(key))) throw new Error('Unexpected option for artisan-validate')
      return validatePreview(command.flags)
    case 'artisan-finalize':
      if ([...command.flags.keys()].some((key) => !['--reviewed-preview-id', '--reviewed-preview-path', '--approved-invoice-numbers', '--approved-preview-id', '--approved-preview-path', '--approved-invoice-set'].includes(key))) throw new Error('Unexpected option for artisan-finalize')
      return finalize(command.flags)
    case 'artisan-report':
      if ([...command.flags.keys()].some((key) => !['--preview-id', '--invoice-numbers'].includes(key))) throw new Error('Unexpected option for artisan-report')
      return reportFinalizedBatch(path.resolve(APP_ROOT, 'output', 'final'), requireFlag(command.flags, '--preview-id'), exactSet(requireFlag(command.flags, '--invoice-numbers'), 'Invoice numbers'))
    default:
      throw new Error('Expected artisan-preview, artisan-validate, artisan-finalize, or artisan-report')
  }
}

async function main() {
  try {
    await execute(parseCommand(process.argv.slice(2)))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Artisan workflow failed' }))
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main()
