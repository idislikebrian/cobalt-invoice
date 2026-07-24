import { Invoice } from './invoice/Invoice'
import { sampleInvoice } from './invoice/sample-invoice'

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

const previewInvoice = {
  ...sampleInvoice,
  ...(hasPaymentDetails && { paymentDetails: environmentPaymentDetails }),
}

function App() {
  return <Invoice invoice={previewInvoice} />
}

export default App
