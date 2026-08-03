/** Say the actual thing when the browser cannot do the one job.
 *
 *  Without the File System Access API there is no library to read, and every
 *  failure downstream is a confusing one ("showDirectoryPicker is not a
 *  function"). Safari, Firefox and every iOS browser land here.
 */
export function BrowserGate({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-base-300/95 p-6">
      <div className="card max-w-lg border border-base-content/20 bg-base-100">
        <div className="card-body gap-4">
          <h2 className="card-title font-brand">This browser can't open your photo folder</h2>
          <p>
            Viberoom needs Chrome or Edge on desktop to read your photo folder. It uses the File System Access
            API, which Safari, Firefox and every browser on iOS do not implement.
          </p>
          <p className="text-sm opacity-70">
            Your photos are read directly from disk and never leave your machine — which is exactly why no
            other browser can stand in for it.
          </p>
          {/* Escape hatch for the Python-companion setup: there the backend owns
            * the filesystem, so a browser without the API is still usable. */}
          <div className="card-actions justify-end">
            <button className="btn btn-sm btn-ghost" onClick={onDismiss}>
              I'm running the Viberoom server — continue
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
