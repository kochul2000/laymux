/** Flex alignment for the scroll container hosting a `ZoomableImage`.
 *  Center while the image still fits; once zoomed past 100% it can overflow
 *  the container, and centering an overflowing flex child makes the
 *  start-side overflow unreachable by scroll — anchor top-left instead. */
export function imageZoomAlignment(zoom: number): "center" | "flex-start" {
  return zoom > 100 ? "flex-start" : "center";
}
