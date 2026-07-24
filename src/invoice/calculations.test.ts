import { calculateLineItemTotal } from './calculations'
import type { InvoiceLineItem } from './schema'

const cases = [
  { quantity: 1, unitPriceCents: 45000, expectedCents: 45000 },
  { quantity: 2.5, unitPriceCents: 10000, expectedCents: 25000 },
  { quantity: 1.25, unitPriceCents: 8000, expectedCents: 10000 },
]

for (const { quantity, unitPriceCents, expectedCents } of cases) {
  const item: InvoiceLineItem = {
    id: `quantity-${quantity}`,
    description: 'Calculation assertion',
    quantity,
    unitPriceCents,
  }
  const actualCents = calculateLineItemTotal(item)

  if (actualCents !== expectedCents) {
    throw new Error(
      `Expected ${quantity} × ${unitPriceCents} cents to equal ${expectedCents} cents, received ${actualCents}`,
    )
  }
}
