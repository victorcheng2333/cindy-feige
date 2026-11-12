#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth;
mod device_link;
mod endpoints;
mod model;
mod service;
mod storage;
#[cfg(test)]
mod tests;

use crate::auth::{HttpAuthClient, OpenUrlFn};
use crate::endpoints::{endpoints, APP_VERSION};
use crate::model::{
    demo_snapshot, tray_window_position, validate_command, Command, IntRect, Snapshot,
};
use crate::service::{UsageService, UsageServiceDeps};
use crate::storage::{load_device_id, EncryptedSessionStore};
#[cfg(target_os = "macos")]
use crate::storage::KeychainCipher;
use std::fs::{File, OpenOptions};
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::window::Color;
use tauri::{
    AppHandle, Emitter, LogicalPosition, Manager, Position, Rect, RunEvent, Size, State, Theme,
    WindowEvent,
};
use url::Url;
use uuid::Uuid;

static TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/trayTemplate@2x.png");
static APP_ICON_PNG: &[u8] = include_bytes!("../icons/icon.png");

struct UiRuntimeState {
    ready: bool,
    state_queried: bool,
    was_signed_in: bool,
    tray: Option<TrayIcon>,
    last_tray_rect: Option<Rect>,
    last_tray_interaction: Option<Instant>,
    last_left_click_up: Option<Instant>,
}

struct AppState {
    demo: bool,
    smoke_exit_ms: Option<u64>,
    qa_profile: Option<PathBuf>,
    _lock_file: Option<File>,
    quitting: Arc<AtomicBool>,
    window_visible: Arc<AtomicBool>,
    service: Option<Arc<UsageService>>,
    ui: Arc<StdMutex<UiRuntimeState>>,
}

impl AppState {
    async fn current_snapshot(&self) -> Snapshot {
        if self.demo {
            demo_snapshot()
        } else if let Some(svc) = &self.service {
            svc.snapshot().await
        } else {
            Snapshot::initial()
        }
    }
}

fn rect_to_logical_int(rect: &Rect, scale: f64) -> IntRect {
    let s = if scale > 0.0 { scale } else { 1.0 };
    let (x, y) = match rect.position {
        Position::Physical(p) => ((p.x as f64 / s).round() as i32, (p.y as f64 / s).round() as i32),
        Position::Logical(l) => (l.x.round() as i32, l.y.round() as i32),
    };
    let (width, height) = match rect.size {
        Size::Physical(sz) => (
            (sz.width as f64 / s).round() as i32,
            (sz.height as f64 / s).round() as i32,
        ),
        Size::Logical(sz) => (sz.width.round() as i32, sz.height.round() as i32),
    };
    IntRect {
        x,
        y,
        width,
        height,
    }
}

fn show_window(app: &AppHandle, anchored: bool) {
    let state = app.state::<AppState>();
    let (ready, tray_rect) = {
        let ui = state.ui.lock().unwrap();
        (ui.ready, ui.last_tray_rect)
    };
    if !ready {
        return;
    }
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    if w.is_minimized().unwrap_or(false) {
        let _ = w.unminimize();
    }
    if anchored {
        if let Some(tr) = tray_rect {
            let monitor = match tr.position {
                Position::Physical(p) => app.monitor_from_point(p.x as f64, p.y as f64).ok().flatten(),
                Position::Logical(l) => app.monitor_from_point(l.x, l.y).ok().flatten(),
            }
            .or_else(|| w.current_monitor().ok().flatten())
            .or_else(|| app.primary_monitor().ok().flatten());

            if let (Some(mon), Ok(win_size)) = (monitor, w.outer_size()) {
                let scale = mon.scale_factor();
                let tray_dip = rect_to_logical_int(&tr, scale);
                let wa = mon.work_area();
                let work_dip = IntRect {
                    x: (wa.position.x as f64 / scale).round() as i32,
                    y: (wa.position.y as f64 / scale).round() as i32,
                    width: (wa.size.width as f64 / scale).round() as i32,
                    height: (wa.size.height as f64 / scale).round() as i32,
                };
                let size_dip = (
                    (win_size.width as f64 / scale).round() as i32,
                    (win_size.height as f64 / scale).round() as i32,
                );
                let (lx, ly) = tray_window_position(tray_dip, work_dip, size_dip);
                let _ = w.set_position(LogicalPosition::new(lx as f64, ly as f64));
            }
        }
    }
    state.window_visible.store(true, Ordering::SeqCst);
    let _ = w.show();
    let _ = w.set_focus();

    if !state.demo {
        if let Some(svc) = state.service.clone() {
            tauri::async_runtime::spawn(async move {
                svc.refresh().await;
            });
        }
    }
}

fn hide_window(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.window_visible.store(false, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

fn request_quit(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.quitting.store(true, Ordering::SeqCst);
    state.window_visible.store(false, Ordering::SeqCst);
    let svc = state.service.clone();
    let qa_dir = state.qa_profile.clone();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(s) = svc {
            s.dispose().await;
        }
        if let Some(dir) = qa_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
        handle.exit(0);
    });
}

fn publish_snapshot(app: &AppHandle, snapshot: Snapshot) {
    let _ = app.emit("cat:state", snapshot.clone());
    let tooltip = if snapshot.signed_in {
        let online_count = snapshot.devices.iter().filter(|d| d.online).count();
        format!("猫猫 · {online_count} 台电脑在线")
    } else {
        "猫猫 · 远程订阅额度".to_string()
    };

    let (just_signed_in, ready, tray) = {
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        let mut ui = state.ui.lock().unwrap();
        let just = snapshot.signed_in && !ui.was_signed_in;
        ui.was_signed_in = snapshot.signed_in;
        (just, ui.ready, ui.tray.clone())
    };

    if let Some(tray_icon) = tray {
        // Update tooltip off any potential main-thread callback to avoid re-entrancy.
        std::thread::spawn(move || {
            let _ = tray_icon.set_tooltip(Some(tooltip));
        });
    }

    if just_signed_in && ready {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            show_window(&handle, false);
        });
    }
}

fn mark_webview_milestone(app: &AppHandle, state: &AppState, ready_now: bool, state_now: bool) {
    let trigger_ms = {
        let mut ui = state.ui.lock().unwrap();
        let was_complete = ui.ready && ui.state_queried;
        if ready_now {
            ui.ready = true;
        }
        if state_now {
            ui.state_queried = true;
        }
        if state.demo && !was_complete && ui.ready && ui.state_queried {
            state.smoke_exit_ms
        } else {
            None
        }
    };
    if let Some(ms) = trigger_ms {
        let quit_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            request_quit(&quit_handle);
        });
    }
}

#[tauri::command]
async fn cat_ready(app: AppHandle, window: tauri::WebviewWindow, state: State<'_, AppState>) -> Result<(), String> {
    if window.label() != "main" {
        return Err("[FORBIDDEN] 不允许此页面操作猫猫".to_string());
    }
    mark_webview_milestone(&app, &state, true, false);
    let snap = state.current_snapshot().await;
    publish_snapshot(&app, snap);
    show_window(&app, false);
    Ok(())
}

#[tauri::command]
async fn cat_command(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    input: serde_json::Value,
) -> Result<Snapshot, String> {
    if window.label() != "main" {
        return Err("[FORBIDDEN] 不允许此页面操作猫猫".to_string());
    }
    let command = validate_command(&input).map_err(|_| "[INVALID_PARAMS] 操作格式不正确".to_string())?;
    if command == Command::State {
        mark_webview_milestone(&app, &state, false, true);
    }
    match command {
        Command::Hide => {
            hide_window(&app);
            Ok(state.current_snapshot().await)
        }
        Command::Quit => {
            let snap = state.current_snapshot().await;
            request_quit(&app);
            Ok(snap)
        }
        other => {
            if state.demo {
                Ok(demo_snapshot())
            } else if let Some(svc) = &state.service {
                Ok(svc.command(other).await)
            } else {
                Ok(Snapshot::initial())
            }
        }
    }
}

fn acquire_single_instance_lock(data_dir: &Path) -> Result<Option<File>, String> {
    if !data_dir.exists() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(data_dir)
            .map_err(|_| "无法创建应用数据目录".to_string())?;
    }
    let lock_path = data_dir.join("instance.lock");
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(lock_path)
        .map_err(|_| "无法打开单实例锁".to_string())?;
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc != 0 {
        return Ok(None);
    }
    Ok(Some(file))
}

fn resolve_data_dir(demo: bool) -> Result<(PathBuf, Option<PathBuf>), String> {
    if demo {
        let dir = std::env::temp_dir().join(format!("quota-cat-rust-demo-{}", Uuid::new_v4()));
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)
            .map_err(|_| "无法创建演示目录".to_string())?;
        return Ok((dir.clone(), Some(dir)));
    }
    let home = std::env::var("HOME").map_err(|_| "无法定位用户主目录".to_string())?;
    let dir = PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("QuotaCatCN");
    Ok((dir, None))
}

fn open_verified_auth_url(raw_url: String) -> Result<(), String> {
    let target = Url::parse(&raw_url).map_err(|_| "无效的登录地址".to_string())?;
    let expected = Url::parse(&endpoints().auth_api_base_url).map_err(|_| "无效的登录地址".to_string())?;
    if target.scheme() != "https"
        || target.origin() != expected.origin()
        || !target.username().is_empty()
        || target.password().is_some()
    {
        return Err("无效的登录地址".to_string());
    }
    open::that_detached(target.as_str()).map_err(|_| "无法打开系统浏览器".to_string())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let demo = args.iter().any(|a| a == "--demo");
    let exit_after_ready_ms: Option<u64> = args
        .windows(2)
        .find(|w| w[0] == "--smoke-exit-ms")
        .and_then(|w| w[1].parse().ok());

    let (data_dir, qa_profile) = match resolve_data_dir(demo) {
        Ok(v) => v,
        Err(_) => std::process::exit(1),
    };

    let lock_file = if demo {
        None
    } else {
        match acquire_single_instance_lock(&data_dir) {
            Ok(Some(f)) => Some(f),
            Ok(None) => return,
            Err(_) => std::process::exit(1),
        }
    };

    let quitting = Arc::new(AtomicBool::new(false));
    let window_visible = Arc::new(AtomicBool::new(false));
    let ui_state = Arc::new(StdMutex::new(UiRuntimeState {
        ready: false,
        state_queried: false,
        was_signed_in: false,
        tray: None,
        last_tray_rect: None,
        last_tray_interaction: None,
        last_left_click_up: None,
    }));

    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![cat_ready, cat_command])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            {
                let _ = app.handle().set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            let handle = app.handle().clone();
            let (service, restore_after_manage) = if demo {
                (None, false)
            } else {
                let device_id = load_device_id(&data_dir).map_err(std::io::Error::other)?;
                #[cfg(target_os = "macos")]
                let cipher: Arc<dyn crate::storage::Cipher> = Arc::new(KeychainCipher::new(
                    "QuotaCatCN Safe Storage",
                    "QuotaCatCN Key",
                ));
                let store = Arc::new(EncryptedSessionStore::new(&data_dir, cipher));
                let ep = endpoints();
                let auth = Arc::new(HttpAuthClient::new(
                    &ep.auth_api_base_url,
                    &ep.auth_desktop_callback_url,
                    "cn",
                    &device_id,
                ));
                let open_url: OpenUrlFn = Box::new(|url| Box::pin(async move { open_verified_auth_url(url) }));
                let pub_handle = handle.clone();
                let svc = UsageService::new(UsageServiceDeps {
                    device_id,
                    device_link_base_url: ep.device_link_api_base_url.clone(),
                    store,
                    auth,
                    open_url,
                    publish: Box::new(move |snap| publish_snapshot(&pub_handle, snap)),
                    create_link: None,
                });
                (Some(svc), true)
            };

            // Build application menu (macOS standard shortcuts + Cmd+0 show)
            let about = AboutMetadataBuilder::new()
                .name(Some("猫猫"))
                .version(Some(APP_VERSION))
                .copyright(Some("远程订阅额度 · 中国大陆版"))
                .build();
            let app_submenu = SubmenuBuilder::new(app, "猫猫")
                .about(Some(about))
                .separator()
                .hide()
                .quit()
                .build()?;
            let edit_submenu = SubmenuBuilder::new(app, "编辑")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let show_item = MenuItemBuilder::with_id("menu_show", "显示猫猫")
                .accelerator("CmdOrCtrl+0")
                .build(app)?;
            let win_submenu = SubmenuBuilder::new(app, "窗口")
                .item(&show_item)
                .close_window()
                .build()?;
            let app_menu = MenuBuilder::new(app)
                .items(&[&app_submenu, &edit_submenu, &win_submenu])
                .build()?;
            app.set_menu(app_menu)?;

            // Build right-click tray menu
            let tray_open = MenuItemBuilder::with_id("tray_open", "打开猫猫").build(app)?;
            let tray_refresh = MenuItemBuilder::with_id("tray_refresh", "刷新额度").build(app)?;
            let tray_quit = MenuItemBuilder::with_id("tray_quit", "退出猫猫").build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .item(&tray_open)
                .item(&tray_refresh)
                .separator()
                .item(&tray_quit)
                .build()?;

            let tray_image = Image::from_bytes(TRAY_ICON_PNG)?;
            let ui_for_tray = ui_state.clone();
            let tray = TrayIconBuilder::with_id("quota-cat-tray")
                .icon(tray_image)
                .icon_as_template(true)
                .tooltip("猫猫 · 远程订阅额度")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app_handle, event| match event.id().as_ref() {
                    "tray_open" | "menu_show" => show_window(app_handle, true),
                    "tray_refresh" => {
                        let st = app_handle.state::<AppState>();
                        if !st.demo {
                            if let Some(svc) = st.service.clone() {
                                tauri::async_runtime::spawn(async move {
                                    svc.refresh().await;
                                });
                            }
                        }
                    }
                    "tray_quit" => request_quit(app_handle),
                    _ => {}
                })
                .on_tray_icon_event(move |tray_icon, event| {
                    if let TrayIconEvent::Click {
                        rect,
                        button: MouseButton::Left,
                        button_state,
                        ..
                    } = event
                    {
                        let app_handle = tray_icon.app_handle();
                        match button_state {
                            MouseButtonState::Down => {
                                let mut ui = ui_for_tray.lock().unwrap();
                                ui.last_tray_rect = Some(rect);
                                ui.last_tray_interaction = Some(Instant::now());
                            }
                            MouseButtonState::Up => {
                                let is_double = {
                                    let mut ui = ui_for_tray.lock().unwrap();
                                    ui.last_tray_rect = Some(rect);
                                    ui.last_tray_interaction = Some(Instant::now());
                                    let prev = ui.last_left_click_up.replace(Instant::now());
                                    prev.map_or(false, |t| t.elapsed() <= Duration::from_millis(320))
                                };
                                if is_double {
                                    show_window(app_handle, true);
                                    return;
                                }
                                if let Some(w) = app_handle.get_webview_window("main") {
                                    let visible = w.is_visible().unwrap_or(false);
                                    let minimized = w.is_minimized().unwrap_or(false);
                                    if visible && !minimized {
                                        hide_window(app_handle);
                                    } else {
                                        show_window(app_handle, true);
                                    }
                                }
                            }
                        }
                    }
                })
                .build(app)?;

            {
                let mut ui = ui_state.lock().unwrap();
                ui.tray = Some(tray);
            }

            if let Some(w) = app.get_webview_window("main") {
                if let Ok(icon) = Image::from_bytes(APP_ICON_PNG) {
                    let _ = w.set_icon(icon);
                }
                let bg = match w.theme().unwrap_or(Theme::Light) {
                    Theme::Dark => Color(0x1f, 0x1f, 0x1e, 0xff),
                    _ => Color(0xf8, 0xf8, 0xf6, 0xff),
                };
                let _ = w.set_background_color(Some(bg));

                let win_handle = handle.clone();
                let ui_for_win = ui_state.clone();
                w.on_window_event(move |event| match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        let st = win_handle.state::<AppState>();
                        if !st.quitting.load(Ordering::SeqCst) {
                            api.prevent_close();
                            hide_window(&win_handle);
                        }
                    }
                    WindowEvent::Focused(false) => {
                        let check_handle = win_handle.clone();
                        let ui_check = ui_for_win.clone();
                        tauri::async_runtime::spawn(async move {
                            // Allow native minimize / tray MouseDown to settle before deciding to auto-hide.
                            tokio::time::sleep(Duration::from_millis(75)).await;
                            let recent_tray = {
                                let ui = ui_check.lock().unwrap();
                                ui.last_tray_interaction
                                    .map_or(false, |t| t.elapsed() < Duration::from_millis(300))
                            };
                            if recent_tray {
                                return;
                            }
                            let handle_main = check_handle.clone();
                            let _ = check_handle.run_on_main_thread(move || {
                                if let Some(win) = handle_main.get_webview_window("main") {
                                    let focused = win.is_focused().unwrap_or(false);
                                    let minimized = win.is_minimized().unwrap_or(false);
                                    if !focused && !minimized {
                                        hide_window(&handle_main);
                                    }
                                }
                            });
                        });
                    }
                    WindowEvent::ThemeChanged(theme) => {
                        if let Some(win) = win_handle.get_webview_window("main") {
                            let next_bg = match theme {
                                Theme::Dark => Color(0x1f, 0x1f, 0x1e, 0xff),
                                _ => Color(0xf8, 0xf8, 0xf6, 0xff),
                            };
                            let _ = win.set_background_color(Some(next_bg));
                        }
                    }
                    _ => {}
                });
            }

            // 30-second periodic refresh loop while window is visible (paused when hidden).
            if !demo {
                if let Some(svc_loop) = service.clone() {
                    let vis_flag = window_visible.clone();
                    let quit_flag = quitting.clone();
                    tauri::async_runtime::spawn(async move {
                        let mut interval = tokio::time::interval(Duration::from_secs(30));
                        interval.tick().await;
                        loop {
                            interval.tick().await;
                            if quit_flag.load(Ordering::SeqCst) {
                                break;
                            }
                            if vis_flag.load(Ordering::SeqCst) {
                                svc_loop.refresh().await;
                            }
                        }
                    });
                }
            }

            // Watchdog for automated `--demo --smoke-exit-ms N`: fail with code 2 if WebView IPC never completes.
            if demo && exit_after_ready_ms.is_some() {
                let ui_watchdog = ui_state.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(8)).await;
                    let ok = {
                        let ui = ui_watchdog.lock().unwrap();
                        ui.ready && ui.state_queried
                    };
                    if !ok {
                        std::process::exit(2);
                    }
                });
            }

            let svc_to_restore = if restore_after_manage {
                service.clone()
            } else {
                None
            };
            app.manage(AppState {
                demo,
                smoke_exit_ms: exit_after_ready_ms,
                qa_profile,
                _lock_file: lock_file,
                quitting,
                window_visible,
                service,
                ui: ui_state,
            });
            if let Some(svc_restore) = svc_to_restore {
                tauri::async_runtime::block_on(async move {
                    svc_restore.restore().await;
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Quota Cat Rust app");

    app.run(|app_handle, event| match event {
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            show_window(app_handle, false);
        }
        RunEvent::ExitRequested { api, .. } => {
            let st = app_handle.state::<AppState>();
            if !st.quitting.load(Ordering::SeqCst) {
                api.prevent_exit();
            }
        }
        _ => {}
    });
}
