import {
  calculateBalance,
  calculateDiscount,
  calculateLineItemTotal,
  calculateSalesTax,
  calculateTotal,
} from './calculations'
import { sampleInvoice } from './sample-invoice'
import { invoiceSchema, type InvoiceData, type InvoiceLineItem } from './schema'

function assertEqual(
  actual: number,
  expected: number,
  description: string,
): void {
  if (actual !== expected) {
    throw new Error(`${description}: expected ${expected}, received ${actual}`)
  }
}

function withAdjustments(adjustments: Partial<InvoiceData>): InvoiceData {
  return { ...sampleInvoice, ...adjustments }
}

const lineItemCases = [
  { quantity: 1, unitPriceCents: 45000, expectedCents: 45000 },
  { quantity: 2.5, unitPriceCents: 10000, expectedCents: 25000 },
  { quantity: 1.25, unitPriceCents: 8000, expectedCents: 10000 },
]

for (const { quantity, unitPriceCents, expectedCents } of lineItemCases) {
  const item: InvoiceLineItem = {
    id: `quantity-${quantity}`,
    description: 'Calculation assertion',
    quantity,
    unitPriceCents,
  }

  assertEqual(
    calculateLineItemTotal(item),
    expectedCents,
    `${quantity} × ${unitPriceCents} cents`,
  )
}

assertEqual(calculateDiscount(sampleInvoice), 0, 'No discount')
assertEqual(calculateSalesTax(sampleInvoice), 0, 'No sales tax')
assertEqual(calculateTotal(sampleInvoice), 45000, 'Existing sample total')
assertEqual(calculateBalance(sampleInvoice), 45000, 'Unpaid balance')

const fixedDiscountInvoice = withAdjustments({
  discount: { type: 'fixed', amountCents: 5000 },
})
assertEqual(
  calculateDiscount(fixedDiscountInvoice),
  5000,
  'Fixed discount',
)
assertEqual(
  calculateTotal(fixedDiscountInvoice),
  40000,
  'Total after fixed discount',
)

const percentageDiscountInvoice = withAdjustments({
  discount: { type: 'percentage', rateBasisPoints: 1250 },
})
assertEqual(
  calculateDiscount(percentageDiscountInvoice),
  5625,
  'Percentage discount',
)
assertEqual(
  calculateTotal(percentageDiscountInvoice),
  39375,
  'Total after percentage discount',
)

const discountedTaxInvoice = withAdjustments({
  discount: { type: 'fixed', amountCents: 5000 },
  salesTaxRateBasisPoints: 825,
})
assertEqual(
  calculateSalesTax(discountedTaxInvoice),
  3300,
  'Sales tax after discount',
)
assertEqual(
  calculateTotal(discountedTaxInvoice),
  43300,
  'Total after discount and sales tax',
)

assertEqual(
  calculateBalance(withAdjustments({ amountPaidCents: 12500 })),
  32500,
  'Partial-payment balance',
)
assertEqual(
  calculateBalance(withAdjustments({ amountPaidCents: 45000 })),
  0,
  'Paid-in-full balance',
)

const excessiveDiscountResult = invoiceSchema.safeParse({
  ...sampleInvoice,
  discount: { type: 'fixed', amountCents: 45001 },
})

if (excessiveDiscountResult.success) {
  throw new Error('Discount exceeding subtotal should fail schema validation')
}

const mixedDiscountResult = invoiceSchema.safeParse({
  ...sampleInvoice,
  discount: {
    type: 'fixed',
    amountCents: 5000,
    rateBasisPoints: 1000,
  },
})

if (mixedDiscountResult.success) {
  throw new Error('A discount cannot contain fixed and percentage values')
}
