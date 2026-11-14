@echo off
chcp 65001 >nul
rem Novel Studio 桌面版启动器（Tauri 原生窗口，自动拉起引擎）
pushd "%~dp0"
set "NOVEL_STUDIO_ENGINE=%~dp0bin\novel.mjs"
if exist "desktop\src-tauri\target\release\novel-studio-desktop.exe" (
    start "" "desktop\src-tauri\target\release\novel-studio-desktop.exe"
) else (
    start "" "desktop\src-tauri\target\debug\novel-studio-desktop.exe"
)
popd
