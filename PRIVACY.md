# PRIVACY.md — the privacy charter (desktop shell)

> **Read me before changing:** Tauri capabilities, the CSP, file access, external
> links, plugins, or anything that could send data. This repo is half of one
> product: the canonical charter (`Web/web/PRIVACY.md`) governs the workspace this
> shell bundles; this file restates the rules that live here and points to the
> canonical file for the rest. Not the legal policy — that renders at `/privacy`
> inside the app.

**Status:** adopted 16 October 2026 · companion charter: `Web/web/PRIVACY.md` (canonical).

## 1. What the promises mean on this side

- **D1 — Zero egress.** The shell makes no network requests of its own: no updater, no crash reporter, no remote config, no telemetry. The bundled workspace ships with analytics removed (decision 2026-10-16 — mirror of the web decision). Network features exist only where the user drives them (the bundled API/WebSocket tools, exactly as in the browser).
- **D2 — Minimal capabilities.** `src-tauri/capabilities/default.json` grants exactly `core:event:allow-listen` and `core:event:allow-unlisten`. No fs, http, shell, dialog, window, path, or menu API is reachable from the page. The shell's own commands (file panels, pending-path intake) are ACL-exempt by design — treat their surface as equally sensitive.
- **D3 — OS-handed paths only.** The shell reads a file only when the OS handed it the path (open-with, argv, drag-drop) or the user picked it in a native panel. `KnownPaths` records what was handed and refuses everything else. Ceiling: 50 MB per text file (`MAX_TEXT_BYTES`), UTF-8 only.
- **D4 — Content is memory-only.** Files bridged to the page are never written to shell-side disk, caches, or logs beyond the user's explicit save. Errors must not contain file contents.
- **D5 — Local data stays local.** Window geometry (window-state plugin) and the webview's storage live on the user's disk; nothing syncs anywhere.

## 2. Read-trigger table — if you are about to touch X, do Y

| About to touch… | Read | Run before reporting done | Never |
| --- | --- | --- | --- |
| `src-tauri/capabilities/default.json` | §3.1 | `cargo test` + capability assertions (T3.1, planned) | add permissions or widen the window list without a decision |
| `src-tauri/tauri.conf.json` (CSP, windows, bundle, associations) | §3.2 | `npm run check` + the CSP parity check (T1.8, planned) | widen the CSP; drop `frame-src` / `object-src` / `base-uri` closures |
| `src-tauri/src/main.rs` (commands, file IO) | §3.3 | `cargo test` (file-IO refusals + read allowlist) | bypass `KnownPaths`; raise ceilings silently; log contents |
| build scripts (`scripts/prune-dist.mjs`, the desktop build) | §3.4 | the no-telemetry bundle scan (T3.2, planned) | ship a build with analytics env vars or remote code |
| `.github/workflows/desktop.yml` (release) | §3.5 | the full desktop workflow | publish past a failed check; add signing secrets without a decision |
| dependencies (`Cargo.toml`, `package.json`) | §3.6 | review + `cargo check` | plugins that load remote code or phone home |

## 3. Surface rules

### 3.1 Capabilities

- The permission list changes only with a maintainer decision + an updated capability assertion. Every new permission needs a justification paragraph in the PR.
- `withGlobalTauri` exposes the API bridge to the page; the ACL is what keeps it harmless. Never rely on "the page won't call it" for something a capability grants.

### 3.2 CSP

- `connect-src` carries the shell's IPC endpoints (`ipc:`, `http://ipc.localhost` — not the network) plus `https:`/`wss:` for the two bundled tools the user drives (API Request Builder, WebSocket tester — the web allowance, mirrored; F2). Keep the rest in the web CSP's spirit: `script-src 'self'`, `frame-src` / `object-src` / `base-uri` `'none'`.
- `dangerousDisableAssetCspModification: ["style-src"]` is a CodeMirror accommodation — keep it scoped to `style-src` only.
- Any web CSP change that affects the bundled app arrives here via `build:desktop`; verify both files together (drift test, planned).

### 3.3 File access

- `KnownPaths` + the 50 MB / UTF-8 ceilings are the contract. New file situations (new associations, new commands) update the tests in the same change.
- Refusals are silent to the app and explicit to the user; they never include file contents.

### 3.4 Build & bundling

- `build:desktop` runs the web repo's desktop build, then `prune-dist.mjs`. The web analytics channel was removed on 2026-10-16 (`Web/web/PRIVACY.md` §6) — there are no analytics env vars left to set — and the bundle scan (T3.2, planned) makes the no-telemetry property provable, not just true.

### 3.5 Release integrity

- The workflow deliberately declares no Apple signing secrets (there is no certificate). DMGs are unsigned and notarization-free today; the Homebrew cask workaround (quarantine strip) and placeholder checksums are registered debt (§5). **Decision 2026-10-16: no Homebrew/signing work now.**

### 3.6 Dependencies

- Web repo §4.6 rules apply: nothing that loads remote code, bundles analytics, or phones home. Plugins (`dialog`, `single-instance`, `window-state`) are part of the capability story — review them as a set.

## 4. Tests — what to run, when

- `cargo test --manifest-path src-tauri/Cargo.toml` — file-IO refusals + read allowlist (every PR).
- `npm run check` — the shell compiles (every PR).
- `npm run verify` — the packaged app renders in a real webview (advisory, macOS CI).
- `npm run verify:editor` — CodeMirror under the app CSP in WebKit (PRs touching CSP/editor paths).
- Planned: T3.1 capability/CSP snapshot assertions; T3.2 desktop no-telemetry bundle scan — both gate releases once they land.

CI (`desktop.yml`) runs these across four targets on PRs and builds release artifacts on tags.

## 5. Debt register

| Debt | Accepted because | Revisit when |
| --- | --- | --- |
| `https:`/`wss:` allowed in `connect-src` (web parity, F2) | the bundled network tools send to user-typed hosts; static CSP cannot scope per-route | a per-route CSP or bundled-tools isolation lands |
| Unsigned/unnotarized DMGs; Homebrew cask quarantine workaround; placeholder checksums | no Developer ID certificate; deferred 2026-10-16 ("no Homebrew now") | signing is planned or the distribution channel requires it |
| Capability/CSP snapshot + no-telemetry scan not yet automated | planned with the privacy test programme | T3.1/T3.2 land — then delete this row |
| `style-src 'unsafe-inline'` allowance | CodeMirror runtime styles | editor styling changes |

## 6. Decisions

| Date | Decision | Status |
| --- | --- | --- |
| 2026-10-16 | Product-wide no analytics — the web Option A removal applies to everything this shell bundles. | implemented on the web side 2026-10-16 — mirrors `Web/web/PRIVACY.md` §6 |
| 2026-10-16 | Mirror the web `connect-src` allowances (`https:`, `wss:`) so the bundled API/WebSocket tools work here exactly as in the browser. | implemented 2026-10-16 |
| 2026-10-16 | No Homebrew/signing work now; distribution stays DMG-first. | standing until revisited |

## 7. Escalation

- If a task needs a new capability, a CSP relaxation, a new plugin, or any silent egress: **stop and ask the maintainer.**
- Never weaken or skip a privacy check (`cargo test`, the editor-CSP check, capability assertions) to make a build pass.
- Never add signing/release credentials without an explicit decision.
