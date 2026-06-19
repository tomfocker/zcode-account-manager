@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

:: Check if npm/npx is available
where npx >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: npx not found. Please install Node.js first.
    echo Download from https://nodejs.org/
    pause
    exit /b 1
)

:: Install deps if needed
if not exist node_modules (
    echo Installing dependencies...
    npm install
    if %errorlevel% neq 0 (
        echo ERROR: npm install failed.
        pause
        exit /b 1
    )
)

echo Starting ZCode Account Manager...
npx electron .
if %errorlevel% neq 0 pause
