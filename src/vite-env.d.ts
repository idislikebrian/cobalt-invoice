/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PAYMENT_BANK_NAME?: string
  readonly VITE_PAYMENT_ROUTING_NUMBER?: string
  readonly VITE_PAYMENT_ACCOUNT_NUMBER?: string
  readonly VITE_PAYMENT_ETHEREUM_NETWORK?: string
  readonly VITE_PAYMENT_ETHEREUM_ADDRESS?: string
  readonly VITE_PAYMENT_ZELLE_PHONE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
