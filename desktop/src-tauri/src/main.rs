#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Novel Studio 桌面端：Tauri 原生窗口 + 启动时拉起 Node 引擎(novel serve)作为后端。
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

// 原生"选择文件夹"对话框，返回所选目录路径（取消则返回 null）。
#[tauri::command]
fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|pb| pb.to_string_lossy().to_string())
}

struct Sidecar(Mutex<Option<Child>>);

const ENGINE_PORT: &str = "8787";

// 解析引擎入口 bin/novel.mjs 的路径：
// 1) 环境变量 NOVEL_STUDIO_ENGINE 覆盖
// 2) 打包后：exe 同级 resources/engine/bin/novel.mjs
// 3) 开发期：编译期 src-tauri/../../bin/novel.mjs
fn engine_path() -> String {
    if let Ok(p) = std::env::var("NOVEL_STUDIO_ENGINE") {
        return p;
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join("resources").join("engine").join("bin").join("novel.mjs");
            if bundled.exists() {
                return bundled.to_string_lossy().to_string();
            }
        }
    }
    concat!(env!("CARGO_MANIFEST_DIR"), "/../../bin/novel.mjs").to_string()
}

fn start_engine() -> Option<Child> {
    let engine = engine_path();
    eprintln!("[novel-studio] starting engine: node {} serve --port {}", engine, ENGINE_PORT);
    match Command::new("node")
        .arg(&engine)
        .arg("serve")
        .arg("--port")
        .arg(ENGINE_PORT)
        .spawn()
    {
        Ok(child) => Some(child),
        Err(e) => {
            eprintln!("[novel-studio] failed to start engine ({}). 请确认已安装 Node。", e);
            None
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![pick_folder])
        .setup(|app| {
            app.manage(Sidecar(Mutex::new(start_engine())));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(sc) = window.app_handle().try_state::<Sidecar>() {
                    if let Some(mut c) = sc.0.lock().unwrap().take() {
                        let _ = c.kill();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Novel Studio");
}
