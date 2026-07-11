<#
.SYNOPSIS
  Full-loop transcription proof for SaySomething, without a microphone.

.DESCRIPTION
  Synthesizes a known sentence to a 16 kHz mono 16-bit WAV using Windows'
  System.Speech TTS, POSTs it to the local whisper-server /inference endpoint,
  and asserts the expected keywords appear in the transcript.

  Starts whisper-server itself if one is not already listening on -Port (this
  needs the binaries in bin/whisper and a downloaded model). If no model is
  present it prints a clear SKIP message and exits 0.

  PowerShell 5.1 safe: no '&&', no ternary/null-coalescing operators.

.PARAMETER Port
  Port the whisper server listens on (default 8737).
#>
param(
  [int]$Port = 8737
)

$ErrorActionPreference = 'Stop'

$repoRoot  = Split-Path -Parent $PSScriptRoot
$binServer = Join-Path $repoRoot 'bin\whisper\whisper-server.exe'
$modelsDir = Join-Path $env:APPDATA 'SaySomething\models'

Write-Host ''
Write-Host '== SaySomething e2e transcription test =='

# --- Is a TCP port accepting connections? (server readiness / reachability) ---
function Test-Port([int]$p) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect('127.0.0.1', $p, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(1000)
    if ($ok -and $client.Connected) {
      $client.EndConnect($iar)
      return $true
    }
    return $false
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

# --- 1. Locate a model (clear skip if none) -----------------------------------
$model = $null
if (Test-Path $modelsDir) {
  $found = Get-ChildItem -Path $modelsDir -Filter 'ggml-*.bin' -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $found) { $model = $found.FullName }
}
if ($null -eq $model) {
  Write-Host ('SKIP: no whisper model found in {0}' -f $modelsDir)
  Write-Host '      Download one first, e.g.:  node scripts/setup.js --model small.en'
  exit 0
}
Write-Host ('Model: {0}' -f $model)

# --- 2. Ensure a reachable server (start one if needed) -----------------------
$startedServer = $null
if (Test-Port $Port) {
  Write-Host ('Using already-running whisper-server on port {0}' -f $Port)
} else {
  if (-not (Test-Path $binServer)) {
    Write-Host ('SKIP: whisper-server.exe not found at {0}' -f $binServer)
    Write-Host '      Run:  node scripts/setup.js'
    exit 0
  }
  Write-Host ('Starting whisper-server on port {0} ...' -f $Port)
  $threads = [Math]::Max(4, [Environment]::ProcessorCount - 2)
  # Start-Process joins -ArgumentList with spaces WITHOUT quoting elements, so the
  # model path (under %APPDATA%, i.e. C:\Users\<name>\...) breaks when the Windows
  # account name contains a space. Pass a single pre-quoted argument string.
  $argString = ('-m "{0}" --host 127.0.0.1 --port {1} -t {2}' -f $model, $Port, $threads)
  $startedServer = Start-Process -FilePath $binServer -ArgumentList $argString -PassThru -WindowStyle Hidden

  $ready = $false
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Milliseconds 500
    if ($startedServer.HasExited) { break }
    if (Test-Port $Port) { $ready = $true; break }
  }
  if (-not $ready) {
    Write-Host ('FAIL: whisper-server did not become ready on port {0}' -f $Port)
    if (($null -ne $startedServer) -and (-not $startedServer.HasExited)) {
      Stop-Process -Id $startedServer.Id -Force -ErrorAction SilentlyContinue
    }
    exit 1
  }
  Write-Host 'Server ready.'
}

$exitCode = 0
$wavPath = $null
try {
  # --- 3. Synthesize a known sentence to a 16 kHz mono 16-bit WAV -------------
  $sentence = 'The quick brown fox jumps over the lazy dog.'
  $wavPath = Join-Path $env:TEMP ('saysomething-e2e-{0}.wav' -f ([Guid]::NewGuid().ToString('N')))

  Add-Type -AssemblyName System.Speech
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo -ArgumentList `
    16000, ([System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen), ([System.Speech.AudioFormat.AudioChannel]::Mono)
  $synth.SetOutputToWaveFile($wavPath, $fmt)
  $synth.Speak($sentence)
  $synth.Dispose()
  Write-Host ("Synthesized: '{0}'" -f $sentence)

  # --- 4. POST multipart/form-data to /inference -----------------------------
  Add-Type -AssemblyName System.Net.Http
  $client = New-Object System.Net.Http.HttpClient
  $client.Timeout = [TimeSpan]::FromSeconds(120)
  $form = New-Object System.Net.Http.MultipartFormDataContent

  $bytes = [System.IO.File]::ReadAllBytes($wavPath)
  $fileContent = New-Object System.Net.Http.ByteArrayContent -ArgumentList (,$bytes)
  $fileContent.Headers.ContentType = New-Object System.Net.Http.Headers.MediaTypeHeaderValue -ArgumentList 'audio/wav'
  $form.Add($fileContent, 'file', 'audio.wav')
  $form.Add((New-Object System.Net.Http.StringContent -ArgumentList 'json'), 'response_format')
  $form.Add((New-Object System.Net.Http.StringContent -ArgumentList '0'), 'temperature')
  $form.Add((New-Object System.Net.Http.StringContent -ArgumentList 'en'), 'language')

  $url = ('http://127.0.0.1:{0}/inference' -f $Port)
  Write-Host ('POST {0}' -f $url)
  $resp = $client.PostAsync($url, $form).Result
  $body = $resp.Content.ReadAsStringAsync().Result
  $client.Dispose()

  if (-not $resp.IsSuccessStatusCode) {
    Write-Host ('FAIL: inference returned HTTP {0}' -f [int]$resp.StatusCode)
    Write-Host $body
    $exitCode = 1
  } else {
    $text = ''
    try {
      $json = $body | ConvertFrom-Json
      $text = $json.text
    } catch {
      $text = $body
    }
    Write-Host ('Transcript: {0}' -f $text)

    $lc = $text.ToLower()
    $need = @('quick', 'brown', 'fox')
    $missing = @()
    foreach ($w in $need) {
      if ($lc -notmatch [Regex]::Escape($w)) { $missing += $w }
    }
    if ($missing.Count -eq 0) {
      Write-Host 'PASS: transcript contains the expected keywords.'
      $exitCode = 0
    } else {
      Write-Host ('FAIL: missing expected keywords: {0}' -f ($missing -join ', '))
      $exitCode = 1
    }
  }
} finally {
  if (($null -ne $wavPath) -and (Test-Path $wavPath)) {
    Remove-Item -Path $wavPath -Force -ErrorAction SilentlyContinue
  }
  if (($null -ne $startedServer) -and (-not $startedServer.HasExited)) {
    Write-Host 'Stopping the whisper-server this test started...'
    Stop-Process -Id $startedServer.Id -Force -ErrorAction SilentlyContinue
  }
}

exit $exitCode
