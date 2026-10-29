@echo off
rem ORBIT launcher: checks Node.js, installs dependencies the first time,
rem builds the interface, starts the local server and opens ORBIT.
rem Close this window (or press Ctrl+C) to stop ORBIT.
setlocal EnableExtensions
cd /d "%~dp0"
title ORBIT

set "AJ_PORT_VALUE=4320"
if exist ".env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
    if /i "%%a"=="ORBIT_PORT" set "AJ_PORT_VALUE=%%b"
    if /i "%%a"=="AURAJOBS_PORT" set "AJ_PORT_VALUE=%%b"
  )
)
set "AJ_URL=http://127.0.0.1:%AJ_PORT_VALUE%"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js n'est pas installe. Installez Node.js 22.13 ou plus recent depuis https://nodejs.org
  echo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -v') do set "NODE_MAJOR=%%v"
set "NODE_MAJOR=%NODE_MAJOR:v=%"
if %NODE_MAJOR% LSS 22 (
  echo.
  echo  ORBIT demande Node.js 22.13 ou plus recent ^(trouve : %NODE_MAJOR%^).
  echo.
  pause
  exit /b 1
)

rem Already running? Just open it.
curl -s -o nul -m 2 "%AJ_URL%/api/health" >nul 2>nul
if not errorlevel 1 (
  echo ORBIT tourne deja sur %AJ_URL%
  start "" "%AJ_URL%/"
  exit /b 0
)

if not exist "node_modules" (
  echo Installation des dependances ^(premier lancement seulement^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :failed
)

echo Construction de l'interface...
call npm run build --silent
if errorlevel 1 goto :failed

start "" /b powershell -NoProfile -ExecutionPolicy Bypass -Command "for ($i = 0; $i -lt 120; $i++) { try { Invoke-WebRequest -UseBasicParsing -Uri '%AJ_URL%/api/health' -TimeoutSec 1 | Out-Null; break } catch { Start-Sleep -Milliseconds 500 } }; Start-Process '%AJ_URL%/'"

echo.
echo  ORBIT demarre sur %AJ_URL%  ^(cet ordinateur seulement^)
echo  Gardez cette fenetre ouverte pendant l'utilisation. Fermez-la pour arreter.
echo.
call npm start
exit /b %errorlevel%

:failed
echo.
echo  ORBIT n'a pas pu demarrer. Voir les messages ci-dessus.
echo.
pause
exit /b 1
