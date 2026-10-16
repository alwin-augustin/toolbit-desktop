/**
 * The bundled semantic model and the desktop tool set, under the shipped CSP.
 *
 * The packaged app cannot download weights (`connect-src` allows bundled
 * assets and the Tauri IPC only), so `stage-model.mjs` bakes them — and the
 * ONNX WASM runtime they execute on — into `dist/models/` and `dist/ort/`,
 * and the runtime loads them from there with `allowRemoteModels = false`. This
 * check serves the desktop build with the
 * app's exact CSP and drives Playwright's WebKit — the closest automatable
 * stand-in for WKWebView — through the same path a person takes, all on one
 * document so the CSP-violation collector misses nothing:
 *
 *   1. the palette answers a plain query (positive control), and neither
 *      network tool — hidden from the desktop catalogue, see
 *      `tools.config.ts` — appears for its own name;
 *   2. Settings → "Smarter search" reaches "On-device model ready." without a
 *      remote origin being reachable at all;
 *   3. the model's reranking flips a paraphrase lexical alone gets wrong
 *      ("check my yaml is valid" → YAML Formatter first).
 *
 * Run: node scripts/model-check.mjs                 (from Desktop/desktop-tauri)
 * Needs the desktop build, which stages the model (`npm run build`, or
 * `build:desktop` + `node scripts/stage-model.mjs`), and Playwright's WebKit:
 * `npx --prefix ../../Web/web playwright install webkit`.
 */
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { serveDist, webRoot } from "./lib/serve-dist.mjs";

const MODEL = "mixedbread-ai/mxbai-embed-xsmall-v1";

const { origin, dist, close } = await serveDist();

// Preflight with a message that names the fix, not a stack trace.
const required = [
  join("models", MODEL, "onnx", "model_quantized.onnx"),
  join("ort", "ort-wasm-simd-threaded.asyncify.wasm"),
];
for (const rel of required) {
  try {
    const info = await stat(join(dist, rel));
    if (info.size < 1_000_000) throw new Error(`${rel} is only ${info.size} bytes`);
  } catch {
    console.error(
      `ModelCheck: ${rel} is not staged — run \`npm run build\` (stages it via ` +
        "beforeBuildCommand), or `node scripts/stage-model.mjs` after a `build:desktop`.",
    );
    close();
    process.exit(1);
  }
}

// Playwright belongs to the web repo and is resolved from there: this host repo
// has no browser dependencies of its own, and the desktop build is that repo's.
const requireFromWeb = createRequire(join(webRoot, "package.json"));
const { webkit } = requireFromWeb("@playwright/test");
const browser = await webkit.launch();
const page = await browser.newPage();
page.setDefaultTimeout(30_000);

const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
await page.addInitScript(() => {
  window.__cspViolations = [];
  document.addEventListener("securitypolicyviolation", (event) => {
    window.__cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`);
  });
});

const palette = () => page.getByRole("textbox", { name: "Search tools", exact: true });
const openPalette = () =>
  page.getByRole("button", { name: "Search tools or actions...", exact: true }).click();
/** The rail scopes destination clicks: the sidebar repeats some labels. */
const rail = () => page.getByRole("navigation", { name: "Primary", exact: true });
const topRow = page.locator('[data-index="0"]');

/**
 * Fills the palette and waits until the top row contains `text`. Resolves to
 * the row's text either way, so callers can report what was actually shown.
 */
async function topRowFor(query, text) {
  await palette().fill(query);
  await page
    .waitForFunction(
      (needle) => document.querySelector('[data-index="0"]')?.textContent?.includes(needle),
      text,
      { timeout: 30_000, polling: 200 },
    )
    .catch(() => {});
  return (await topRow.textContent().catch(() => ""))?.trim() ?? "";
}

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

// One document for the whole run: the root navigation happens here and every
// step after it is client-side, so the violation listener set at document
// start covers the model load too.
await page.goto(`${origin}/`, { waitUntil: "load" });

// 1. Positive control — the palette works at all.
await openPalette();
const control = await topRowFor("json formatter", "JSON Formatter");
check(
  control.includes("JSON Formatter"),
  `palette control failed: top result for "json formatter" was "${control}"`,
);

// 2. The two network tools are not offered on the desktop target.
for (const [query, name] of [
  ["websocket tester", "WebSocket Tester"],
  ["api request builder", "API Request Builder"],
]) {
  await palette().fill(query);
  await page.waitForTimeout(500);
  const shown = await page.getByText(name, { exact: true }).count();
  check(shown === 0, `"${name}" still appears in the palette (query: "${query}")`);
}

// 3. Enable the model; it must load from the bundle, with no remote origin.
await page.keyboard.press("Escape");
await palette().waitFor({ state: "hidden" });
await rail().getByRole("button", { name: "Settings", exact: true }).click();
await page.getByRole("checkbox", { name: /Smarter search/ }).check();
const ready = await page
  .getByText("On-device model ready.")
  .waitFor({ timeout: 240_000 })
  .then(() => true)
  .catch(() => false);
check(ready, 'the model never reached "On-device model ready."');

// 4. Prove the model actually answers: a paraphrase lexical alone ties above
// YAML Formatter must rank it first once similarity is blended in.
if (ready) {
  await rail().getByRole("button", { name: "Home", exact: true }).click();
  await openPalette();
  const semantic = await topRowFor("check my yaml is valid", "YAML Formatter");
  check(
    semantic.includes("YAML Formatter"),
    `semantic ranking failed: top result for "check my yaml is valid" was "${semantic}"`,
  );
}

const violations = await page
  .evaluate(() => window.__cspViolations ?? [])
  .catch(() => []);
check(violations.length === 0, `CSP violations: ${violations.join(", ")}`);

await browser.close();
close();

console.log(
  JSON.stringify(
    {
      origin,
      control,
      modelReady: ready,
      violations,
      consoleErrors,
      failures,
    },
    null,
    2,
  ),
);

if (failures.length) {
  console.error(`ModelCheck: failed — ${failures.join("; ")}`);
  process.exit(1);
}
console.log(
  "ModelCheck: the bundled model loads and reranks under the desktop CSP, and the network tools are gone",
);
