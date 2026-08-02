import { useEffect, useRef } from 'react'

/** RGB histogram computed from the rendered preview, Lightroom-style:
 * per-channel curves blended additively so overlaps read as white/cyan/etc. */
export function Histogram({ src }: { src: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const img = new Image()
    img.src = src
    img.onload = () => {
      // sample downscaled — plenty of pixels for a stable histogram
      const w = 255
      const sample = document.createElement('canvas')
      const sh = Math.max(1, Math.round((img.height / img.width) * w))
      sample.width = w
      sample.height = sh
      const sctx = sample.getContext('2d', { willReadFrequently: true })!
      sctx.drawImage(img, 0, 0, w, sh)
      const data = sctx.getImageData(0, 0, w, sh).data

      const bins = [new Array(256).fill(0), new Array(256).fill(0), new Array(256).fill(0)]
      for (let i = 0; i < data.length; i += 4) {
        bins[0][data[i]]++
        bins[1][data[i + 1]]++
        bins[2][data[i + 2]]++
      }
      // sqrt scale tames spikes; normalize to the global max
      const scaled = bins.map((b) => b.map(Math.sqrt))
      const max = Math.max(...scaled.map((b) => Math.max(...b))) || 1

      const ctx = canvas.getContext('2d')!
      const W = canvas.width
      const H = canvas.height
      ctx.clearRect(0, 0, W, H)
      ctx.fillStyle = '#222'
      ctx.fillRect(0, 0, W, H)
      ctx.globalCompositeOperation = 'screen'
      const colors = ['#c44', '#4a4', '#48c']
      scaled.forEach((b, ch) => {
        ctx.fillStyle = colors[ch]
        ctx.beginPath()
        ctx.moveTo(0, H)
        for (let x = 0; x < 256; x++) {
          ctx.lineTo((x / 255) * W, H - (b[x] / max) * (H - 2))
        }
        ctx.lineTo(W, H)
        ctx.closePath()
        ctx.fill()
      })
      ctx.globalCompositeOperation = 'source-over'
    }
  }, [src])

  return (
    <canvas
      ref={canvasRef}
      width={256}
      height={80}
      className="w-full rounded border border-base-300/40"
    />
  )
}
