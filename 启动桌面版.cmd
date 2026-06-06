@echo off
rem Novel Studio 桌面版启动器（Tauri 原生窗口，自动拉起引擎）
pushd "%~dp0"
start "" "desktop\src-tauri\target\debug\novel-studio-desktop.exe"
popd
