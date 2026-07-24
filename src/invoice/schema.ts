import { z } from 'zod'

const isoDateSchema = z.iso.date()

const addressSchema = z.object({
  line1: z.string().min(1),
  line2: z.string().min(1).optional(),
  city: z.string().min(1),
  region: z.string().min(1).optional(),
  postalCode: z.string().min(1).optional(),
  country: z.string().min(1).optional(),
})

const partySchema = z.object({
  name: z.string().min(1),
  businessName: z.string().min(1).optional(),
  email: z.email().optional(),
  phone: z.string().min(1).optional(),
  address: addressSchema.optional(),
})

export const lineItemSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  detail: z.string().min(1).optional(),
  quantity: z.number().positive(),
  unitPriceCents: z.number().int().nonnegative(),
})

export const invoiceSchema = z
  .object({
    invoiceNumber: z.string().min(1),
    status: z.enum(['draft', 'finalized', 'sent', 'paid', 'overdue', 'void']),
    issueDate: isoDateSchema,
    dueDate: isoDateSchema,
    currency: z.string().regex(/^[A-Z]{3}$/, 'Use a three-letter ISO currency code'),
    sender: partySchema,
    client: partySchema,
    lineItems: z.array(lineItemSchema).min(1),
    notes: z.string().min(1).optional(),
    paymentInstructions: z.string().min(1).optional(),
  })
  .refine(({ dueDate, issueDate }) => dueDate >= issueDate, {
    message: 'Due date must be on or after the issue date',
    path: ['dueDate'],
  })

export type InvoiceLineItem = z.infer<typeof lineItemSchema>
export type InvoiceData = z.infer<typeof invoiceSchema>
