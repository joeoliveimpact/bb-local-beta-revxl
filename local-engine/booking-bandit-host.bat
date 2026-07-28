@echo off
rem Booking Bandit Local Claude Engine - native-messaging host launcher (TEMPLATE).
rem install-windows.ps1 GENERATES the installed copy with the absolute node.exe
rem path pinned (GUI-spawned browsers can have a stripped PATH). This repo copy is
rem the PATH-dependent fallback for a manual install only.
rem %~dp0 = the folder this .bat lives in (the install dir), so host\main.mjs
rem resolves regardless of Chrome's working directory. %* forwards Chrome's args.
node "%~dp0host\main.mjs" %*
