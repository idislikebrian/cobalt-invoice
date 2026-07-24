import { QRCodeSVG } from 'qrcode.react'
import {
  calculateBalance,
  calculateDiscount,
  calculateLineItemTotal,
  calculateSalesTax,
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
  nameOrder: 'business-first' | 'name-first'
}

const COBALT_WORDMARK = `░░      ░░░      ░░       ░░░      ░░  ░░░░░░░        ░
▒  ▒▒▒▒  ▒  ▒▒▒▒  ▒  ▒▒▒▒  ▒  ▒▒▒▒  ▒  ▒▒▒▒▒▒▒▒▒▒  ▒▒▒▒
▓  ▓▓▓▓▓▓▓  ▓▓▓▓  ▓       ▓▓  ▓▓▓▓  ▓  ▓▓▓▓▓▓▓▓▓▓  ▓▓▓▓
█  ████  █  ████  █  ████  █        █  ██████████  ████
██      ███      ██       ██  ████  █        ████  ████`

const QR_MESSAGE = 'Thank you for your business'
const RAIL_MARKS = Array.from({ length: 16 }, (_, index) => index)
const RAIL_MIN_OPACITY = 0.1

function PartyDetails({ party, nameOrder }: PartyDetailsProps) {
  const primaryName =
    nameOrder === 'business-first'
      ? (party.businessName ?? party.name)
      : party.name
  const secondaryName =
    party.businessName && party.businessName !== party.name
      ? nameOrder === 'business-first'
        ? party.name
        : party.businessName
      : undefined

  return (
    <address className="invoice-party">
      <strong>{primaryName}</strong>
      {secondaryName && <span>{secondaryName}</span>}
      {party.address && (
        <>
          <span>{party.address.line1}</span>
          {party.address.line2 && <span>{party.address.line2}</span>}
          <span>
            {[party.address.postalCode, party.address.city]
              .filter(Boolean)
              .join(' ')}
            {party.address.region && `, ${party.address.region}`}
          </span>
          {party.address.country && <span>{party.address.country}</span>}
        </>
      )}
    </address>
  )
}

export function Invoice({ invoice }: InvoiceProps) {
  const subtotal = calculateSubtotal(invoice.lineItems)
  const discount = calculateDiscount(invoice)
  const salesTax = calculateSalesTax(invoice)
  const total = calculateTotal(invoice)
  const balance = calculateBalance(invoice)
  const hasBankTransfer = Boolean(
    invoice.paymentDetails?.accountName ||
      invoice.paymentDetails?.accountNumber ||
      invoice.paymentDetails?.routingNumber ||
      invoice.paymentDetails?.bankName,
  )
  const hasEthereum = Boolean(
    invoice.paymentDetails?.ethereumNetwork ||
      invoice.paymentDetails?.ethereumAddress,
  )
  const hasZelle = Boolean(invoice.paymentDetails?.zellePhone)

  return (
    <main className="invoice-page" aria-label={`Invoice ${invoice.invoiceNumber}`}>
      <div className="decorative-rail" aria-hidden="true">
        {RAIL_MARKS.map((mark) => (
          <span
            key={mark}
            style={{
              opacity:
                1 -
                (mark / (RAIL_MARKS.length - 1)) *
                  (1 - RAIL_MIN_OPACITY),
            }}
          />
        ))}
      </div>

      <header className="brand-header">
        <pre className="brand-wordmark" aria-label="Cobalt">
          {COBALT_WORDMARK}
        </pre>
      </header>

      <section className="invoice-information" aria-label="Invoice information">
        <section>
          <h2>Invoice Information</h2>
          <div className="information-columns">
            <PartyDetails
              party={invoice.sender}
              nameOrder="name-first"
            />
            {invoice.sender.taxId && (
              <div className="information-secondary">
                <span>Tax ID</span>
                <strong>{invoice.sender.taxId}</strong>
              </div>
            )}
          </div>
        </section>

        <section>
          <h2>Delivery Information</h2>
          <div className="information-columns">
            <PartyDetails party={invoice.client} nameOrder="name-first" />
            {(invoice.client.email ||
              invoice.client.phone ||
              invoice.client.billingNote) && (
              <div className="information-secondary">
                {invoice.client.email && <span>{invoice.client.email}</span>}
                {invoice.client.phone && <span>{invoice.client.phone}</span>}
                {invoice.client.billingNote && (
                  <span>{invoice.client.billingNote}</span>
                )}
              </div>
            )}
          </div>
        </section>
      </section>

      <section className="invoice-identity" aria-label="Invoice identity">
        <h1>Invoice</h1>
        <div className="identity-number">
          <p>{invoice.invoiceNumber}</p>
          <span className="identity-secondary invoice-status">
            {invoice.status}
          </span>
        </div>
        <div className="identity-date">
          <time dateTime={invoice.issueDate}>
            {formatDate(invoice.issueDate)}
          </time>
          <span className="identity-secondary">
            Due {formatDate(invoice.dueDate)}
          </span>
        </div>
      </section>

      <div className="invoice-commerce-area">
        <div className="invoice-items-group">
          <div className="line-items-region">
            <table className="invoice-items">
              <thead>
                <tr>
                  <th scope="col">Quantity</th>
                  <th scope="col">Description</th>
                  <th scope="col">Unit Cost</th>
                  <th scope="col">Cost</th>
                </tr>
              </thead>
              <tbody>
                {invoice.lineItems.map((item) => (
                  <tr key={item.id}>
                    <td>{item.quantity}</td>
                    <td>
                      <strong>{item.description}</strong>
                      {item.detail && <span>{item.detail}</span>}
                    </td>
                    <td>
                      {formatCurrency(item.unitPriceCents, invoice.currency)}
                    </td>
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
          </div>
        </div>

        <section className="invoice-summary" aria-label="Invoice totals">
          <dl>
            <div>
              <dt>Subtotal</dt>
              <dd>{formatCurrency(subtotal, invoice.currency)}</dd>
            </div>
            <div>
              <dt>Discount</dt>
              <dd>
                {discount > 0
                  ? `−${formatCurrency(discount, invoice.currency)}`
                  : formatCurrency(0, invoice.currency)}
              </dd>
            </div>
            <div>
              <dt>Tax</dt>
              <dd>{formatCurrency(salesTax, invoice.currency)}</dd>
            </div>
            <div className="invoice-total">
              <dt>Total</dt>
              <dd>{formatCurrency(total, invoice.currency)}</dd>
            </div>
            <div>
              <dt>Balance</dt>
              <dd>{formatCurrency(balance, invoice.currency)}</dd>
            </div>
          </dl>
        </section>

        {(invoice.notes || invoice.paymentInstructions) && (
          <section
            className="invoice-addenda"
            aria-label="Additional information"
          >
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
          </section>
        )}
      </div>

      {(invoice.paymentDetails || invoice.sender.footer) && (
        <div className="invoice-ending">
          {invoice.paymentDetails && (
            <section
              className="payment-information"
              aria-labelledby="payment-information-heading"
            >
              <div className="payment-details">
                <h2 id="payment-information-heading">Payment Information</h2>
                {hasBankTransfer && (
                  <section className="payment-method">
                    <h3>Bank Transfer</h3>
                    <dl>
                      {invoice.paymentDetails.accountName && (
                        <div>
                          <dt>Account Name</dt>
                          <dd>{invoice.paymentDetails.accountName}</dd>
                        </div>
                      )}
                      {invoice.paymentDetails.accountNumber && (
                        <div>
                          <dt>Account Number</dt>
                          <dd>{invoice.paymentDetails.accountNumber}</dd>
                        </div>
                      )}
                      {invoice.paymentDetails.routingNumber && (
                        <div>
                          <dt>Routing Number</dt>
                          <dd>{invoice.paymentDetails.routingNumber}</dd>
                        </div>
                      )}
                      {invoice.paymentDetails.bankName && (
                        <div>
                          <dt>Bank</dt>
                          <dd>{invoice.paymentDetails.bankName}</dd>
                        </div>
                      )}
                      <div>
                        <dt>Reference</dt>
                        <dd>Invoice {invoice.invoiceNumber}</dd>
                      </div>
                    </dl>
                  </section>
                )}

                {hasEthereum && (
                  <section className="payment-method">
                    <h3>Ethereum VM</h3>
                    <dl>
                      {invoice.paymentDetails.ethereumAddress && (
                        <div>
                          <dt>Address</dt>
                          <dd className="ethereum-address">
                            {invoice.paymentDetails.ethereumAddress}
                          </dd>
                        </div>
                      )}
                    </dl>
                  </section>
                )}

                {hasZelle && (
                  <section className="payment-method">
                    <h3>Zelle</h3>
                    <dl>
                      <div>
                        <dt>Phone</dt>
                        <dd>{invoice.paymentDetails.zellePhone}</dd>
                      </div>
                    </dl>
                  </section>
                )}
              </div>

              <div className="payment-qr">
                <QRCodeSVG
                  value={QR_MESSAGE}
                  size={76}
                  level="M"
                  marginSize={4}
                  fgColor="#0047AB"
                  bgColor="#F2F3F1"
                  title="Scanning displays “Thank you for your business.”"
                />
              </div>
            </section>
          )}

          {invoice.sender.footer && (
            <footer className="invoice-footer">
              <div className="footer-grid">
                <div>{invoice.sender.footer.companyAddress}</div>
                <div>
                  W:{' '}
                  <a href={invoice.sender.footer.websiteUrl}>
                    {invoice.sender.footer.websiteLabel}
                  </a>
                </div>
                <div>General:</div>
                <div>
                  <a href={`mailto:${invoice.sender.footer.generalEmail}`}>
                    {invoice.sender.footer.generalEmail}
                  </a>
                </div>
                <div>
                  <a href={invoice.sender.footer.phoneHref}>
                    {invoice.sender.footer.phoneLabel}
                  </a>
                </div>
                <div>{invoice.sender.footer.socialLabel}</div>
                <div>{invoice.sender.footer.contactName}:</div>
                <div>
                  <a href={`mailto:${invoice.sender.footer.contactEmail}`}>
                    {invoice.sender.footer.contactEmail}
                  </a>
                </div>
              </div>
            </footer>
          )}
        </div>
      )}
    </main>
  )
}
