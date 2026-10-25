@echo off
rem UBB launcher: the Rust binary is the default runtime (zero deps, instant start).
rem Node CLI remains available for development: node daemon\ubb.mjs %*
"%~dp0ubb.exe" %*
