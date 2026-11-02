import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import {
  execute,
  finalizeRunnerArgs,
  parseCommand,
  previewRunnerArgs,
  reportFinalizedBatch,
} from '../scripts/artisan/canonical-workflow.ts'

test('canonical Artisan preview routes to the sanctioned batch preview command', () => {
  assert.deepEqual(previewRunnerArgs('2026-01-04', '2026-01-24', '000720'), [
    'run', '--silent', 'invoice:artisan:preview', '--', '--from', '2026-01-04', '--through', '2026-01-24', '--start-number', '000720',
  ])
  assert.equal(parseCommand(['artisan-preview', '--from', '2026-01-04', '--through', '2026-01-24', '--start-number', '000720']).operation, 'artisan-preview')
})

test('canonical Artisan finalization routes only an explicit reviewed set', () => {
  assert.deepEqual(finalizeRunnerArgs('/srv/cobalt-invoice/app/output/previews/p-1', ['000720', '000721']), [
    'run', '--silent', 'invoice:artisan:finalize', '--', '--preview-dir', '/srv/cobalt-invoice/app/output/previews/p-1', '--invoice-numbers', '000720,000721',
  ])
  assert.throws(() => parseCommand(['artisan-finalize', '--reviewed-preview-id', 'x', '--reviewed-preview-id', 'y']), /Duplicate option/)
})

test('canonical launcher routes Artisan operations through the batch adapter', async () => {
  const launcher = await readFile('/root/.openclaw/workspace/skills/cobalt-invoice-studio/scripts/invoice-studio', 'utf8')
  assert.match(launcher, /artisan-preview\|artisan-validate\|artisan-finalize\|artisan-report/)
  assert.match(launcher, /exec npm run --silent invoice:artisan:canonical -- "\$@"/)
  assert.doesNotMatch(launcher, /invoice:render/)
})

test('finalization rejects absent or mismatched approval scope before touching preview data', async () => {
  await assert.rejects(execute(parseCommand([
    'artisan-finalize',
    '--reviewed-preview-id', 'batch-a',
    '--reviewed-preview-path', '/tmp/batch-a',
    '--approved-invoice-numbers', '000720,000721',
    '--approved-preview-id', 'batch-b',
    '--approved-preview-path', '/tmp/batch-a',
    '--approved-invoice-set', '000720,000721',
  ])), /must exactly match the approved preview scope/)

  await assert.rejects(execute(parseCommand([
    'artisan-finalize',
    '--reviewed-preview-id', 'batch-a',
    '--reviewed-preview-path', '/tmp/batch-a',
    '--approved-invoice-numbers', '000720,000721',
    '--approved-preview-id', 'batch-a',
    '--approved-preview-path', '/tmp/other-path',
    '--approved-invoice-set', '000720,000721',
  ])), /must exactly match the approved preview scope/)

  await assert.rejects(execute(parseCommand([
    'artisan-finalize',
    '--reviewed-preview-id', 'batch-a',
    '--reviewed-preview-path', '/tmp/batch-a',
    '--approved-invoice-numbers', '000720,000721',
    '--approved-preview-id', 'batch-a',
    '--approved-preview-path', '/tmp/batch-a',
    '--approved-invoice-set', '000720,000722',
  ])), /must exactly match the approved invoice set/)
})

test('June authority remains inspect, validate, report, and delegate only', async () => {
  const skill = await readFile('/root/.openclaw/workspace/skills/cobalt-invoice-studio/SKILL.md', 'utf8')
  assert.match(skill, /June may directly execute only `inspect`, `validate`, `artisan-validate`, `report`, and `artisan-report`/)
  assert.match(skill, /June may orchestrate or delegate `prepare`, `preview`, `finalize`, `artisan-preview`, and `artisan-finalize` to Mateo/)
  assert.match(skill, /must not execute those mutations herself/)
})

test('Artisan finalizer has no delivery, Airtable, or Dropbox integration', async () => {
  const source = await readFile(new URL('../scripts/artisan/finalize.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /nodemailer|gmail|airtable|dropbox/i)
})

test('Artisan report returns only manifest-backed artifact metadata and verifies the PDF hash', async (context) => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { createHash } = await import('node:crypto')
  const { tmpdir } = await import('node:os')
  const root = await mkdtemp(path.join(tmpdir(), 'artisan-report-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const directory = path.join(root, 'final-1')
  await mkdir(directory)
  const contents = 'fake pdf bytes'
  const sha256 = createHash('sha256').update(contents).digest('hex')
  await writeFile(path.join(directory, '000720.pdf'), contents)
  await writeFile(path.join(directory, 'finalization-manifest.json'), JSON.stringify({
    sourcePreviewId: 'reviewed-batch',
    invoiceNumbers: ['000720'],
    finalPdfHashes: [{ invoiceNumber: '000720', file: '000720.pdf', sha256 }],
  }))
  const report = await reportFinalizedBatch(root, 'reviewed-batch', ['000720'])
  assert.deepEqual(report.artifacts, [{ invoiceNumber: '000720', artifactPath: path.join(directory, '000720.pdf'), sha256 }])
  await writeFile(path.join(directory, '000720.pdf'), 'tampered')
  await assert.rejects(reportFinalizedBatch(root, 'reviewed-batch', ['000720']), /failed integrity verification/)
})
