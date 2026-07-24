import { Invoice } from './invoice/Invoice'
import { sampleInvoice } from './invoice/sample-invoice'

function App() {
  return <Invoice invoice={sampleInvoice} />
}

export default App
