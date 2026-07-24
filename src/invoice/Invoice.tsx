import {
  calculateLineItemTotal,
  calculateSubtotal,
  calculateTotal,
} from './calculations'
import { formatCurrency, formatDate } from './formatters'
import type { InvoiceData } from './schema'
import './invoice.css'

interface InvoiceProps {
  invoice: InvoiceData
}

interface PartyDetailsProps {
  party: InvoiceData['sender']
}

function PartyDetails({ party }: PartyDetailsProps) {
  return (
    <address className="invoice-party">
      <strong>{party.businessName ?? party.name}</strong>
      {party.businessName && <span>{party.name}</span>}
      {party.address && (
        <>
          <span>{party.address.line1}</span>
          {party.address.line2 && <span>{party.address.line2}</span>}
          <span>
            {[
              party.address.city,
              party.address.region,
              party.address.postalCode,
            ]
              .filter(Boolean)
              .join(', ')}
          </span>
          {party.address.country && <span>{party.address.country}</span>}
        </>
      )}
      {party.email && <span>{party.email}</span>}
      {party.phone && <span>{party.phone}</span>}
    </address>
  )
}

export function Invoice({ invoice }: InvoiceProps) {
  const subtotal = calculateSubtotal(invoice.lineItems)
  const total = calculateTotal(invoice)

  return (
    <main className="invoice-page" aria-label={`Invoice ${invoice.invoiceNumber}`}>
      <header className="invoice-header">
        <div>
          <p className="invoice-eyebrow">Invoice</p>
          <h1>#{invoice.invoiceNumber}</h1>
        </div>
        <span className="invoice-status">{invoice.status}</span>
      </header>

      <section className="invoice-parties" aria-label="Invoice parties">
        <div>
          <h2>From</h2>
          <PartyDetails party={invoice.sender} />
        </div>
        <div>
          <h2>Bill to</h2>
          <PartyDetails party={invoice.client} />
        </div>
        <dl className="invoice-dates">
          <div>
            <dt>Issue date</dt>
            <dd>{formatDate(invoice.issueDate)}</dd>
          </div>
          <div>
            <dt>Due date</dt>
            <dd>{formatDate(invoice.dueDate)}</dd>
          </div>
        </dl>
      </section>

      <table className="invoice-items">
        <thead>
          <tr>
            <th scope="col">Description</th>
            <th scope="col">Qty</th>
            <th scope="col">Unit price</th>
            <th scope="col">Amount</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lineItems.map((item) => (
            <tr key={item.id}>
              <td>
                <strong>{item.description}</strong>
                {item.detail && <span>{item.detail}</span>}
              </td>
              <td>{item.quantity}</td>
              <td>{formatCurrency(item.unitPriceCents, invoice.currency)}</td>
              <td>
                {formatCurrency(
                  calculateLineItemTotal(item),
                  invoice.currency,
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="invoice-summary" aria-label="Invoice totals">
        <dl>
          <div>
            <dt>Subtotal</dt>
            <dd>{formatCurrency(subtotal, invoice.currency)}</dd>
          </div>
          <div className="invoice-total">
            <dt>Total</dt>
            <dd>{formatCurrency(total, invoice.currency)}</dd>
          </div>
        </dl>
      </section>

      {(invoice.notes || invoice.paymentInstructions) && (
        <footer className="invoice-footer">
          {invoice.notes && (
            <section>
              <h2>Notes</h2>
              <p>{invoice.notes}</p>
            </section>
          )}
          {invoice.paymentInstructions && (
            <section>
              <h2>Payment instructions</h2>
              <p>{invoice.paymentInstructions}</p>
            </section>
          )}
        </footer>
      )}
    </main>
  )
}
