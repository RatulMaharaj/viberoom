/** "A new version is ready." — the counterweight to a cache-first worker.
 *
 *  Without this a PWA happily serves the build a user installed months ago,
 *  forever, and the fix ("clear site data") is one no photographer should have
 *  to know about.
 */
export function UpdatePrompt({ onReload }: { onReload: () => void }) {
  return (
    <div className="toast toast-end z-50">
      <div className="alert alert-info gap-4">
        <span>A new version of Viberoom is ready.</span>
        <button className="btn btn-sm" onClick={onReload}>
          Reload
        </button>
      </div>
    </div>
  )
}
