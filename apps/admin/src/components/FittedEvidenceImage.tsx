import { useEffect, useRef, useState } from 'react'
import { evidenceImageSize } from '../evidence-image-fit.ts'

/** The scroll box is measured below the toolbar, not against the entire screen. */
export function FittedEvidenceImage({ src, alt, zoom }: { src: string; alt: string; zoom: number }) {
  const viewport = useRef<HTMLDivElement>(null)
  const [space, setSpace] = useState({ width: 0, height: 0 })
  const [image, setImage] = useState<{ src: string; width: number; height: number } | null>(null)
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const measure = () => setSpace({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => { viewport.current?.scrollTo(0, 0) }, [src, zoom])
  const size = image?.src === src ? evidenceImageSize(image.width, image.height, space.width, space.height, zoom) : null
  return <div ref={viewport} dir="ltr" className="h-full w-full overflow-auto" data-evidence-viewport>
    <div className="grid min-h-full min-w-full place-items-center" style={size ?? { width: '100%', height: '100%' }}>
      <img key={src} src={src} alt={alt} className="block rounded-lg object-contain"
        style={size ? { ...size, maxWidth: 'none', maxHeight: 'none' } : { maxWidth: '100%', maxHeight: '100%' }}
        onLoad={event => setImage({ src, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
    </div>
  </div>
}
