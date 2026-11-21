@echo off
chcp 65001 >nul
rem StoryAlter 桌面版启动器（Tauri 原生窗口，自动拉起引擎）
pushd "%~dp0"
set "NOVEL_STUDIO_ENGINE=%~dp0bin\novel.mjs"
if exist "desktop\src-tauri\target\release\storyalter-desktop.exe" (
    start "" "desktop\src-tauri\target\release\storyalter-desktop.exe"
) else if exist "desktop\src-tauri\target\debug\storyalter-desktop.exe" (
    start "" "desktop\src-tauri\target\debug\storyalter-desktop.exe"
) else (
    start "" "desktop\src-tauri\target\debug\novel-studio-desktop.exe"
)
popd
