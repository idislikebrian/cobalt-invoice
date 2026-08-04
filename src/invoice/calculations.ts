import type { InvoiceData, InvoiceLineItem } from './schema'

export function calculateLineItemTotal(item: InvoiceLineItem): number {
  if (item.quantityQuarterUnits !== undefined) {
    return Math.round((item.quantityQuarterUnits * item.unitPriceCents) / 4)
  }

  return Math.round(item.quantity * item.unitPriceCents)
}

export function calculateSubtotal(lineItems: InvoiceLineItem[]): number {
  return lineItems.reduce(
    (subtotal, item) => subtotal + calculateLineItemTotal(item),
    0,
  )
}

export function calculateDiscount(invoice: InvoiceData): number {
  const subtotal = calculateSubtotal(invoice.lineItems)

  if (!invoice.discount) {
    return 0
  }

  const discount =
    invoice.discount.type === 'fixed'
      ? invoice.discount.amountCents
      : Math.round(
          (subtotal * invoice.discount.rateBasisPoints) / 10000,
        )

  return Math.min(discount, subtotal)
}

export function calculateSalesTax(invoice: InvoiceData): number {
  if (!invoice.salesTaxRateBasisPoints) {
    return 0
  }

  const taxableSubtotal =
    calculateSubtotal(invoice.lineItems) - calculateDiscount(invoice)

  return Math.round(
    (taxableSubtotal * invoice.salesTaxRateBasisPoints) / 10000,
  )
}

export function calculateTotal(invoice: InvoiceData): number {
  return (
    calculateSubtotal(invoice.lineItems) -
    calculateDiscount(invoice) +
    calculateSalesTax(invoice)
  )
}

export function calculateBalance(invoice: InvoiceData): number {
  return Math.max(
    calculateTotal(invoice) - (invoice.amountPaidCents ?? 0),
    0,
  )
}
