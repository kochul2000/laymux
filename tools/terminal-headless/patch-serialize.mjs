// OSC 8 is omitted by addon-serialize 0.14.0 (#6189). Patch only the daemon's
// pinned copy; keep upstream cell/wrap serialization and license intact.
import { readFile, writeFile } from "node:fs/promises";
const metadata = JSON.parse(await readFile(new URL("node_modules/@xterm/addon-serialize/package.json", import.meta.url), "utf8"));
if (metadata.version !== "0.14.0") throw new Error("Review daemon OSC 8 serialization before changing addon version");
const file = new URL("node_modules/@xterm/addon-serialize/lib/addon-serialize.js", import.meta.url);
let source = await readFile(file, "utf8");
if (!source.includes("_laymuxLinkSequence")) {
  const replace = (from, to) => {
    from = from.replaceAll("\\u001b", "\x1b");
    to = to.replaceAll("\\u001b", "\x1b");
    if (source.split(from).length !== 2) throw new Error(`Pinned daemon serialize patch anchor changed: ${from.slice(0, 35)}`);
    source = source.replace(from, to);
  };
  replace("this._cursorStyleCol=0,this._backgroundCell", "this._cursorStyleCol=0,this._cursorLink=0,this._backgroundCell");
  replace(
    'const i=""===t.getChars(),o=this._diffStyle(t,this._cursorStyle);if(i?!l(this._cursorStyle,t):o.length>0){',
    'const i=""===t.getChars(),o=this._diffStyle(t,this._cursorStyle),url=t.hasExtendedAttrs()?t.extended?.urlId||0:0,linkChanged=url!==this._cursorLink;if((i?!l(this._cursorStyle,t):o.length>0)||linkChanged){',
  );
  replace(
    'this._currentRow+=`\\u001b[${o.join(";")}m`;const t=this._buffer.getLine(s);',
    'o.length&&(this._currentRow+=`\\u001b[${o.join(";")}m`);if(linkChanged){this._currentRow+=this._laymuxLinkSequence(url);this._cursorLink=url}const t=this._buffer.getLine(s);',
  );
  replace(
    'return o.length>0&&(s+=`\\u001b[${o.join(";")}m`),s}}t.SerializeAddon',
    'return o.length>0&&(s+=`\\u001b[${o.join(";")}m`),s+this._laymuxLinkSequence(i.hasExtendedAttrs()?i.extended?.urlId||0:0)}_laymuxLinkSequence(id){const data=id?this._terminal._core._oscLinkService.getLinkData(id):undefined;return "\\x1b]8;"+(data?.id?"id="+data.id:"")+";"+(data?.uri||"")+"\\x1b\\\\"}}t.SerializeAddon',
  );
  await writeFile(file, source);
} else if (source.includes("url=t.extended?.urlId||0")) {
  source = source.replace("url=t.extended?.urlId||0", "url=t.hasExtendedAttrs()?t.extended?.urlId||0:0")
    .replace("this._laymuxLinkSequence(i.extended?.urlId||0)", "this._laymuxLinkSequence(i.hasExtendedAttrs()?i.extended?.urlId||0:0)");
  await writeFile(file, source);
}
