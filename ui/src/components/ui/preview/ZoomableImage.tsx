import { useState } from "react";

/**
 * `<img>` for FileViewer's zoom controls (Ctrl+Wheel / toolbar buttons).
 *
 * Deliberately does NOT use `transform: scale()`. A transform paints a bigger
 * image without growing the layout box, so a centered flex container reports
 * overflow split evenly above/below and left/right of the original box — the
 * top/left half becomes permanently unreachable, because `overflow: auto`
 * cannot scroll into the negative space a transform paints into. Setting real
 * `width`/`height` from the decoded image's natural size instead grows the
 * actual layout box, so the overflow is real and scrollable — the caller only
 * needs to stop centering past 100% (`imageZoomAlignment` below) so the growth
 * anchors top-left instead of splitting in both directions again.
 */
export function ZoomableImage({
  src,
  alt,
  zoom,
  testId,
}: {
  src: string;
  alt: string;
  /** Display scale in percent. 100 = fit-to-container (no zoom applied yet). */
  zoom: number;
  testId?: string;
}) {
  // Tagged with the `src` it was measured from — this is how a stale natural
  // size from the previous image is kept from applying to a new `src` before
  // its own load fires, without a reset effect (matches FileViewer's own
  // `loaded.path === path` pattern for the same reason: no synchronous
  // setState-in-effect cascade).
  const [natural, setNatural] = useState<{
    src: string;
    width: number;
    height: number;
  } | null>(null);
  const currentNatural = natural?.src === src ? natural : null;

  const zoomed = zoom !== 100 && currentNatural !== null;

  return (
    <img
      src={src}
      alt={alt}
      data-testid={testId}
      onLoad={(e) => {
        const img = e.currentTarget;
        setNatural({ src, width: img.naturalWidth, height: img.naturalHeight });
      }}
      style={
        zoomed && currentNatural
          ? {
              width: currentNatural.width * (zoom / 100),
              height: currentNatural.height * (zoom / 100),
              maxWidth: "none",
              maxHeight: "none",
            }
          : { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }
      }
    />
  );
}
