import { invoiceSchema } from './schema'

export const sampleInvoice = invoiceSchema.parse({
  invoiceNumber: '000697',
  status: 'finalized',
  issueDate: '2026-07-24',
  dueDate: '2026-08-23',
  currency: 'USD',
  sender: {
    name: 'Brian Felix',
    businessName: 'Cobalt',
    address: {
      line1: '[N°] [Street Name]',
      postalCode: '11213',
      city: 'Brooklyn',
      region: 'NY',
      country: 'USA',
    },
    footer: {
      companyAddress: '[Company address]',
      websiteLabel: 'wearecobalt.net',
      websiteUrl: 'https://wearecobalt.net',
      phoneLabel: '+1 201.218.1047',
      phoneHref: 'tel:+12012181047',
      socialLabel: 'I: @58.933194',
      generalEmail: 'hi@wearecobalt.net',
      contactName: 'Brian',
      contactEmail: 'hello@brian-felix.com',
    },
  },
  client: {
    name: 'Oren Hod',
    businessName: 'Wheels of NYC',
    address: {
      line1: '[N°] [Street Name]',
      postalCode: '[Postal Code]',
      city: '[City]',
      country: '[Country]',
    },
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
