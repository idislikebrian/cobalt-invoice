import { Invoice } from './invoice/Invoice'
import { sampleInvoice } from './invoice/sample-invoice'
import { invoiceSchema } from './invoice/schema'

const environmentPaymentDetails = {
  bankName: import.meta.env.VITE_PAYMENT_BANK_NAME,
  routingNumber: import.meta.env.VITE_PAYMENT_ROUTING_NUMBER,
  accountNumber: import.meta.env.VITE_PAYMENT_ACCOUNT_NUMBER,
  ethereumNetwork: import.meta.env.VITE_PAYMENT_ETHEREUM_NETWORK,
  ethereumAddress: import.meta.env.VITE_PAYMENT_ETHEREUM_ADDRESS,
  zellePhone: import.meta.env.VITE_PAYMENT_ZELLE_PHONE,
}

const hasPaymentDetails = Object.values(environmentPaymentDetails).some(
  (value) => value !== undefined && value !== '',
)

const encodedInvoice = new URLSearchParams(window.location.search).get('invoice')
const paddedInvoice = encodedInvoice
  ? encodedInvoice.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encodedInvoice.length / 4) * 4, '=')
  : null
const decodedInvoice = paddedInvoice
  ? new TextDecoder().decode(Uint8Array.from(atob(paddedInvoice), (character) => character.charCodeAt(0)))
  : null
const suppliedInvoice = encodedInvoice
  ? invoiceSchema.parse(JSON.parse(decodedInvoice!))
  : sampleInvoice

const previewInvoice = {
  ...suppliedInvoice,
  ...(hasPaymentDetails && !suppliedInvoice.paymentDetails && { paymentDetails: environmentPaymentDetails }),
}

const renderMode = new URLSearchParams(window.location.search).get('render') === 'final'
  ? 'final'
  : 'preview'

function App() {
  return <Invoice invoice={previewInvoice} renderMode={renderMode} />
}

export default App
