# make-shortcut.ps1 (agent E)
#
# Creates Desktop + Start Menu shortcuts that launch SaySomething via the local Electron
# binary with the repo path as its argument, using assets/SaySomething.ico as the icon.
# PowerShell 5.1 safe: no '&&', no ternary, no null-conditional.

$ErrorActionPreference = 'Stop'

# scripts/ lives directly under the repo root.
$repo = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $repo 'node_modules\electron\dist\electron.exe'
$icon = Join-Path $repo 'assets\SaySomething.ico'

if (-not (Test-Path $electron)) {
    Write-Warning "Electron not found at $electron. Run 'npm install' before creating shortcuts."
}
if (-not (Test-Path $icon)) {
    Write-Warning "Icon not found at $icon. Run 'node scripts/gen-icon.js' to generate it; the shortcut will use the default icon."
}

$shell = New-Object -ComObject WScript.Shell

$targets = New-Object System.Collections.ArrayList
[void]$targets.Add([Environment]::GetFolderPath('Desktop'))

$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'SaySomething'
if (-not (Test-Path $startMenu)) {
    New-Item -ItemType Directory -Path $startMenu -Force | Out-Null
}
[void]$targets.Add($startMenu)

foreach ($dir in $targets) {
    $lnkPath = Join-Path $dir 'SaySomething.lnk'
    $lnk = $shell.CreateShortcut($lnkPath)
    $lnk.TargetPath = $electron
    # Quote the repo path so spaces survive; Electron treats it as the app dir.
    $lnk.Arguments = '"' + $repo + '"'
    $lnk.WorkingDirectory = $repo
    $lnk.Description = 'SaySomething - hold Right Ctrl to dictate'
    if (Test-Path $icon) {
        $lnk.IconLocation = $icon
    }
    $lnk.Save()
    Write-Host "Created shortcut: $lnkPath"
}

Write-Host 'Done.'
