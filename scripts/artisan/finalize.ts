import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import {
  jsonArtifact,
  sha256,
  validateFinalizationSource,
} from './finalization.ts'

function argumentsFrom(argv: string[]): { previewDirectory: string; invoiceNumbers: string[] } {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value) {
      throw new Error('Expected --preview-dir and --invoice-numbers')
    }
    values.set(key, value)
  }
  const previewDirectory = values.get('--preview-dir')
  const invoiceNumbers = values.get('--invoice-numbers')
  if (!previewDirectory || !invoiceNumbers) {
    throw new Error('Expected --preview-dir and --invoice-numbers')
  }
  return {
    previewDirectory,
    invoiceNumbers: invoiceNumbers.split(',').map((value) => value.trim()),
  }
}

async function main(): Promise<void> {
  const args = argumentsFrom(process.argv.slice(2))
  const finalRoot = path.resolve('output', 'final')
  const validated = await validateFinalizationSource({
    previewDirectory: args.previewDirectory,
    invoiceNumbers: args.invoiceNumbers,
    finalRoot,
  })

  const finalizedAt = new Date().toISOString()
  const finalId = finalizedAt.replace(/[:.]/g, '-')
  await mkdir(finalRoot, { recursive: true })
  const outputDirectory = path.join(finalRoot, finalId)
  await mkdir(outputDirectory)

  const vite = await createServer({
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Could not determine finalization renderer port')
  }
  const browser = await chromium.launch()
  const finalPdfHashes: Array<{ invoiceNumber: string; file: string; sha256: string }> = []

  try {
    for (const source of validated.sources) {
      const file = `${source.invoiceNumber}.pdf`
      const outputPath = path.join(outputDirectory, file)
      const encoded = Buffer.from(JSON.stringify(source.invoice)).toString('base64url')
      const page = await browser.newPage()
      await page.goto(
        `http://127.0.0.1:${address.port}/?invoice=${encoded}&render=final`,
        { waitUntil: 'networkidle' },
      )
      await page.pdf({ path: outputPath, format: 'Letter', printBackground: true })
      await page.close()
      finalPdfHashes.push({
        invoiceNumber: source.invoiceNumber,
        file,
        sha256: sha256(await readFile(outputPath)),
      })
    }
  } finally {
    await browser.close()
    await vite.close()
  }

  const manifest = {
    version: 1,
    finalizedAt,
    sourcePreviewDirectory: path.resolve(args.previewDirectory),
    sourcePreviewId: validated.manifest.previewId,
    invoiceNumbers: args.invoiceNumbers,
    sourceDataHashes: validated.sources.map((source) => ({
      invoiceNumber: source.invoiceNumber,
      invoiceSnapshotSha256: source.invoiceSha256,
      auditSha256: source.auditSha256,
    })),
    finalPdfHashes,
    totals: validated.sources.map((source) => ({
      invoiceNumber: source.invoiceNumber,
      totalCents: source.totalCents,
    })),
  }
  const manifestPath = path.join(outputDirectory, 'finalization-manifest.json')
  await writeFile(manifestPath, jsonArtifact(manifest), { flag: 'wx' })

  for (const { file } of finalPdfHashes) {
    await chmod(path.join(outputDirectory, file), 0o444)
  }
  await chmod(manifestPath, 0o444)
  await chmod(outputDirectory, 0o555)

  console.table(finalPdfHashes)
  console.log(`Final artifacts: ${outputDirectory}`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
