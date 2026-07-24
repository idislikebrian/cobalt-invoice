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

const senderFooterSchema = z.object({
  companyAddress: z.string().min(1),
  websiteLabel: z.string().min(1),
  websiteUrl: z.url(),
  phoneLabel: z.string().min(1),
  phoneHref: z.string().startsWith('tel:'),
  socialLabel: z.string().min(1),
  generalEmail: z.email(),
  contactName: z.string().min(1),
  contactEmail: z.email(),
})

const partySchema = z.object({
  name: z.string().min(1),
  businessName: z.string().min(1).optional(),
  email: z.email().optional(),
  phone: z.string().min(1).optional(),
  taxId: z.string().min(1).optional(),
  billingNote: z.string().min(1).optional(),
  address: addressSchema.optional(),
  footer: senderFooterSchema.optional(),
})

const paymentDetailsSchema = z.object({
  accountName: z.string().min(1).optional(),
  accountNumber: z.string().min(1).optional(),
  routingNumber: z.string().min(1).optional(),
  bankName: z.string().min(1).optional(),
  ethereumNetwork: z.string().min(1).optional(),
  ethereumAddress: z.string().min(1).optional(),
  zellePhone: z.string().min(1).optional(),
  paymentUrl: z.url().optional(),
})

export const lineItemSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  detail: z.string().min(1).optional(),
  quantity: z.number().positive(),
  unitPriceCents: z.number().int().nonnegative(),
})

export const discountSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('fixed'),
    amountCents: z.number().int().positive(),
  }).strict(),
  z.object({
    type: z.literal('percentage'),
    rateBasisPoints: z.number().int().positive().max(10000),
  }).strict(),
])

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
    paymentDetails: paymentDetailsSchema.optional(),
    discount: discountSchema.optional(),
    salesTaxRateBasisPoints: z.number().int().positive().max(10000).optional(),
    amountPaidCents: z.number().int().nonnegative().optional(),
  })
  .refine(({ dueDate, issueDate }) => dueDate >= issueDate, {
    message: 'Due date must be on or after the issue date',
    path: ['dueDate'],
  })
  .superRefine(({ discount, lineItems }, context) => {
    if (discount?.type !== 'fixed') {
      return
    }

    const subtotal = lineItems.reduce(
      (sum, item) => sum + Math.round(item.quantity * item.unitPriceCents),
      0,
    )

    if (discount.amountCents > subtotal) {
      context.addIssue({
        code: 'custom',
        message: 'Fixed discount cannot exceed the invoice subtotal',
        path: ['discount', 'amountCents'],
      })
    }
  })

export type InvoiceLineItem = z.infer<typeof lineItemSchema>
export type InvoiceData = z.infer<typeof invoiceSchema>
