import { useMemo } from "react";
import { decodeDataUrlText } from "@/lib/preview/base64";
import { ZoomableImage } from "@/components/ui/preview/ZoomableImage";
import { imageZoomAlignment } from "@/lib/image-zoom";

/**
 * SVG shown as a picture, with its markup available behind the Source toggle.
 *
 * An SVG is the one image format a developer also reads as text, and the source
 * is already in hand: the backend inlines the file as a base64 data URL, so
 * decoding that string is cheaper than a second read.
 *
 * The rendered side stays an `<img>`. Inlining the markup into the document
 * would execute any scripts inside it — an `<img>` never does.
 */
export function SvgPreview({
  dataUrl,
  path,
  showSource,
  bodyStyle,
  zoom,
}: {
  dataUrl: string;
  path: string;
  showSource: boolean;
  bodyStyle?: React.CSSProperties;
  /** Display scale in percent (100 = fit, via Ctrl+Wheel / toolbar zoom controls). */
  zoom?: number;
}) {
  const source = useMemo(
    () => (showSource ? decodeDataUrlText(dataUrl) : null),
    [dataUrl, showSource],
  );

  if (showSource) {
    return (
      <pre
        className="whitespace-pre-wrap break-words"
        style={{ color: "var(--text-primary)", margin: 0, ...bodyStyle }}
        data-testid="svg-preview-source"
      >
        {source ?? "This SVG could not be decoded."}
      </pre>
    );
  }

  const effectiveZoom = zoom ?? 100;
  return (
    // `flex-1` matters: the toggle shell lays its child out as a flex row, so
    // without it the centering box shrinks to the image and hugs the left edge.
    <div
      className="flex h-full min-w-0 flex-1 overflow-auto"
      style={{
        ...bodyStyle,
        alignItems: imageZoomAlignment(effectiveZoom),
        justifyContent: imageZoomAlignment(effectiveZoom),
      }}
    >
      <ZoomableImage src={dataUrl} alt={path} zoom={effectiveZoom} testId="svg-preview-image" />
    </div>
  );
}
