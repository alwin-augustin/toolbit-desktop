# AGENTS.md

This repo is the Tauri desktop shell for Toolbit. The canonical privacy charter lives in the web repo (`Web/web/PRIVACY.md`); this repo has its own companion (`PRIVACY.md`) — read it before touching capabilities, the CSP, file access, external links, or dependencies.

## Privacy — non-negotiable, applies to ALL tasks

- Zero egress: no updater, no crash reporter, no telemetry, no remote config — the shell never talks to the network.
- Capabilities stay minimal (`core:event:allow-listen` / `allow-unlisten`). No fs/http/shell/dialog/window API reachable from the page — never extend the capability or command surface silently.
- Files flow only through OS-handed paths (open-with, argv, drag-drop) and native panels — via `KnownPaths`; 50 MB / UTF-8 ceilings; contents never logged.
- The bundled workspace ships with analytics removed (product-wide decision 2026-10-16). Never set analytics env vars in desktop builds.
- The CSP in `src-tauri/tauri.conf.json` moves in lockstep with the web CSP — never widen it silently.

## Before touching these — read PRIVACY.md first

`src-tauri/capabilities/default.json` · `src-tauri/tauri.conf.json` · `src-tauri/src/main.rs` · build and release scripts · plugin dependencies.

## Never

- Add a capability, plugin, or command that sends data or widens file access without a recorded decision.
- Weaken or skip a privacy check (`cargo test`, the editor-CSP check, capability assertions) to make a build pass.
- Add signing or release credentials without the maintainer's decision.
- If a task cannot be done without one of these: stop and ask.
