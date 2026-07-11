use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "tray-show", "显示 pi-studio", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tau-32.png"))?;

    TrayIconBuilder::with_id("pi-studio")
        .tooltip("pi-studio")
        .icon(icon)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-show" => show_window(app),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

pub fn install_menu(app: &AppHandle) -> tauri::Result<()> {
    let pkg = app.package_info();
    let about_metadata = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        copyright: Some("pi-studio".into()),
        authors: Some(vec!["pi-studio Contributors".into()]),
        comments: Some("Desktop client for Pi".into()),
        ..Default::default()
    };

    let new_session =
        MenuItem::with_id(app, "menu-new-session", "新建会话", true, Some("CmdOrCtrl+N"))?;
    let open_projects = MenuItem::with_id(
        app,
        "menu-open-projects",
        "打开项目…",
        true,
        Some("CmdOrCtrl+Shift+P"),
    )?;
    let open_settings =
        MenuItem::with_id(app, "menu-open-settings", "设置", true, Some("CmdOrCtrl+,"))?;
    let toggle_window_item = MenuItem::with_id(
        app,
        "menu-toggle-window",
        "显示/隐藏窗口",
        true,
        Some("Ctrl+Alt+T"),
    )?;
    let reload = MenuItem::with_id(app, "menu-reload", "重新加载", true, Some("CmdOrCtrl+R"))?;

    let file_menu = Submenu::with_items(
        app,
        "文件",
        true,
        &[
            &new_session,
            &open_projects,
            &PredefinedMenuItem::separator(app)?,
            &open_settings,
            &PredefinedMenuItem::separator(app)?,
            &toggle_window_item,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some("关闭窗口"))?,
            &PredefinedMenuItem::quit(app, Some("退出 pi-studio"))?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::cut(app, Some("剪切"))?,
            &PredefinedMenuItem::copy(app, Some("复制"))?,
            &PredefinedMenuItem::paste(app, Some("粘贴"))?,
            &PredefinedMenuItem::select_all(app, Some("全选"))?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "视图",
        true,
        &[
            &reload,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::minimize(app, Some("最小化"))?,
            &PredefinedMenuItem::maximize(app, Some("最大化"))?,
        ],
    )?;

    let help_menu = Submenu::with_items(
        app,
        "帮助",
        true,
        &[&PredefinedMenuItem::about(
            app,
            Some("关于 pi-studio"),
            Some(about_metadata),
        )?],
    )?;

    let menu = Menu::with_items(app, &[&file_menu, &edit_menu, &view_menu, &help_menu])?;
    app.set_menu(menu)?;

    app.on_menu_event(|app, event| match event.id().as_ref() {
        "menu-new-session" => {
            show_window(app);
            let _ = app.emit("pi-studio-command", "new-session");
        }
        "menu-open-projects" => {
            show_window(app);
            let _ = app.emit("pi-studio-command", "show-launcher");
        }
        "menu-open-settings" => {
            show_window(app);
            let _ = app.emit("pi-studio-command", "open-settings");
        }
        "menu-toggle-window" => toggle_window(app),
        "menu-reload" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval("window.location.reload()");
            }
        }
        _ => {}
    });

    Ok(())
}

pub fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn toggle_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        match window.is_visible() {
            Ok(true) => {
                let _ = window.hide();
            }
            _ => {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    }
}