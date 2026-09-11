import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { argumentsFrom, readInvoiceFile } from '../scripts/invoice/render.ts'

test('parses generic invoice render arguments explicitly', () => {
  assert.deepEqual(
    argumentsFrom(['--input', 'input/invoices/example.json', '--output', 'output/previews/example.pdf', '--mode', 'preview']),
    {
      input: 'input/invoices/example.json',
      output: 'output/previews/example.pdf',
      mode: 'preview',
    },
  )
  assert.throws(
    () => argumentsFrom(['--input', 'invoice.json', '--output', 'invoice.pdf', '--mode', 'publish']),
    /--mode must be either preview or final/,
  )
})

test('fails closed for malformed generic invoice JSON', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'invoice-render-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const malformed = path.join(directory, 'invoice.json')
  await writeFile(malformed, JSON.stringify({ invoiceNumber: 'BROKEN' }))
  await assert.rejects(
    readInvoiceFile(malformed),
    /Invoice data failed validation/,
  )
})
