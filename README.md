# Toolbit desktop

The installed Toolbit, for macOS, Windows and Linux: a Tauri 2 host around the
web workspace in [`../../Web/web`](../../Web/web).

This folder owns **only** what a browser cannot do — the native menu bar, native
file panels, single-instance behaviour, window state, file associations and the
paths the OS hands us. The interface, the tool catalogue and the design tokens
all come from the web build, which stays the single place a tool is written.

Read [docs/desktop-platform-decision.md](docs/desktop-platform-decision.md)
for why this is a Tauri app rather than Electron, three native apps, or a PWA —
and for the one thing it deliberately is not: Tauri renders no native widgets.
The window, menus, tray, dialogs and notifications are native; the interface
inside is the same HTML the site serves.

## Requirements

| Platform | Needs                                                                     |
| -------- | ------------------------------------------------------------------------- |
| All      | Node 24 (`.nvmrc` in the web repo), Rust 1.90+ (Tauri 2.12's minimum)     |
| macOS    | Xcode command-line tools; deployment target macOS 13                      |
| Windows  | WebView2 Runtime (the installer bootstraps it when absent); Windows 10+   |
| Linux    | WebKitGTK 4.1 and GTK 3 — build on the oldest distro you support          |

## Run and verify

```bash
npm install                     # Tauri CLI only; the UI's dependencies live in Web/web
npm --prefix ../../Web/web ci   # the workspace UI has to be installed too
npm run dev                     # web dev server in desktop mode + the native window
npm run check                   # cargo check — the shell compiles
npm test                        # cargo test — the shell's unit tests
npm run build                   # bundles Toolbit.app / .msi + .exe / .deb + .rpm + AppImage
npm run verify                  # launches the app and asserts the workspace rendered
npm run verify:editor           # the workspace editor, in WebKit, under the app's CSP
npm run verify:model            # the bundled model + tool set, in WebKit, under the same CSP
npm run icons                   # regenerate src-tauri/icons from the web app's PWA icon
```

`npm run build` builds the web app first (`build:desktop`, i.e.
`vite --mode desktop`), stages the embedding model (`scripts/stage-model.mjs`)
and then prunes the bundle (`scripts/prune-dist.mjs`) before packaging. There
is no second copy of the UI to keep in step: `frontendDist` points straight at
`Web/web/dist`.

`npm run verify` needs a real desktop session — it opens a window and asks the
webview what it rendered, so it reports "did not report within 20s" when run from
a context with no window server (a plain SSH shell, or a sandboxed agent). It
skips the single-instance plugin on purpose: registered normally, a verify run
would hand off to an instance that is already open, exit 0 and prove nothing.

`npm run verify:editor` needs no window server and covers the part `--verify`
cannot see. It serves the desktop build (`scripts/editor-check.mjs`) with the CSP
from `tauri.conf.json` as a response header and drives `/json-formatter` in
Playwright's WebKit — the closest automatable stand-in for WKWebView. It fails if
no CodeMirror editor mounts, if the editor's runtime-injected theme did not apply
(a too-strict `style-src` breaks exactly that, and the editor then looks unstyled
rather than missing), if real keystrokes do not reach the tool, or if the page
reports a `securitypolicyviolation`. It needs `Web/web/dist` built first:
`npm --prefix ../../Web/web run build:desktop`, and the engine once:
`npx --prefix ../../Web/web playwright install webkit`.

`npm run verify:model` needs no window server either, and covers the two places
the packaged app deliberately differs from the web build. The installed app
cannot download the embedding model — the CSP reaches no remote origin — so the
build stages the ~24 MB weights into `dist/models/` and the ONNX WASM runtime
they execute on into `dist/ort/` (`scripts/stage-model.mjs`; the weights are
cached under `node_modules/.cache/`) and the runtime loads both from the bundle
(`semanticModelSource` / `localizeOrtWasmPaths` in
`Web/web/src/core/intent/semantic.ts`). The check
drives WebKit through the real path: the palette cannot show
`api-request-builder` or `websocket-tester` (hidden from the desktop catalogue,
below), Settings → "Smarter search" reaches "On-device model ready." with no
network, and the paraphrase "check my yaml is valid" must rank YAML Formatter
first — the model's reranking, on the bundled weights, under the app's exact
policy.

Closing the loop after a UI change means `npm run build` here, not just
`npm run build` in `Web/web` — the packaged app is the only place the system
webviews (WKWebView, WebView2, WebKitGTK) are exercised.

## Layout

```
src-tauri/
  src/main.rs         the shell: menu, file panels, single instance, open paths
  tauri.conf.json     window, bundle targets, file associations, frontend dist, CSP
  capabilities/       what the bundled web code is allowed to call
  icons/              generated by `npm run icons`
scripts/
  prune-dist.mjs      drops the web-only payload before Tauri embeds the build
  stage-model.mjs     stages the model + ONNX runtime into dist/ (weights cached)
  editor-check.mjs    the workspace editor, in WebKit, under the app CSP
  model-check.mjs     the bundled model + desktop tool set, under the same CSP
  lib/serve-dist.mjs  serves dist with the app's CSP; shared by both checks
```

`frontendDist` is resolved against `src-tauri/`, so this repo only builds next to
the web repo as `Desktop/desktop-tauri` + `Web/web`. CI reproduces that layout by
checking both repos out at those paths — move either and the build fails with
"the `frontendDist` configuration is set to … but this path doesn't exist".

## The contract with the web app

Both halves are thin and mirrored in
[`Web/web/src/platform/desktop.ts`](../../Web/web/src/platform/desktop.ts).
Change one side, change the other.

| Direction | Name                          | Meaning                                          |
| --------- | ----------------------------- | ------------------------------------------------ |
| → web     | `toolbit://menu/quick-open`   | Open the command palette (⌘K)                    |
| → web     | `toolbit://menu/settings`     | Go to Settings (⌘,)                              |
| → web     | `toolbit://menu/open-file`    | Choose a file to load (⌘O)                       |
| → web     | `toolbit://menu/save-result`  | Save the active result (⌘S)                      |
| → web     | `toolbit://menu/close-document` | Close the active document (⌥⌘W)                |
| → web     | `toolbit://open-path`         | A path the OS wants opened: association, second launch, drop |
| → shell   | `open_text_file`              | Native open panel → `{ path, name, contents }`   |
| → shell   | `save_text_file`              | Native save panel → chosen path                  |
| → shell   | `read_text_file`              | Read a path the OS supplied — and only one of those, see below |
| → shell   | `take_pending_open_path`      | Drain paths that arrived before the UI was ready |

Menu item **ids are these event names**, so `on_menu_event` forwards a click
without a lookup table. Everything else — Edit, Window, and the predefined
macOS application menu — is native and needs no wiring.

`read_text_file` is not a general file reader. The shell keeps the set of paths
the OS handed it — a command-line argument, a file association, or a drop — and
refuses anything else. The app parses untrusted documents in the same process as
the webview, so an injection there must not turn into file disclosure. Reaching a
file the OS never offered means going through the native open panel, which is the
user's decision rather than the page's.

## What differs from the web build

`VITE_TARGET=desktop` (see `Web/web/.env.desktop`, tracked on purpose) plus the
shell's presence:

1. **No marketing route.** `/about` is a web-only surface; installed, Toolbit
   opens into the workspace and an unknown path falls through to the 404.
   `/privacy` and `/terms` stay, linked from Settings.
2. **No analytics, and no consent control.** The desktop build sends nothing:
   telemetry refuses at the module level rather than trusting an absent API key.
3. **No service worker and no install prompt** — the shell serves the assets.
4. **The embedding model travels inside the app.** Packaged builds load the
   ~24 MB mxbai-embed-xsmall-v1 weights and their ONNX WASM runtime from the
   bundle (`dist/models/…`, `dist/ort/`); the web build fetches both from
   CDNs on first use instead. `tauri dev` runs without the app CSP, so the
   downloads still work there.
5. **Two tools are absent.** `api-request-builder` and `websocket-tester` need
   a network connection the CSP forbids, so the desktop target hides them from
   the catalogue (`tools.config.ts`) instead of offering tools that always fail.
6. **Native menu and file IO.** Open, Save Result and Quick Open come from the
   menu bar; Open and Save use the OS panels; dropping a file on the window
   loads it into the active tool (or the tool Smart detection picks for it).
7. **Window state and single instance** are handled by the shell, so the app
   reopens where it was and a second launch focuses the window instead of
   starting a second copy.
8. **Closing the window hides it on macOS and quits elsewhere.** macOS keeps the
   app alive behind its Dock icon and reopens the window from there; Windows and
   Linux have no Dock and no tray, so hiding would strand a running process.
9. **`/` is Home, not a landing page**, and there is no address bar — internal
   navigation is unchanged.

Nothing else changes: same tokens, same `wb-*` primitives, same screens.

The page is also locked down: `security.csp` allows bundled assets only, one
inline-style escape hatch for CodeMirror (and Tailwind's runtime style
injection), Tauri's IPC origin, and `'wasm-unsafe-eval'` — the wasm-only sibling
of `'unsafe-eval'`, needed by the bundled embedding model (WebKit refuses to
compile any WebAssembly without it, and it permits nothing except that compile).
No remote origin is reachable, so a tool cannot start talking to the network
even if it wanted to.

Two caveats worth knowing. First, **Tauri cannot apply this policy in
development**: with `build.devUrl` the page is served by Vite, and Tauri's own
docs say it "can't inject headers into the framework's dev server — it can only
inject headers to the final build output". So `npm run dev` runs with no CSP at
all, and anything the CSP would break only appears in a packaged build — which is
why `verify:editor` runs against `dist`, not the dev server.

Second, and this one bit us: **Tauri rewrites the policy it was given.** It
appends the nonces and script hashes it generates for bundled assets to the
directives it touches, so `style-src 'self' 'unsafe-inline'` ships as
`style-src 'self' 'unsafe-inline' 'nonce-…'`. Under the CSP spec a nonce-source
in a directive makes that directive **ignore `'unsafe-inline'`** — the escape
hatch we had deliberately opened stops working. CodeMirror builds its editor
theme and syntax palette by injecting a `<style>` element at runtime, and Base UI
positions its popovers with inline style attributes, so the whole interface
quietly loses its styles: the editor still renders, as unstyled sans text with no
highlighting, and the console says only
"Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline'
does not appear in the `style-src` directive".

`style-src` is therefore exempted from that rewriting with
`security.dangerousDisableAssetCspModification: ["style-src"]`, which leaves the
policy exactly as written and keeps hashing and nonce injection intact for every
other directive. `npm run verify:editor` serves the policy the way Tauri composes
it — nonce included — and fails if the editor's styles stop applying, so this
cannot regress unnoticed. Script hashing is unaffected and still worth having:
without a hash, `script-src 'self'` would refuse the inline bootstrap Tauri
injects.

## The editor is the web app's editor

There is no desktop-specific editor, and there is not meant to be. The installed
app renders the same React workspace in the OS webview, so `CodeEditor.tsx` —
CodeMirror 6 — is what both targets run. Swapping it here alone would fork the
workbench, the design tokens and the accessibility contract (`role="textbox"`,
the Ln/Col status bar, the diff line decorations) that the web tests assert on.

CodeMirror 6 also happens to be the friendliest choice for the CSP above, which
is worth stating because the alternatives are usually proposed for exactly this
kind of host:

| Editor              | What it costs inside a webview                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| CodeMirror 6 (ours) | none — plain DOM and CSS, no worker, no `eval`, injected `<style>` covered by `style-src 'self' 'unsafe-inline'`     |
| Monaco              | needs blob web workers (`worker-src`) and an AMD/loader dance; ~2–5 MB before the first keystroke                    |
| Ace                 | compiles modes at runtime, which wants `script-src 'unsafe-eval'` and weakens the whole page's policy               |
| CodeMirror 5        | a working fallback, but a step backwards with no benefit                                                             |
| `textarea` + overlay | smallest and safest, and loses line numbers, bracket matching, history, diff decorations and the editor's ARIA roles |
| native text view per OS | the only true "hybrid" editor — three implementations, an IPC protocol for content and selection, and no shared tokens |

`npm run verify:editor` is what keeps this honest: it serves the build under the
policy Tauri actually composes and fails if the editor stops mounting or its
injected styles stop applying. In the packaged app a blocked stylesheet looks
like a plain-text editor — no mono font, no highlighting — rather than a broken
page, which is exactly why it is worth an explicit check.

## Limits and next steps

- **The embedding model and its runtime ride in the bundle.** Every installer
  is ~65 MB heavier (weights ~25 MB, ONNX WASM runtime ~41 MB) and the first
  `npm run build` on a machine downloads ~25 MB from the Hugging Face Hub;
  later builds reuse `node_modules/.cache/toolbit-semantic-model`. That is the
  price of semantic search working in an app whose CSP reaches no remote
  origin. `mixedbread-ai/mxbai-embed-xsmall-v1` is Apache-2.0.
- **The editor's styling is verified in WebKit, not yet eyeballed in WKWebView.**
  `npm run verify:editor` reproduces the nonce failure and passes with the fix in
  place, which is a real engine under the real policy — but it is not a real
  window. `npm run verify` is the half that needs one, and it should be run once
  from a desktop session before shipping.
- **The `--verify` probe has not been seen to report since the CSP was added.**
  In the sandboxed session this was developed in, `ToolbitVerify` always falls
  through to its 20s guard and exits 1, with no other instance running and with
  the window on screen — for the packaged bundle as well as `cargo run`. The
  probe here is byte-identical to the version that previously reported, and the
  app itself is fine: the same bundle, read back through the macOS Accessibility
  tree, shows the full workspace (rail, JSON Formatter, both editor panes, live
  status bar), so `--verify` is a gap in the check rather than in the app. The
  cause is not established — the obvious candidates (a background or uncomposited
  webview throttling the probe's `setTimeout`, an injected script not executing)
  have not been told apart. Fix this before trusting `--verify` in CI:
  `verify:editor` and `verify:model` are the desktop checks that run unattended.
- **Window state remembers geometry, not visibility or fullscreen.** The
  plugin's default is `StateFlags::all()`, which persists and restores both.
  Closing the window hides it on macOS, so the state written before a quit can be
  "invisible", and restoring that gives a running app with no window; restoring
  fullscreen makes every launch take over a Space. `main.rs` now asks for
  `SIZE | POSITION | MAXIMIZED | DECORATIONS` only. The plugin still serialises
  the whole cached struct, so `.window-state.json` keeps carrying `visible` and
  `fullscreen` keys — they are simply never applied, and a stale
  `"fullscreen": true` from an older build is ignored on the next launch.
- **Only macOS has been run.** The shell compiles for all three targets, but
  Windows and Linux builds have not been launched here. Test WebKitGTK
  rendering (fonts, canvas, NVIDIA/compositing quirks) on a Linux box before
  promising support.
- **No updater yet.** `tauri-plugin-updater` needs a signing key pair and a
  static manifest; losing that key strands installed users, so it is a
  deliberate next step rather than a default.
- **No signing.** Unsigned macOS builds cannot be distributed outside the
  developer's machine; unsigned Windows downloads trip SmartScreen. Apple
  Developer Program ($99/yr) and an OV certificate (~$150–300/yr) are the gate.
- **The landing page still emits a lazy JS chunk** (it can no longer render, and
  the chunk is never fetched). Dropping it needs the build-time flag to gate the
  `import()` too.
- **Versioning is not tied to the product's.** `tauri.conf.json` says `0.1.0`
  while the web app is `2.0.0`; whatever the releases are tagged, the updater
  will need a monotonic version here.
- **A tray item for a future Quick Tool** is unbuilt — and until it exists,
  closing the window has to quit on Windows and Linux rather than hide.
- **There is no formatting gate.** `cargo fmt --check` currently reports diffs in
  `main.rs`, which is hand-formatted with a wider line than rustfmt's default;
  adding the gate means either running `cargo fmt` once or committing a
  `rustfmt.toml` with the width you actually use. CI checks compilation and tests
  only.
