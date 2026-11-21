@echo off
chcp 65001 >nul
pushd "%~dp0"
title StoryAlter
node "bin\novel.mjs" %*
set "ec=%errorlevel%"
popd
if not "%ec%"=="0" pause
