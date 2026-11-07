@echo off
rem SPDX-License-Identifier: AGPL-3.0-only
rem Double-click installer: runs the one-line PowerShell installer for the wusbfff native helper.
echo Installing the wusbfff native helper...
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/ospab/wusbfff/main/get.ps1 | iex"
echo.
pause
