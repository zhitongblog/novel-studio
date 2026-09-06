#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Novel Studio 桌面端：Tauri 原生窗口 + 启动时拉起 Node 引擎(novel serve)作为后端。
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
// 让子进程不弹黑色控制台窗口（藏起「机器」）——node 引擎、powershell 清端口都用。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
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

const ENGINE_PORT: &str = "8799";

// 解析引擎入口 bin/novel.mjs 的路径，按优先级尝试多个候选位置：
// 1) 环境变量 NOVEL_STUDIO_ENGINE 覆盖
// 2) 打包后：Tauri 资源目录 <resource_dir>/engine/bin/novel.mjs（v2 标准）
// 3) 兼容：exe 同级 resources/engine/bin/novel.mjs
// 4) 开发期：编译期 src-tauri/../../bin/novel.mjs
// Windows 的 resource_dir() 会返回 \\?\ 前缀的 verbatim 路径，Node 的模块加载器无法解析
// （会误把 "D:" 当目录 lstat 报 EISDIR）。传给 node 前必须剥掉该前缀。
fn strip_verbatim(s: String) -> String {
    s.strip_prefix(r"\\?\").map(|x| x.to_string()).unwrap_or(s)
}

fn engine_path(resource_dir: Option<PathBuf>) -> String {
    if let Ok(p) = std::env::var("NOVEL_STUDIO_ENGINE") {
        return p;
    }
    let rel = |base: PathBuf| base.join("engine").join("bin").join("novel.mjs");
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(rd) = resource_dir {
        candidates.push(rel(rd.clone()));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(rel(dir.join("resources")));
            candidates.push(rel(dir.to_path_buf()));
        }
    }
    for c in candidates {
        if c.exists() {
            return strip_verbatim(c.to_string_lossy().to_string());
        }
    }
    concat!(env!("CARGO_MANIFEST_DIR"), "/../../bin/novel.mjs").to_string()
}

// 找 node：和「找不到可用模型」同一个根因——GUI 双击启动的 .app 只继承 launchd 的最小 PATH
// （/usr/bin:/bin:/usr/sbin:/sbin），Homebrew / nvm / npm-global 装的 node 一个都不在里面，
// Command::new("node") 直接 ENOENT，引擎起不来 → 窗口一片空白。终端里启动却一切正常。
// 顺序：环境变量覆盖 → 常见安装位置 → 问登录 shell（nvm/fnm 只在 rc 里注入）→ 兜底裸 "node"。
fn node_bin() -> String {
    if let Ok(p) = std::env::var("NOVEL_STUDIO_NODE") {
        if !p.is_empty() {
            return p;
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        let mut cands: Vec<String> = vec![
            "/opt/homebrew/bin/node".to_string(),
            "/usr/local/bin/node".to_string(),
            "/usr/bin/node".to_string(),
        ];
        if !home.is_empty() {
            for rel in [".npm-global/bin/node", ".volta/bin/node", ".bun/bin/node", ".local/bin/node"] {
                cands.push(format!("{}/{}", home, rel));
            }
        }
        for c in &cands {
            if std::path::Path::new(c).exists() {
                return c.clone();
            }
        }
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        if let Ok(out) = Command::new(&shell).args(["-ilc", "command -v node"]).output() {
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !p.is_empty() && std::path::Path::new(&p).exists() {
                return p;
            }
        }
    }
    "node".to_string()
}

// 启动引擎前先杀掉占用 8787 的残留旧引擎（杜绝"僵尸引擎占端口→新引擎绑不上→旧代码一直服务"）。
fn kill_stale_engine() {
    #[cfg(target_os = "windows")]
    {
        let ps = format!(
            "Get-NetTCPConnection -LocalPort {} -State Listen -ErrorAction SilentlyContinue | ForEach-Object {{ Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }}",
            ENGINE_PORT
        );
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", &ps]);
        cmd.creation_flags(CREATE_NO_WINDOW);   // 清端口时也别闪窗
        let _ = cmd.status();
        std::thread::sleep(std::time::Duration::from_millis(1200));
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = Command::new("sh")
            .arg("-c")
            .arg(format!("lsof -ti tcp:{} | xargs -r kill -9", ENGINE_PORT))
            .status();
        std::thread::sleep(std::time::Duration::from_millis(800));
    }
}

fn start_engine(resource_dir: Option<PathBuf>) -> Option<Child> {
    kill_stale_engine();   // 先清残留旧引擎，确保新引擎能绑上 8787（加载最新代码）
    let engine = engine_path(resource_dir);
    let node = node_bin();
    eprintln!("[novel-studio] starting engine: {} {} serve --port {}", node, engine, ENGINE_PORT);
    let mut cmd = Command::new(&node);
    cmd.arg(&engine).arg("serve").arg("--port").arg(ENGINE_PORT);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);   // 引擎在后台跑，不弹黑色终端
    match cmd.spawn()
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
            let resource_dir = app.path().resource_dir().ok();
            app.manage(Sidecar(Mutex::new(start_engine(resource_dir))));
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
