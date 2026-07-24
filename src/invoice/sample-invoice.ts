import { invoiceSchema } from './schema'

export const sampleInvoice = invoiceSchema.parse({
  invoiceNumber: '000697',
  status: 'finalized',
  issueDate: '2026-07-24',
  dueDate: '2026-08-23',
  currency: 'USD',
  sender: {
    name: 'Brian Felix',
  },
  client: {
    name: 'Wheels of NYC',
  },
  lineItems: [
    {
      id: 'presentation-deck-design',
      description: 'Presentation deck design',
      quantity: 1,
      unitPriceCents: 45000,
    },
  ],
})
