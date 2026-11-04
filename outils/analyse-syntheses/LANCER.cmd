@echo off
setlocal
cd /d "%~dp0"
title Analyse des syntheses du Guichet unique
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js n'est pas installe sur ce PC.
  echo Installez la version LTS depuis https://nodejs.org puis relancez LANCER.cmd.
  echo.
  pause
  exit /b 1
)
node analyse.js %1
if errorlevel 1 (
  echo.
  echo L'analyse s'est arretee : copiez le message ci-dessus et envoyez-le a Claude.
  echo.
  pause
  exit /b 1
)
start "" explorer "%USERPROFILE%\Downloads\Resultats syntheses Legalize"
if exist "%USERPROFILE%\Downloads\Exemples syntheses a envoyer" start "" explorer "%USERPROFILE%\Downloads\Exemples syntheses a envoyer"
echo.
echo Termine. Envoyez a Claude rapport.md et agregats.json (dossier "Resultats syntheses Legalize"),
echo ainsi que les PDF du dossier "Exemples syntheses a envoyer".
echo.
pause
