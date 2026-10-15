// Prevents an extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The Toolbit desktop shell.
//!
//! The interface is the web workspace, bundled into the app: this crate owns
//! only the things a browser cannot give it — the native menu bar, native
//! open/save panels, single-instance behaviour, window state, and the file
//! paths the OS hands us through file associations or drag-and-drop.
//!
//! The contract with the frontend is deliberately tiny and lives in two places:
//!
//! * events emitted *to* the workspace: `toolbit://menu/*` for menu commands and
//!   `toolbit://open-path` for a path the OS wants opened;
//! * commands invoked *from* the workspace: `open_text_file`, `save_text_file`,
//!   `read_text_file` and `take_pending_open_path`.
//!
//! `Web/web/src/platform/desktop.ts` mirrors this list. Change one, change
//! both.
//!
//! `--verify` loads the workspace, asserts it rendered inside the system
//! webview, prints one line and exits. It is the desktop counterpart of the
//! macOS app's `--verify-shell`, and the only way to test the packaged app
//! without a human looking at it.

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};

use serde::Serialize;
use tauri::{
    menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    Emitter, Manager, RunEvent,
};
use tauri_plugin_dialog::DialogExt;

/// One ceiling for the whole app, matching the web build's import guard so the
/// desktop host never hands the workspace a payload the workspace refuses.
const MAX_TEXT_BYTES: u64 = 50 * 1024 * 1024;

const MENU_QUICK_OPEN: &str = "toolbit://menu/quick-open";
const MENU_SETTINGS: &str = "toolbit://menu/settings";
const MENU_OPEN_FILE: &str = "toolbit://menu/open-file";
const MENU_SAVE_RESULT: &str = "toolbit://menu/save-result";
const MENU_CLOSE_DOCUMENT: &str = "toolbit://menu/close-document";
const OPEN_PATH: &str = "toolbit://open-path";

/// Paths the OS handed us before the workspace was listening. A second launch,
/// a file association and a command-line argument all arrive this way, and the
/// workspace drains the queue once it mounts.
#[derive(Default)]
struct PendingOpen(Mutex<Vec<String>>);

/// Every path the OS has supplied — a command-line argument, a file
/// association, or a drop onto the window.
///
/// The workspace reads files back over IPC, and this is what keeps
/// `read_text_file` from being a general "read any file the user can read"
/// primitive: the app parses untrusted documents (JSON, YAML, XML, Markdown) in
/// the same process as the webview, so an injection there must not become file
/// disclosure. Only what the OS itself offered is readable.
#[derive(Default)]
struct KnownPaths(Mutex<HashSet<PathBuf>>);

impl KnownPaths {
    fn remember(&self, path: &Path) {
        if let Ok(mut known) = self.0.lock() {
            known.insert(path.to_path_buf());
        }
    }

    fn contains(&self, path: &Path) -> bool {
        self.0.lock().map(|known| known.contains(path)).unwrap_or(false)
    }
}

/// Records a path the OS gave us, so the workspace is later allowed to read it.
fn remember_known_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>, path: &Path) {
    if let Some(known) = app.try_state::<KnownPaths>() {
        known.remember(path);
    }
}

/// Set by `--verify`. The probe below reports into it exactly once.
#[derive(Default)]
struct Verify(AtomicBool);

impl Verify {
    fn requested() -> bool {
        std::env::args().any(|argument| argument == "--verify")
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct OpenedFile {
    path: String,
    name: String,
    contents: String,
}

/// Every failure here is a sentence the workspace can show the user: they are
/// the desktop counterparts of the web app's import diagnostics.
fn read_text(path: &Path) -> Result<OpenedFile, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("{}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err("Choose a text file".into());
    }
    if metadata.len() > MAX_TEXT_BYTES {
        return Err("The file exceeds the supported 50 MB limit".into());
    }
    let bytes = fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let contents = String::from_utf8(bytes).map_err(|_| "Choose a UTF-8 text file".to_string())?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string());
    Ok(OpenedFile {
        path: path.display().to_string(),
        name,
        contents,
    })
}

#[tauri::command]
async fn read_text_file(
    path: String,
    known: tauri::State<'_, KnownPaths>,
) -> Result<OpenedFile, String> {
    let requested = PathBuf::from(&path);
    // Scoped so the guard is not held while the file is read.
    let allowed = known.contains(&requested);
    if !allowed {
        return Err("That file was not opened from the desktop.".into());
    }
    read_text(&requested)
}

/// Native open panel. Runs as an async command so the blocking panel call sits
/// on Tauri's async runtime rather than the main thread.
#[tauri::command]
async fn open_text_file(app: tauri::AppHandle) -> Result<Option<OpenedFile>, String> {
    let Some(picked) = app.dialog().file().blocking_pick_file() else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|error| error.to_string())?;
    read_text(&path).map(Some)
}

#[tauri::command]
async fn save_text_file(
    app: tauri::AppHandle,
    default_name: String,
    contents: String,
) -> Result<Option<String>, String> {
    let Some(picked) = app.dialog().file().set_file_name(default_name).blocking_save_file() else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|error| error.to_string())?;
    fs::write(&path, contents.as_bytes()).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(Some(path.display().to_string()))
}

/// First path waiting to be opened, if any. Oldest first, so a double-click on
/// three files opens them in the order the OS delivered them.
#[tauri::command]
fn take_pending_open_path(state: tauri::State<'_, PendingOpen>) -> Option<String> {
    let mut paths = state.0.lock().ok()?;
    if paths.is_empty() {
        None
    } else {
        Some(paths.remove(0))
    }
}

/// Queues anything in `argv` that is an existing file and tells a running
/// workspace about it.
fn remember_paths<R: tauri::Runtime>(app: &tauri::AppHandle<R>, argv: &[String]) {
    let pending = app.state::<PendingOpen>();
    let Ok(mut queue) = pending.0.lock() else {
        return;
    };
    for argument in argv.iter().skip(1) {
        let path = PathBuf::from(argument);
        if path.is_file() {
            let display = path.display().to_string();
            queue.push(display.clone());
            remember_known_path(app, &path);
            let _ = app.emit(OPEN_PATH, display);
        }
    }
}

/// Runs inside the webview under `--verify`: reports what the workspace
/// actually rendered, over the same IPC the app uses in normal operation.
///
/// Deliberately small. Anything beyond "did the interface mount, and can it reach
/// the shell" belongs in `scripts/editor-check.mjs`, which drives the same build
/// in Playwright's WebKit and can assert on computed styles: an injected script
/// here reports nothing at all when `invoke` fails, which is indistinguishable
/// from a page that never loaded.
const VERIFY_PROBE: &str = r#"
setTimeout(async () => {
  const report = (fields) => window.__TAURI__.core.invoke('verify_report', fields);
  const found = {
    title: document.title,
    shell: document.querySelectorAll('.wb-shell').length,
    rail: document.querySelectorAll('nav[aria-label="Primary"] button').length,
    screens: document.querySelectorAll('main').length,
    text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 120),
  };
  // The workspace's one real capability: if the ACL or the CSP is wrong, the
  // native menu, file associations and drops all go silent, and rendering alone
  // would still look healthy.
  let bridge = false;
  try {
    const unlisten = await window.__TAURI__.event.listen('toolbit://verify', () => {});
    if (typeof unlisten === 'function') unlisten();
    bridge = true;
  } catch (error) {
    bridge = false;
  }
  try {
    report({ ...found, bridge });
  } catch (error) {
    report({ ...found, bridge: false, text: 'probe failed: ' + error });
  }
}, 2500);
"#;

#[derive(serde::Deserialize)]
struct VerifyReport {
    title: String,
    shell: usize,
    rail: usize,
    screens: usize,
    text: String,
    /// Whether the workspace could register a listener with the shell.
    bridge: bool,
}

/// Reports the probe result, then exits with a status a script can read.
///
/// A packaged desktop app has no unit-testable seam for "did the interface
/// render", so this is the seam: it fails if the shell, the navigation rail or
/// the workspace screen is missing, if the window still carries the web page's
/// SEO title, or if the workspace cannot reach the shell's event API.
#[tauri::command]
fn verify_report(state: tauri::State<'_, Verify>, report: VerifyReport) {
    if state.0.swap(true, Ordering::SeqCst) {
        return;
    }
    let problems: Vec<String> = [
        (report.title != "Toolbit", format!("title is {:?}", report.title)),
        (report.shell < 1, "workspace shell did not render".into()),
        (report.rail < 5, format!("navigation rail has {} buttons", report.rail)),
        (report.screens < 1, "no screen rendered".into()),
        (
            !report.bridge,
            "the workspace could not reach the shell's event API (capability or CSP)".into(),
        ),
    ]
    .into_iter()
    .filter_map(|(failed, message)| failed.then_some(message))
    .collect();

    if problems.is_empty() {
        println!("ToolbitVerify: rendered {} — {}", report.title, report.text);
        std::process::exit(0);
    }
    eprintln!("ToolbitVerify: failed — {}", problems.join("; "));
    eprintln!("ToolbitVerify: text — {}", report.text);
    std::process::exit(1);
}

/// The menu bar. Ids are the event names, so `on_menu_event` can forward them
/// without a lookup table.
fn build_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    let settings = MenuItemBuilder::with_id(MENU_SETTINGS, "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let quick_open = MenuItemBuilder::with_id(MENU_QUICK_OPEN, "Quick Open…")
        .accelerator("CmdOrCtrl+K")
        .build(app)?;
    let open_file = MenuItemBuilder::with_id(MENU_OPEN_FILE, "Open…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let save_result = MenuItemBuilder::with_id(MENU_SAVE_RESULT, "Save Result…")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let close_document = MenuItemBuilder::with_id(MENU_CLOSE_DOCUMENT, "Close Document")
        .accelerator("Alt+CmdOrCtrl+W")
        .build(app)?;

    // macOS puts Settings and Quit in the application menu; Windows and Linux
    // have no such menu, so they get the same commands under File instead.
    #[cfg(target_os = "macos")]
    let app_menu = SubmenuBuilder::new(app, "Toolbit")
        .item(&PredefinedMenuItem::about(
            app,
            None,
            Some(AboutMetadata::default()),
        )?)
        .separator()
        .item(&settings)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    #[cfg(not(target_os = "macos"))]
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&open_file)
        .item(&save_result)
        .item(&settings)
        .separator()
        .item(&close_document)
        .separator()
        .quit()
        .build()?;

    #[cfg(target_os = "macos")]
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&open_file)
        .item(&save_result)
        .separator()
        .item(&close_document)
        .build()?;

    // Predefined Edit items are what make the native clipboard, undo and
    // selection shortcuts work inside the web editors.
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "View").item(&quick_open).build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    let mut menu = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    {
        menu = menu.item(&app_menu);
    }
    menu.items(&[&file_menu, &edit_menu, &view_menu, &window_menu])
        .build()
}

fn main() {
    let verifying = Verify::requested();

    let mut builder = tauri::Builder::default();

    // A verify run has to own its own window. Registered normally it would
    // delegate to an instance that is already running, and this process would
    // exit 0 having tested nothing — a false pass, which is worse than having no
    // check at all. Locally that is easy to hit: closing the window only hides
    // it on macOS, so an instance is often still alive.
    if !verifying {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            remember_paths(app, &argv);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        // Size, position and maximized state are remembered; visibility and
        // fullscreen deliberately are not, even though the plugin's default is
        // `StateFlags::all()`. Closing the window hides it on macOS, so the last
        // state written before a quit can be "invisible" — restoring that gives
        // a running app with no window. Restoring fullscreen is almost as bad:
        // the app then owns a whole Space every launch. The config's own window
        // is the fallback, and it is visible and windowed.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::DECORATIONS,
                )
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .manage(PendingOpen::default())
        .manage(KnownPaths::default())
        .manage(Verify::default())
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            open_text_file,
            save_text_file,
            take_pending_open_path,
            verify_report
        ])
        .on_page_load(move |window, _payload| {
            if verifying {
                let _ = window.eval(VERIFY_PROBE);
            }
        })
        // `move` because `verifying` is read here: without it the closure
        // borrows a local it cannot outlive, and the shell fails to compile.
        .setup(move |app| {
            app.set_menu(build_menu(app.handle())?)?;
            let argv: Vec<String> = std::env::args().collect();
            remember_paths(app.handle(), &argv);
            if verifying {
                // A probe that never reports must fail rather than hang a
                // release check.
                std::thread::spawn(|| {
                    std::thread::sleep(Duration::from_secs(20));
                    eprintln!("ToolbitVerify: failed — the workspace did not report within 20s");
                    std::process::exit(1);
                });
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            let _ = app.emit(event.id().as_ref(), ());
        })
        // Closing the window means different things on either side of the fence.
        // macOS keeps the app alive behind its Dock icon and `RunEvent::Reopen`
        // brings the window back, so closing hides it. Windows and Linux have no
        // such event and no tray, so hiding would leave the app running with no
        // way back: let the window close and the app exit with it.
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }

            // Drops reach the workspace as `tauri://drag-drop`, which means the
            // shell is never told about them any other way — but they are
            // OS-supplied paths, and the allowlist has to know them before the
            // workspace may read them back.
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                for path in paths {
                    remember_known_path(window.app_handle(), path);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Toolbit desktop shell")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            match event {
                // macOS delivers file-association opens here rather than as argv.
                RunEvent::Opened { urls } => {
                    for url in urls {
                        if let Ok(path) = url.to_file_path() {
                            remember_known_path(app, &path);
                            let _ = app.emit(OPEN_PATH, path.display().to_string());
                        }
                    }
                }
                // Dock icon click with the window closed or hidden.
                RunEvent::Reopen { .. } => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                _ => {}
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Writes a file under a per-process directory so parallel tests never
    /// collide and nothing has to be cleaned up between runs.
    fn temp_file(name: &str, bytes: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("toolbit-shell-tests-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join(name);
        let mut file = fs::File::create(&path).expect("temp file");
        file.write_all(bytes).expect("write");
        path
    }

    #[test]
    fn reads_text_with_the_file_name_as_the_label() {
        let path = temp_file("invoice.json", br#"{"total":42}"#);
        let opened = read_text(&path).expect("reads a UTF-8 file");
        assert_eq!(opened.name, "invoice.json");
        assert_eq!(opened.contents, r#"{"total":42}"#);
        assert!(opened.path.ends_with("invoice.json"));
    }

    /// The refusals are the user-facing sentences the workspace shows, so they
    /// are part of the contract rather than incidental error text.
    #[test]
    fn refuses_non_utf8_content_with_an_actionable_message() {
        let path = temp_file("binary.bin", &[0xff, 0xfe, 0x00, 0x01]);
        assert_eq!(
            read_text(&path).unwrap_err(),
            "Choose a UTF-8 text file".to_string()
        );
    }

    #[test]
    fn refuses_a_directory() {
        let dir = std::env::temp_dir().join("toolbit-shell-tests-dir");
        fs::create_dir_all(&dir).expect("temp dir");
        assert_eq!(read_text(&dir).unwrap_err(), "Choose a text file".to_string());
    }

    #[test]
    fn reports_a_missing_path_instead_of_panicking() {
        let missing = std::env::temp_dir().join("toolbit-shell-tests-missing.json");
        let error = read_text(&missing).unwrap_err();
        assert!(error.contains("toolbit-shell-tests-missing.json"), "{error}");
    }

    #[test]
    fn only_existing_files_are_queued_from_the_command_line() {
        let path = temp_file("queued.json", b"{}");
        let app = tauri::test::mock_app();
        app.manage(PendingOpen::default());
        remember_paths(
            app.handle(),
            &[
                "Toolbit".to_string(),
                "--flag".to_string(),
                path.display().to_string(),
                "/definitely/not/here.json".to_string(),
            ],
        );
        let queue = app.state::<PendingOpen>();
        let queued = queue.0.lock().expect("queue");
        assert_eq!(queued.len(), 1, "only the real file should be queued");
        assert!(queued[0].ends_with("queued.json"));
    }

    /// The allowlist is what stops `read_text_file` from being a general file
    /// reader for anything injected into the webview.
    #[test]
    fn only_paths_the_os_supplied_become_readable() {
        let path = temp_file("allowed.json", b"{}");
        let known = KnownPaths::default();
        assert!(!known.contains(&path), "unknown paths start unreadable");
        known.remember(&path);
        assert!(known.contains(&path), "an OS-supplied path becomes readable");
        assert!(!known.contains(Path::new("/etc/passwd")));
    }
}
