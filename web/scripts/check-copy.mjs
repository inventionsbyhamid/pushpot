// Fails when user-facing copy contains a hyphen, en dash or em dash. PushPot's copy style avoids
// them; rephrase instead ("on your phone", not "on-device").
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const PROSE_ATTRIBUTES = new Set([
  "aria-label",
  "aria-description",
  "alt",
  "title",
  "placeholder",
  "label",
  "detail",
  "body",
  "description",
  "message",
  "heading",
  "caption",
  "tagline",
]);
const LONG_DASH = /[–—]/;
const WORD_HYPHEN = /\p{L}-\p{L}|\s-\s/u;
const SENTENCE = /^\s*[\p{Lu}"'“]|[.!?]\s*$/u;

const findings = [];

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

function flag(node, text) {
  const { line } = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
  findings.push(`${relative(root, node.getSourceFile().fileName)}:${line + 1}  ${text.trim()}`);
}

function staticText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ");
  }
  return null;
}

function check(sourceFile) {
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;

    if (ts.isJsxText(node)) {
      if (node.text.trim() && (LONG_DASH.test(node.text) || WORD_HYPHEN.test(node.text))) {
        flag(node, node.text);
      }
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText();
      const value = node.initializer && ts.isStringLiteral(node.initializer) ? node.initializer.text : null;
      if (value !== null && PROSE_ATTRIBUTES.has(name) && (LONG_DASH.test(value) || WORD_HYPHEN.test(value))) {
        flag(node, value);
      }
      if (value !== null) return;
    } else {
      const text = staticText(node);
      const prose = text !== null && text.includes(" ") && SENTENCE.test(text);
      if (text !== null && (LONG_DASH.test(text) || (prose && WORD_HYPHEN.test(text)))) {
        flag(node, text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

for (const file of files(root)) {
  check(ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true));
}

if (findings.length > 0) {
  console.error(`Dashes in user-facing copy:\n${findings.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
