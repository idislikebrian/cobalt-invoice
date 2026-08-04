export const ARTISAN_TIMEZONE = 'America/New_York' as const
export const ARTISAN_PROJECT = 'Work/Career'
export const ARTISAN_DESCRIPTION = 'Cobalt -- Production'
export const ARTISAN_SERVICE_DESCRIPTION = 'Creative Direction'
export const STANDARD_RATE_CENTS = 12_000
export const DISCOUNT_BASIS_POINTS = 5_000
export const QUARTER_SECONDS = 900

export const ARTISAN_TAGS = {
  'AB - Admin': 'ADMIN',
  'AB - Design': 'DESIGN',
  'AB - Dev': 'DEV',
  'AB - Meeting': 'MEETINGS',
  'AB - Video': 'VIDEO',
} as const

export type ArtisanCategory = (typeof ARTISAN_TAGS)[keyof typeof ARTISAN_TAGS]
export const ARTISAN_CATEGORIES: ArtisanCategory[] = ['ADMIN', 'DESIGN', 'DEV', 'MEETINGS', 'VIDEO']

export function normalizeArtisanDescription(value: string): string {
  return value
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[—–]/g, '--')
}
