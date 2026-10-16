/**
 * Does the workspace editor survive the desktop app's CSP in a WebKit engine?
 *
 * The packaged app is the web build inside WKWebView, behind the CSP in
 * `src-tauri/tauri.conf.json`. Playwright's WebKit is the closest automatable
 * stand-in for WKWebView, so this serves `Web/web/dist` with that exact policy
 * as a response header and then asks the page three questions the CSP can break:
 *
 *   1. does a `.cm-editor` mount at all (CodeMirror's module ran)?
 *   2. did CodeMirror's *runtime-injected* theme apply (style-src)? The theme
 *      sets the mono font and a line-height nothing else sets, so a blocked
 *      `<style>` shows up as a default font rather than as a missing editor.
 *   3. does real keyboard input reach the document (the contenteditable works)?
 *
 * Run: node scripts/editor-check.mjs            (from Desktop/desktop-tauri)
 * Needs Web/web/dist built with `npm run build:desktop` first.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { serveDist, webRoot } from "./lib/serve-dist.mjs";

/** The route the check drives: a workbench tool with an input and an output editor. */
const ROUTE = "/json-formatter";
const SAMPLE = '{"b":2,"a":[1,2,3]}';

// Serving — Tauri's effective policy included — lives in `lib/serve-dist.mjs`,
// shared with `model-check.mjs`; see that file for why the nonces must be
// appended before the policy can be sent.
const { origin, effectiveCsp, close } = await serveDist();

// Playwright belongs to the web repo and is resolved from there: this host repo
// has no browser dependencies of its own, and the desktop build is that repo's.
const requireFromWeb = createRequire(join(webRoot, "package.json"));
const { webkit } = requireFromWeb("@playwright/test");
const browser = await webkit.launch();
const page = await browser.newPage();

const violations = [];
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) =>
  consoleErrors.push(`pageerror: ${error.message}`),
);

await page.goto(`${origin}${ROUTE}`, { waitUntil: "load" });
// A CSP violation is reported on the document, and it is the whole point of the
// check, so it is collected from the first moment the page can record one.
await page.evaluate(() => {
  window.__cspViolations = [];
  document.addEventListener("securitypolicyviolation", (event) => {
    window.__cspViolations.push(
      `${event.violatedDirective} ${event.blockedURI}`,
    );
  });
});

await page.waitForSelector(".cm-editor", { timeout: 15000 });

const measured = await page.evaluate(() => {
  const editors = [...document.querySelectorAll(".cm-editor")];
  const first = editors[0];
  const content = first?.querySelector(".cm-content");
  const computed = content ? getComputedStyle(content) : null;
  return {
    editors: editors.length,
    height: first ? Math.round(first.getBoundingClientRect().height) : 0,
    lines: first ? first.querySelectorAll(".cm-line").length : 0,
    gutters: first ? first.querySelectorAll(".cm-gutters").length : 0,
    fontFamily: computed?.fontFamily ?? "",
    lineHeight: computed?.lineHeight ?? "",
    // CodeMirror writes `aria-label` from the app's own props, so this also
    // proves the React component — not a stray element — produced the editor.
    labels: editors.map((editor) =>
      editor.querySelector("[aria-label]")?.getAttribute("aria-label"),
    ),
  };
});

// Real keyboard input: focus the input editor, replace its content, and see
// whether the document the product reads actually changed.
const input = page.locator('.cm-editor [contenteditable="true"]').first();
const outputText = () =>
  page.evaluate(() => {
    const output = [...document.querySelectorAll(".cm-editor")].find((editor) =>
      editor.querySelector('[aria-label="Result code"]'),
    );
    return output?.querySelector(".cm-content")?.textContent ?? "";
  });
const before = await outputText();
await input.click();
await page.keyboard.press("ControlOrMeta+A");
await page.keyboard.press("Backspace");
await page.keyboard.type(SAMPLE);
const typed = await input.innerText();

const format = page.getByRole("button", { name: /^format/i });
const formatButtons = await format.count();
if (formatButtons) {
  await format.first().click();
}
await page.waitForTimeout(600);

const afterFormat = await page.evaluate(() => {
  const editors = [...document.querySelectorAll(".cm-editor")];
  const output = editors.find((editor) =>
    editor.querySelector('[aria-label="Result code"]'),
  );
  return {
    text: output?.querySelector(".cm-content")?.textContent ?? "",
    status: document.querySelector('[role="status"]')?.textContent ?? "",
    alert: document.querySelector('[role="alert"]')?.textContent ?? "",
    violations: window.__cspViolations ?? [],
  };
});

await browser.close();
close();

const problems = [];
if (measured.editors < 1) problems.push("no editor mounted");
if (measured.height < 80)
  problems.push(`editor height is ${measured.height}px`);
if (measured.lines < 1) problems.push("the editor rendered no lines");
if (!/mono/i.test(measured.fontFamily))
  problems.push(
    `CodeMirror's injected theme did not apply (font-family "${measured.fontFamily}")`,
  );
if (measured.lineHeight === "normal")
  problems.push(
    "CodeMirror's injected theme did not apply (line-height is normal)",
  );
if (!typed.includes(SAMPLE))
  problems.push("typed input did not reach the document");
if (!afterFormat.text.includes('"b": 2'))
  problems.push(
    `the tool did not reformat the typed input (output: ${afterFormat.text.slice(0, 60)})`,
  );
if (afterFormat.violations.length)
  problems.push(`CSP violations: ${afterFormat.violations.join(", ")}`);

console.log(
  JSON.stringify(
    {
      route: ROUTE,
      policy: effectiveCsp,
      measured,
      formatButtons,
      typed: typed.slice(0, 60),
      outputBefore: before.slice(0, 60),
      afterFormat,
      consoleErrors,
    },
    null,
    2,
  ),
);

if (problems.length) {
  console.error(`EditorCheck: failed — ${problems.join("; ")}`);
  process.exit(1);
}
console.log(
  "EditorCheck: the editor mounts, its styles apply and typing works under the desktop CSP",
);
