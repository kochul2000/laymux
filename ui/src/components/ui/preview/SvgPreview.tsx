import { useMemo } from "react";

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
}: {
  dataUrl: string;
  path: string;
  showSource: boolean;
  bodyStyle?: React.CSSProperties;
}) {
  const source = useMemo(
    () => (showSource ? decodeSvgSource(dataUrl) : null),
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

  return (
    // `flex-1` matters: the toggle shell lays its child out as a flex row, so
    // without it the centering box shrinks to the image and hugs the left edge.
    <div className="flex h-full min-w-0 flex-1 items-center justify-center" style={bodyStyle}>
      <img
        src={dataUrl}
        alt={path}
        style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
        data-testid="svg-preview-image"
      />
    </div>
  );
}

function decodeSvgSource(dataUrl: string): string | null {
  try {
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    // The file is bytes, not latin-1 characters — decode as UTF-8 so a title or
    // comment in a non-ASCII language is readable rather than mojibake.
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return null;
  }
}
