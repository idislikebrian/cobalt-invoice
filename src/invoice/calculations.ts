import type { InvoiceData, InvoiceLineItem } from './schema'

export function calculateLineItemTotal(item: InvoiceLineItem): number {
  return Math.round(item.quantity * item.unitPriceCents)
}

export function calculateSubtotal(lineItems: InvoiceLineItem[]): number {
  return lineItems.reduce(
    (subtotal, item) => subtotal + calculateLineItemTotal(item),
    0,
  )
}

export function calculateTotal(invoice: InvoiceData): number {
  return calculateSubtotal(invoice.lineItems)
}
