/**
 * Stages the embedding model into the desktop bundle.
 *
 * The installed app cannot download from the Hugging Face CDN — the app's CSP
 * allows bundled assets and the Tauri IPC channel only, and Toolbit desktop is
 * deliberately local-only — so the mxbai-embed-xsmall-v1 weights travel inside
 * the app, together with the ONNX WASM runtime that executes them
 * (transformers.js resolves that from a jsdelivr CDN by default). The weights
 * are fetched once into a cache and copied into
 * `Web/web/dist/models/<model>/…`; the runtime files are copied straight from
 * the installed `onnxruntime-web` package into `Web/web/dist/ort/`. The
 * runtime reads both from the bundle (`localizeOrtWasmPaths` in
 * `Web/web/src/core/intent/semantic.ts`).
 *
 * Runs from `beforeBuildCommand`, so every `tauri build` carries the model;
 * the web build (`npm run build` in Web/web) never sees these files.
 *
 * Attribution: mixedbread-ai/mxbai-embed-xsmall-v1 is Apache-2.0 —
 * https://huggingface.co/mixedbread-ai/mxbai-embed-xsmall-v1
 */
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { webRoot } from "./lib/serve-dist.mjs";

const MODEL = "mixedbread-ai/mxbai-embed-xsmall-v1";

/**
 * Exactly the files transformers.js v4 asks for at `dtype: 'q8'`: the config,
 * the tokenizer trio, and the quantized ONNX (`q8` maps to
 * `model_quantized.onnx` — `DEFAULT_DTYPE_SUFFIX_MAPPING` in
 * `@huggingface/transformers`). `model-check.mjs` fails loudly if a future
 * transformers version ever asks for something else; the minimum sizes catch a
 * truncated download or an error page being cached.
 */
const FILES = [
  { path: "config.json", minBytes: 100 },
  { path: "tokenizer.json", minBytes: 100_000 },
  { path: "tokenizer_config.json", minBytes: 100 },
  { path: "special_tokens_map.json", minBytes: 100 },
  { path: "onnx/model_quantized.onnx", minBytes: 20_000_000 },
];

/**
 * The ONNX WASM runtime for the model. transformers.js resolves these from a
 * CDN by default and the app reaches no remote origin, so they ship too: the
 * asyncify pair (WebKit 26+ and every Chromium) and the plain pair (Safari
 * below 26 without WebGPU). The jsep/jspi pairs are WebGPU-only and are not
 * staged — the app asks for the default wasm device.
 */
const ORT_FILES = [
  "ort-wasm-simd-threaded.asyncify.mjs",
  "ort-wasm-simd-threaded.asyncify.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
];

const cacheRoot = fileURLToPath(
  new URL("../node_modules/.cache/toolbit-semantic-model", import.meta.url),
);
const distModelRoot = join(webRoot, "dist", "models", MODEL);

async function hasAtLeast(file, minBytes) {
  try {
    const info = await stat(file);
    return info.isFile() && info.size >= minBytes;
  } catch {
    return false;
  }
}

async function fetchToCache(file, minBytes) {
  const cached = join(cacheRoot, MODEL, file);
  if (await hasAtLeast(cached, minBytes)) {
    return { file, source: "cached", bytes: (await stat(cached)).size };
  }
  const url = `https://huggingface.co/${MODEL}/resolve/main/${file}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `stage-model: download failed for ${file}: HTTP ${response.status} ${response.statusText} (${url})`,
    );
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length < minBytes) {
    throw new Error(
      `stage-model: download truncated for ${file}: ${body.length} bytes, expected at least ${minBytes}`,
    );
  }
  await mkdir(dirname(cached), { recursive: true });
  // Write-then-rename, so an interrupted run never leaves a half file that the
  // `cached` check above would then accept.
  await writeFile(`${cached}.part`, body);
  await rename(`${cached}.part`, cached);
  return { file, source: "downloaded", bytes: body.length };
}

if (!(await hasAtLeast(join(webRoot, "dist", "index.html"), 1))) {
  console.error(
    "stage-model: Web/web/dist has no index.html — build the desktop bundle first " +
      "(`npm --prefix ../../Web/web run build:desktop`).",
  );
  process.exit(1);
}

const staged = [];
for (const { path, minBytes } of FILES) {
  staged.push(await fetchToCache(path, minBytes));
}
for (const { file } of staged) {
  const target = join(distModelRoot, file);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, await readFile(join(cacheRoot, MODEL, file)));
}

// The runtime ships with the web dependencies already; staging is a copy.
const distOrtRoot = join(webRoot, "dist", "ort");
const runtime = [];
for (const name of ORT_FILES) {
  const source = join(webRoot, "node_modules", "onnxruntime-web", "dist", name);
  const minBytes = name.endsWith(".wasm") ? 10_000_000 : 20_000;
  if (!(await hasAtLeast(source, minBytes))) {
    console.error(
      `stage-model: missing or truncated ${source} — run \`npm --prefix ../../Web/web ci\`.`,
    );
    process.exit(1);
  }
  const target = join(distOrtRoot, name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, await readFile(source));
  runtime.push({ name, bytes: (await stat(source)).size });
}

const modelTotal = staged.reduce((sum, entry) => sum + entry.bytes, 0);
const runtimeTotal = runtime.reduce((sum, entry) => sum + entry.bytes, 0);
console.log(
  `stage-model: ${staged.length} model files (${(modelTotal / 1e6).toFixed(1)} MB) staged into ` +
    `Web/web/dist/models/${MODEL}`,
);
for (const { file, source, bytes } of staged) {
  console.log(`  ${source.padEnd(10)} ${(bytes / 1e6).toFixed(2)} MB  ${file}`);
}
console.log(
  `stage-model: ${runtime.length} ONNX runtime files (${(runtimeTotal / 1e6).toFixed(1)} MB) ` +
    `staged into Web/web/dist/ort`,
);
for (const { name, bytes } of runtime) {
  console.log(`  copied     ${(bytes / 1e6).toFixed(2)} MB  ${name}`);
}
