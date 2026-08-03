/** A two-function key/value store on IndexedDB.
 *
 *  It exists for exactly one value — the library's directory handle — and
 *  IndexedDB is the only storage that can hold one (localStorage stringifies,
 *  which destroys it). A dependency for thirty lines would not pay for itself.
 */

const DB_NAME = 'viberoom'
const STORE = 'kv'

let opening: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return opening
}

function run<T>(mode: IDBTransactionMode, body: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode)
        const req = body(tx.objectStore(STORE))
        req.onsuccess = () => resolve(req.result as T)
        req.onerror = () => reject(req.error)
      }),
  )
}

export function idbGet<T>(key: string): Promise<T | undefined> {
  return run<T | undefined>('readonly', (s) => s.get(key))
}

export function idbSet(key: string, value: unknown): Promise<void> {
  return run<void>('readwrite', (s) => s.put(value, key))
}

export function idbDelete(key: string): Promise<void> {
  return run<void>('readwrite', (s) => s.delete(key))
}
