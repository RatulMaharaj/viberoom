/** "A new version is ready." — the counterweight to a cache-first worker.
 *
 *  Without this a PWA happily serves the build a user installed months ago,
 *  forever, and the fix ("clear site data") is one no photographer should have
 *  to know about.
 */
export function UpdatePrompt({ onReload }: { onReload: () => void }) {
  return (
    <div className="toast toast-end z-50">
      {/* Not `alert-info`: daisyUI's info is a fixed blue and ignores the
          theme, so this was the one piece of chrome not wearing the app's own
          paper white. */}
      <div className="alert bg-primary text-primary-content border-primary gap-4">
        <span>A new version of Viberoom is ready.</span>
        <button
          className="btn btn-sm btn-neutral"
          onClick={onReload}
        >
          Reload
        </button>
      </div>
    </div>
  )
}
