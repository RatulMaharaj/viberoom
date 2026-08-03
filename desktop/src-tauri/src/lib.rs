//! Tauri shell for viberoom.
//!
//! Launches the PyInstaller-frozen backend as a sidecar on a free localhost
//! port, waits for it to accept connections, then navigates the app window
//! to it. The backend serves both the REST API and the built SPA, so the
//! frontend needs no changes to run inside the desktop app.

use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

struct Backend(Mutex<Option<CommandChild>>);

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("bind to a free port")
        .local_addr()
        .expect("read local addr")
        .port()
}

fn wait_for_backend(port: u16, timeout: Duration) -> bool {
    let addr = format!("127.0.0.1:{port}").parse().unwrap();
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Backend(Mutex::new(None)))
        .setup(|app| {
            let port = free_port();

            let (_rx, child) = app
                .shell()
                .sidecar("viberoom-backend")
                .expect("sidecar binary missing — run desktop/build-backend.sh first")
                .env("VIBEROOM_PORT", port.to_string())
                .spawn()
                .expect("failed to spawn viberoom backend");
            *app.state::<Backend>().0.lock().unwrap() = Some(child);

            // Show the bundled loading splash immediately, then navigate to the
            // backend once it accepts connections (onefile PyInstaller binaries
            // can take a few seconds to self-extract on first launch).
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Viberoom")
                .inner_size(1280.0, 820.0)
                .min_inner_size(900.0, 600.0)
                .build()?;

            std::thread::spawn(move || {
                if wait_for_backend(port, Duration::from_secs(60)) {
                    let _ = win.eval(&format!(
                        "window.location.replace('http://127.0.0.1:{port}/')"
                    ));
                } else {
                    let _ = win.eval("document.body.classList.add('failed')");
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // make sure the sidecar dies with the app
                if let Some(child) = app.state::<Backend>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
