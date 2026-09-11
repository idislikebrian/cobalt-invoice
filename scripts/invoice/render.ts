import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { chromium } from 'playwright'
import type { Browser } from 'playwright'
import { createServer } from 'vite'
import { z } from 'zod'
import { invoiceSchema, type InvoiceData } from '../../src/invoice/schema.ts'

type RenderMode = 'preview' | 'final'

export interface RenderArguments {
  input: string
  output: string
  mode: RenderMode
}

export function argumentsFrom(argv: string[]): RenderArguments {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value) {
      throw new Error('Expected --input, --output, and --mode')
    }
    values.set(key, value)
  }

  const input = values.get('--input')
  const output = values.get('--output')
  const mode = values.get('--mode')
  if (!input || !output || !mode) {
    throw new Error('Expected --input, --output, and --mode')
  }
  if (mode !== 'preview' && mode !== 'final') {
    throw new Error('--mode must be either preview or final')
  }
  if (path.extname(output).toLowerCase() !== '.pdf') {
    throw new Error('--output must end in .pdf')
  }

  return { input, output, mode }
}

function parseJson(raw: string, filePath: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`Invoice JSON is missing or malformed: ${filePath}`)
  }
}

function schemaErrorMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join('.') : '<root>'
      return `${field}: ${issue.message}`
    })
    .join('; ')
}

export async function readInvoiceFile(filePath: string): Promise<InvoiceData> {
  const resolved = path.resolve(filePath)
  const raw = await readFile(resolved, 'utf8')
  const result = invoiceSchema.safeParse(parseJson(raw, resolved))
  if (!result.success) {
    throw new Error(`Invoice data failed validation: ${schemaErrorMessage(result.error)}`)
  }
  return result.data
}

async function assertOutputDoesNotExist(outputPath: string): Promise<void> {
  try {
    await stat(outputPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new Error(`Output already exists: ${outputPath}`)
}

export async function renderInvoicePdf(options: RenderArguments): Promise<string> {
  const invoice = await readInvoiceFile(options.input)
  const outputPath = path.resolve(options.output)
  await assertOutputDoesNotExist(outputPath)
  await mkdir(path.dirname(outputPath), { recursive: true })

  const vite = await createServer({
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Could not determine renderer port')
  }

  let browser: Browser | undefined
  try {
    browser = await chromium.launch()
    const encoded = Buffer.from(JSON.stringify(invoice)).toString('base64url')
    const page = await browser.newPage()
    await page.goto(
      `http://127.0.0.1:${address.port}/?invoice=${encoded}&render=${options.mode}`,
      { waitUntil: 'networkidle' },
    )
    await page.pdf({ path: outputPath, format: 'Letter', printBackground: true })
    await page.close()
  } finally {
    await browser?.close()
    await vite.close()
  }

  return outputPath
}

async function main(): Promise<void> {
  const outputPath = await renderInvoicePdf(argumentsFrom(process.argv.slice(2)))
  console.log(`Invoice PDF: ${outputPath}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
