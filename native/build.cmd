@echo off
rem Compile SaySomethingHelper.exe with the .NET Framework csc that ships with Windows.
rem Invoked by src/main/helper.js when bin/helper/SaySomethingHelper.exe is missing,
rem and by scripts/setup.js. Self-locating via %~dp0 (the native/ directory).
setlocal enableextensions

set "CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
set "SRC=%~dp0SaySomethingHelper.cs"
set "OUTDIR=%~dp0..\bin\helper"
set "OUT=%OUTDIR%\SaySomethingHelper.exe"

if not exist "%CSC%" (
  echo build.cmd: csc not found at "%CSC%" 1>&2
  exit /b 1
)
if not exist "%SRC%" (
  echo build.cmd: source not found at "%SRC%" 1>&2
  exit /b 1
)
if not exist "%OUTDIR%" mkdir "%OUTDIR%"

"%CSC%" /nologo /target:winexe /platform:x64 /optimize+ /out:"%OUT%" ^
  /reference:System.dll ^
  /reference:System.Windows.Forms.dll ^
  "%SRC%"

if errorlevel 1 (
  echo build.cmd: compilation failed 1>&2
  exit /b 1
)

echo build.cmd: built "%OUT%"
exit /b 0
