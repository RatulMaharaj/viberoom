import type { Filters } from './api'

const KEY = 'viberoom.filters'

export function loadFilters(): Filters {
  try {
    return { sort: 'filename', order: 'asc', ...JSON.parse(sessionStorage.getItem(KEY) ?? '{}') }
  } catch {
    return { sort: 'filename', order: 'asc' }
  }
}

export function saveFilters(f: Filters): void {
  sessionStorage.setItem(KEY, JSON.stringify(f))
}
