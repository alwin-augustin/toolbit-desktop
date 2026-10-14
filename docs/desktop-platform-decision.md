# Desktop platform decision — Toolbit for macOS, Windows and Linux

**Status:** decided — see §7. Tauri is now the only desktop app: the SwiftUI app
was deleted after this was written, see §8.
**Date:** 14 October 2026
**Question:** what do we build the Windows and Linux desktop apps with, and can Tauri
give us the native result we already have on macOS?

> **Update (after the fact).** §1–§7 are the decision as taken and are kept as
> written, because the reasoning is what justifies the choice. Two things have
> changed since: the SwiftUI app was **deleted** rather than frozen (archived in
> [archive/](archive)), and the adapter layer turned out to live in the web repo.
> §8 records both and supersedes §4's layout and §5's references to the macOS app.

---

## 1. What exists today

| Target      | Where                       | What it is                                                                                                     | Repo                            |
| ----------- | --------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Web + PWA   | `Web/web`                   | Vite + React 19 SPA, 42 tools, tokens-driven shell, deployed to Cloudflare Pages                                | `alwin-augustin/toolbit`        |
| macOS (retired) | ~~`Desktop/desktop`~~   | Native Swift 6 / SwiftUI app, 17 tools, AppKit editors. **Deleted** — archived in [archive/](archive)            | `Toolbit-app/desktop`           |
| Win / Linux | —                           | does not exist yet                                                                                              | —                               |

The macOS app was deliberately **not** the web app: its PRD stated the product
should "feel like a native system utility for developers, rather than a website packaged
as a desktop application", and its design system said the same about the visuals
("native macOS conventions before custom components"). Both documents were retired
with the app. The web app is the opposite bet — one UI, any browser, 42 tools, tabbed
workspace.

Those are two different products that happen to share a catalogue. That is the crux of
this decision, not the choice of wrapper.

---

## 2. The direct answer on Tauri and "native elements"

**Tauri does not render native platform widgets.** All application content is HTML/CSS/JS
running in the OS webview — WKWebView on macOS, WebView2 (Chromium) on Windows,
WebKitGTK on Linux. Tauri's own architecture page is explicit that the core process does
not render the UI; the webview executes your frontend
([process model](https://v2.tauri.app/concept/process-model/)).

What *is* genuinely native in a Tauri app: the window and its decorations, the application
menu, the system tray, native file open/save panels, OS notifications, file-drop events,
window state restore, deep links and single-instance behaviour. Every one of those is an
API or official plugin, not an automatic property
([menus](https://v2.tauri.app/learn/window-menu/),
[dialog](https://v2.tauri.app/plugin/dialog/),
[tray](https://v2.tauri.app/learn/system-tray/)).

What is **not** native: sidebar, toolbar, split view, lists, text fields, buttons, the
text editor, the settings window, tables. There is no supported "put an `NSView` / WinUI
control inside my React layout" layer. Native views can be forced in via `raw-window-handle`
plus `objc2-app-kit` on macOS, GTK's `default_vbox` on Linux, and raw WebView2 work on
Windows, and Tauri's multi-webview API exists but is documented as **unstable**
([window customization](https://v2.tauri.app/learn/window-customization/),
[Rust `Window`](https://docs.rs/tauri/latest/tauri/window/struct.Window.html),
[multiwebview](https://v2.tauri.app/reference/javascript/api/namespacewebview/)).

So the honest framing: **Tauri gives you a native window with your web UI inside it.** It
gives the app a native *body* (menus, tray, dialogs, shortcuts, updates, installers), not
a native *interface*. A Tauri Toolbit would look like the web workspace with desktop
tweaks — it would not look like the SwiftUI app.

**Hybrid is supported, and it is the right shape here** — but "hybrid" means *one React
codebase plus a native shell layer*, not *native widgets mixed into the DOM*:

| Tauri frontend mode       | How                                                       | Verdict for Toolbit                                                                                 |
| ------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Bundled assets            | `frontendDist` points at the Vite output                  | ✅ recommended — offline-first is the product promise, and `toolbit.app` is not a runtime dependency |
| Remote URL                | `frontendDist` is an https URL                            | ❌ loading the UI over the network contradicts "everything runs in this tab" and breaks offline       |
| Sidecar / localhost serve | bundle a local server, `tauri-plugin-localhost`           | ❌ unnecessary — there is no server today; the plugin carries documented security risk                |
| Bundle + remote hybrid     | bundle for offline, fetch remote data/services when available | ✅ for optional things (catalogue metadata, update manifest), never for the UI itself               |

Remote content is also a separate security boundary: Tauri APIs are granted to bundled code
by default and must be explicitly allowed for remote origins
([capabilities](https://v2.tauri.app/security/capabilities/)).

---

## 3. Options

| Option                          | One UI for all 3 OSes | Native feel                    | Installer / memory                              | Cost to build & keep            |
| ------------------------------- | --------------------- | ------------------------------ | ----------------------------------------------- | ------------------------------- |
| **A. Tauri 2 for Win + Linux, keep SwiftUI for macOS** | no — two UIs | native on macOS, web-with-native-chrome elsewhere | ~2–10 MB                              | medium; two products to keep in sync with 42 tools |
| **B. Tauri 2 for all three (retire or freeze SwiftUI)** | yes             | web UI in a native window everywhere               | ~2–10 MB                                        | lowest per extra OS             |
| **C. Electron for Win + Linux** | no                    | web UI, but identical rendering on every OS        | ~80–150 MB, 150–300 MB idle                     | medium-low                      |
| **D. Native per platform** (SwiftUI + WinUI/WPF + GTK) | no    | fully native everywhere                            | small                                           | highest — three codebases, three tool engines |

Evidence: Tauri 2.12.3 is current, stable since Oct 2024, no stable v3
([core releases](https://v2.tauri.app/release/tauri/)); a macOS `.app` measured 8.6 MiB vs
244 MiB for the Electron equivalent ([benchmark](https://www.gethopp.app/blog/tauri-vs-electron));
Electron 44.x bundles Chromium for renderer consistency
([why Electron](https://www.electronjs.org/docs/latest/why-electron)).

**Rendering consistency is the real trade-off** if we pick Tauri: WebView2 is Chromium,
but macOS is WKWebView and Linux is WebKitGTK, whose version and GPU behaviour depend on
the distribution ([webview versions](https://v2.tauri.app/reference/webview-versions/),
[Linux graphics](https://v2.tauri.app/develop/debug/linux-graphics/)).

### Recommendation

**Option B — Tauri 2 for Windows and Linux *and* macOS, with the existing SwiftUI app kept
as the reference implementation of "native", not as a second shipping product.**

Reasoning:

1. The web app already contains the full catalogue (42 tools vs 17) and a documented design
   system. Reusing it keeps one tool engine, one catalogue, one visual language.
2. Tauri is the only option that reuses that UI *and* produces a small, offline, installable
   app on all three platforms. Electron's only advantage (identical Chromium everywhere)
   costs 10–30× the download size for a local utility.
3. Option A is tempting because the SwiftUI app is more native, but it splits the catalogue:
   every new tool then needs a TS implementation, a Rust-free Tauri shell update, *and* a
   Swift implementation. That is the maintenance cost that eventually kills one of the apps.
4. Option D is the only one that delivers "native elements" everywhere, and it costs three
   codebases. Not justified for a utility catalogue.

If the product decision is instead "macOS is the native flagship, Windows/Linux are
convenience ports", then Option A is correct and Section 4 applies only to the ports.

---

## 4. If we pick Tauri: the concrete shape

New folder, sibling to the existing desktop work, with the web build as the single source
of the UI:

```
Desktop/desktop-tauri/          # the Tauri host (Rust shell only, no adapter code)
  src-tauri/                    # Rust shell: menu, panel IO, state, single instance
    src/main.rs
    tauri.conf.json             # frontendDist -> ../../../Web/web/dist
    capabilities/
  scripts/prune-dist.mjs        # drops the web-only payload before it is embedded
  package.json                  # build scripts only; no UI code lives here

Web/web/src/platform/desktop.ts          # the adapter: host detection, menu, panels, drops
Web/web/src/app/components/DesktopHost.tsx
```

The adapter deliberately lives with the UI rather than here: it is the half that has to
change whenever a menu item or a tool screen changes, and it is tested by the web repo's
own suite.

- **Frontend:** `beforeBuildCommand` builds `Web/web` (with `VITE_DISABLE_PWA=true` so the
  service worker never fights the packaged assets), `frontendDist` points at that `dist/`.
  One build, one place where a tool is written.
- **Adapter, not a fork:** a small `desktop` module in `Web/web` detects the Tauri host
  (`window.__TAURI_INTERNALS__` / `isTauri()`), and only then (a) hides web-only routes,
  (b) routes open/save through native panels, (c) registers the desktop shortcut map,
  (d) accepts OS file drops into the input pane.
- **Native shell owns:** app menu (⌘K quick open, ⌘O open, ⌘S save result, ⌘, settings,
  ⌘1–9 documents), single instance, window state, file associations, optional tray item for
  a future Quick Tool, updater (signed artifacts, static manifest on GitHub Releases).
- **Capabilities:** allow only the plugins actually used; no shell/exec permissions; the
  app remains local-only, so no network capability beyond the updater.

---

## 5. Minor design tweaks for the desktop workflow

The user-facing instruction is "minor tweaks, not a redesign", so the desktop build reuses
`src/app/styles/tokens.css` and the `wb-*` primitives as-is and applies only:

1. **Window, not page.** Set a minimum window size, restore size and position, keep native
   decorations. A single window is the product; the tab strip becomes document switching
   inside it.
2. **Drop the web-only surfaces.** Landing page, marketing routes, legal pages, SEO
   prerender, PWA install prompt, analytics banner — none of them belong in an installed
   app. Legal text moves to the About/Settings surface.
3. **Native menu replaces the topbar's app-level actions.** Search (⌘K), settings, theme
   and the destination links live in the menu bar and/or sidebar; the web topbar keeps only
   document-level actions.
4. **Desktop shortcut map.** ⌘/Ctrl per platform, ⌘K quick open, ⌘O open file, ⌘S save
   result, ⌘1–9 documents, ⌥⌘W close, ⌘, settings. The existing web map is a close match
   and only needs platform symbol substitution.
5. **Native file IO and drops.** Open/save through the OS panels; dragging a file onto the
   window loads it into the active tool, the way the SwiftUI app's ⌘O and file drop behave.
6. **Offline and privacy copy stays, in the desktop wording.** The web app says "Local
   only"; the installed app should say the same in one line in Settings, plus the existing
   privacy statement, since there is no longer a page it could be sending data to.
7. **Typography/colour unchanged.** No new tokens. If a desktop-only affordance needs a
   value (e.g. a title-bar inset), add a semantic token rather than an inline value. The
   authority is the web design system (`Web/web/src/app/styles/tokens.css` plus the
   `wb-*` primitives); the macOS design system this section originally pointed at was
   retired with the app.

---

## 6. Risks and what has to be tested

| Risk                                  | Detail                                                                                                                                                                 | Mitigation |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Three web engines, one UI             | WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux; Linux version varies by distro and NVIDIA/compositing bugs are documented ([Linux graphics](https://v2.tauri.app/develop/debug/linux-graphics/)) | Test the packaged app, not the browser, on each OS; pick an explicit Linux baseline (Ubuntu 22.04 / Debian 12 per [Tauri's guide](https://v2.tauri.app/distribute/debian/)) |
| Windows WebView2 may be absent        | Installer defaults to `downloadBootstrapper`; offline machines need `offlineInstaller` (+~127 MB) ([docs](https://v2.tauri.app/distribute/windows-installer/)) | Decide installer mode before release; NSIS per-user install needs no admin rights |
| Signing costs and reputation          | Apple: $99/yr, notarization required. Windows: OV cert ~$150–300/yr; SmartScreen reputation still accumulates ([Microsoft](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)) | Budget it; unsigned Windows first-run triggers "Windows protected your PC" |
| Updater key management                | Tauri's updater requires signed artifacts and cannot disable verification ([updater](https://v2.tauri.app/plugin/updater/)) | Generate the key pair once, store it as a CI secret; losing it strands users |
| Toolchain creep                       | A Rust toolchain becomes mandatory in dev and CI (Rust 1.90 MSRV as of 2.12) | Fine here — cargo 1.99 is already installed locally |
| Editor/result parity for big payloads | The SwiftUI app had AppKit editors and 50 MB import guards; WKWebView CodeMirror will behave differently | The same 50 MB ceiling is enforced in the shell (`MAX_TEXT_BYTES`), so the host never hands the workspace a payload the workspace refuses |

---

## 7. Decision

Taken 14 October 2026:

1. **Option B — Tauri 2 for macOS, Windows and Linux.** As written, the SwiftUI app in
   `Desktop/desktop` was to be frozen as the reference implementation of "native"; it was
   in fact deleted outright, so Tauri is the only desktop app. See §8.
2. **A separate host folder and repo** — `Desktop/desktop-tauri`, standalone, because
   `Desktop/desktop` was already the macOS app's own repo.
3. **The desktop build may diverge at the route level.** The marketing page, the SEO
   shell, the PWA install prompt and analytics are web-only; `/privacy` and `/terms`
   stay, linked from Settings.

The scaffold is in [README.md](../README.md), which also
records the shell↔workspace contract, the desktop deltas and what is still unbuilt
(updater, signing, Windows/Linux verification). The CSP it lists as unbuilt is now set.

Sources: Tauri docs (architecture, config, capabilities, menus, tray, dialog, updater,
window state, single instance, webview versions, Linux graphics, Windows installer, Debian
packaging, release pages), Electron docs (why Electron, process model, code signing),
Microsoft (WebView2 distribution, code-signing options), WebKit/Safari 26 release notes.

---

## 8. Update — the SwiftUI app was deleted

The macOS app was removed rather than frozen. Two things recorded above are therefore no
longer true, and this section supersedes them:

1. **§4's layout.** The adapter never lived in the host folder: there is no `src/` there.
   Host detection, the menu, the OS panels and file drops are wired in the web repo —
   `Web/web/src/platform/desktop.ts` and `Web/web/src/app/components/DesktopHost.tsx` —
   because the contract belongs to the half that has to change when a menu item is added,
   and the web repo is the half with a test suite and CI. The host owns only Rust.
2. **§5's references to the macOS app.** Its PRD and design system were deleted with it,
   so the web design system is the only visual authority now.

What the deletion changed in practice: nothing in the shipped app. It removes the
temptation §3 warned about — a second catalogue to keep in step — and it removes
`Desktop/desktop` as the place a "more native" argument could be reopened from.

The Swift code is archived in [archive/](archive): a git bundle with the complete history,
plus a patch of the two files that were uncommitted when it was removed.
