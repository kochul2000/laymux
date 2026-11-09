import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import messages from "./remote-messages.json";

describe("Remote 공통 번역 사전", () => {
  it("한국어·영어와 보간 변수를 대칭으로 관리한다", () => {
    const variables = (value: string) =>
      [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const [key, value] of Object.entries(messages)) {
      expect(Object.keys(value).sort(), key).toEqual(["en", "ko"]);
      expect(value.ko.trim(), key).not.toBe("");
      expect(value.en.trim(), key).not.toBe("");
      expect(variables(value.ko), key).toEqual(variables(value.en));
    }
  });
  it("명시된 HTML 표식과 코드 제품 문구는 사전에 존재한다", () => {
    const root = path.resolve(__dirname, "../../..");
    const files = [
      "src-tauri/src/remote_server/assets/remote-app.js",
      ...readdirSync(__dirname)
        .filter((file) => file.endsWith(".js") && file !== "remote-i18n.js")
        .map((file) => `ui/src/remote/${file}`),
    ];
    const check = (key: string, file: string) =>
      expect(Object.hasOwn(messages, key), `${file}: ${key}`).toBe(true);
    const checkHtml = (html: string, file: string) => {
      const document = new DOMParser().parseFromString(html, "text/html");
      for (const element of document.querySelectorAll("*")) {
        for (const attribute of element.attributes)
          if (/^data-remote-i18n(?:$|-)/.test(attribute.name)) check(attribute.value, file);
      }
    };
    checkHtml(
      readFileSync(path.join(root, "src-tauri/src/remote_server/page.html"), "utf8"),
      "page.html",
    );
    for (const file of files) {
      const source = ts.createSourceFile(
        file,
        readFileSync(path.join(root, file), "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          node.expression.getText(source) === "t" &&
          ts.isStringLiteral(node.arguments[0])
        )
          check(node.arguments[0].text, file);
        if (
          ts.isTaggedTemplateExpression(node) &&
          node.tag.getText(source) === "tr" &&
          ts.isTemplateExpression(node.template)
        ) {
          const key =
            node.template.head.text +
            node.template.templateSpans
              .map((span, index) => `{${index}}${span.literal.text}`)
              .join("");
          if (/[A-Za-z가-힣]/.test(key)) check(key, file);
        }
        if (ts.isStringLiteral(node) && node.text.includes("data-remote-i18n"))
          checkHtml(node.text, file);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  });
});
