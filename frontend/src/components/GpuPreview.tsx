/** The canvas the client-side renderer draws into.
 *
 *  Sized and positioned exactly like the <img> it stands in for — a canvas is
 *  a replaced element with an intrinsic size, so the same object-contain fit
 *  applies — and only one of the two is ever in the layout, so the server
 *  render and the GPU frame cannot end up composited on top of each other.
 */
export function GpuPreview({
  canvasRef,
  style,
  visible,
}: {
  canvasRef: React.Ref<HTMLCanvasElement>
  /** The transform the loupe is currently applying, shared with the <img>. */
  style: React.CSSProperties
  visible: boolean
}) {
  return (
    <canvas
      ref={canvasRef}
      className="max-h-full max-w-full object-contain"
      // Kept mounted while hidden: tearing the canvas down would take the
      // WebGL context with it, and getting one back is not free.
      style={{ ...style, display: visible ? undefined : 'none' }}
    />
  )
}
