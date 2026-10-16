/**
 * Serves the built desktop bundle the way the shell does.
 *
 * `tauri.conf.json`'s CSP as a real response header, `frontendDist`'s files,
 * and the index.html fallback the asset protocol applies to unknown paths.
 * Shared by every check that needs the packaged environment — the policy
 * below is the one the app ships, so a check that passes here passes in the app.
 *
 * The policy needs one correction before it can be sent: Tauri appends the
 * nonces (and script hashes) it generates for bundled assets to the directives
 * it touches — `style-src 'self' 'unsafe-inline'` goes out as
 * `style-src 'self' 'unsafe-inline' 'nonce-…'` — and under the CSP spec a
 * nonce-source in a directive makes that directive *ignore* `'unsafe-inline'`.
 * Serving the unmodified policy would test a policy the app never applies, and
 * that is exactly what CodeMirror's runtime-injected themes trip over.
 * `dangerousDisableAssetCspModification` is the documented opt-out (either
 * `true` or a list of directives) and is honoured below, so this harness tracks
 * whatever the config says.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, join, normalize } from "node:path";

/** The web repo this shell builds — resolved like `frontendDist` resolves. */
export const webRoot = fileURLToPath(new URL("../../../../Web/web", import.meta.url));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};

/**
 * Starts a server on a random port over `Web/web/dist`.
 * Resolves to `{ origin, dist, effectiveCsp, close }`.
 */
export async function serveDist() {
  const dist = join(webRoot, "dist");
  const config = JSON.parse(
    await readFile(
      fileURLToPath(new URL("../../src-tauri/tauri.conf.json", import.meta.url)),
      "utf8",
    ),
  );
  const csp = config.app.security.csp;
  const unmodified = config.app.security.dangerousDisableAssetCspModification ?? false;
  const modificationDisabled = (directive) =>
    unmodified === true || (Array.isArray(unmodified) && unmodified.includes(directive));

  const effectiveCsp = csp
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((directive) => {
      const name = directive.split(/\s+/)[0];
      if (modificationDisabled(name)) return directive;
      if (name === "style-src") return `${directive} 'nonce-toolbitVerifyStyleNonce'`;
      if (name === "script-src") return `${directive} 'nonce-toolbitVerifyScriptNonce'`;
      return directive;
    })
    .join("; ");

  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    let file = join(dist, normalize(path).replace(/^(\.\.[/\\])+/, ""));
    try {
      const info = await stat(file);
      if (info.isDirectory()) file = join(file, "index.html");
    } catch {
      // Tauri's asset protocol falls back to index.html for an unknown path, so
      // the SPA's own router resolves the tool route — the same way the app does.
      file = join(dist, "index.html");
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        // Exactly the policy the packaged app applies.
        "content-security-policy": effectiveCsp,
      });
      response.end(body);
    } catch (error) {
      response.writeHead(404).end(String(error));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    dist,
    effectiveCsp,
    close: () => server.close(),
  };
}
