const DEFAULT_API_BASE_URL = window.location.origin

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return DEFAULT_API_BASE_URL
  }
  return trimmed.replace(/\/+$/, '')
}

export const API_BASE_URL = normalizeBaseUrl(import.meta.env.VITE_API_BASE_URL ?? DEFAULT_API_BASE_URL)
