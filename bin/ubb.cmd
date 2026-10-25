@echo off
rem UBB launcher: Node CLI by default, Rust binary when Node is absent.
where node >nul 2>nul
if %errorlevel%==0 (
  node "%~dp0..\daemon\ubb.mjs" %*
) else (
  "%~dp0ubb.exe" %*
)
