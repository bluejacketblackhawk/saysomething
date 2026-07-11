# SaySomething live-partial proof (no microphone).
#
# Proves the streaming approach — windowed re-transcription of a GROWING audio
# buffer against the one-shot /inference endpoint — produces sane, building
# partials. Synthesizes a known sentence with System.Speech, then POSTs growing
# prefixes (25% / 50% / 75% / 100% of the samples) to whisper-server, printing
# each partial. Asserts the partials build toward and the final contains the
# expected keywords. Self-starts the server if one isn't already running.
#
# PowerShell 5.1-safe: no &&, no ternary. -Port selects the server port.

param([int]$Port = 8737)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$binServer = Join-Path $repo 'bin\whisper\whisper-server.exe'
$model = Join-Path $env:APPDATA 'SaySomething\models\ggml-small.en.bin'
$sentence = 'The quick brown fox jumps over the lazy dog.'

function Test-Port([int]$p) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $c.Connect('127.0.0.1', $p); $c.Close(); return $true
  } catch { return $false }
}

Write-Host '== SaySomething live-partial (growing-prefix) test =='
if (-not (Test-Path $model)) {
  Write-Host ('SKIP: model not found at {0}' -f $model)
  Write-Host '      Run:  node scripts/setup.js'
  exit 0
}

# --- synthesize the sentence to a 16 kHz mono WAV ---
Add-Type -AssemblyName System.Speech
$wavPath = Join-Path $env:TEMP ('saysomething-partial-{0}.wav' -f $PID)
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SetOutputToWaveFile($wavPath, $fmt)
$synth.Speak($sentence)
$synth.Dispose()
Write-Host ('Synthesized: ''{0}''' -f $sentence)

# --- read the WAV; locate the real `data` chunk (System.Speech headers are not a
#     clean 44 bytes), then rebuild a canonical 16k/mono/16-bit header per prefix ---
$all = [System.IO.File]::ReadAllBytes($wavPath)

function Get-DataChunk([byte[]]$b) {
  for ($i = 12; $i -lt $b.Length - 8; $i++) {
    if ($b[$i] -eq 0x64 -and $b[$i+1] -eq 0x61 -and $b[$i+2] -eq 0x74 -and $b[$i+3] -eq 0x61) {
      return @(($i + 8), ([BitConverter]::ToInt32($b, $i + 4)))
    }
  }
  return @(44, ($b.Length - 44))
}

function New-WavHeader([int]$dataSize) {
  $h = New-Object byte[] 44
  $enc = [System.Text.Encoding]::ASCII
  [Array]::Copy($enc.GetBytes('RIFF'), 0, $h, 0, 4)
  [Array]::Copy([BitConverter]::GetBytes([int](36 + $dataSize)), 0, $h, 4, 4)
  [Array]::Copy($enc.GetBytes('WAVE'), 0, $h, 8, 4)
  [Array]::Copy($enc.GetBytes('fmt '), 0, $h, 12, 4)
  [Array]::Copy([BitConverter]::GetBytes([int]16), 0, $h, 16, 4)
  [Array]::Copy([BitConverter]::GetBytes([int16]1), 0, $h, 20, 2)     # PCM
  [Array]::Copy([BitConverter]::GetBytes([int16]1), 0, $h, 22, 2)     # mono
  [Array]::Copy([BitConverter]::GetBytes([int]16000), 0, $h, 24, 4)
  [Array]::Copy([BitConverter]::GetBytes([int]32000), 0, $h, 28, 4)   # byteRate
  [Array]::Copy([BitConverter]::GetBytes([int16]2), 0, $h, 32, 2)     # blockAlign
  [Array]::Copy([BitConverter]::GetBytes([int16]16), 0, $h, 34, 2)    # bitsPerSample
  [Array]::Copy($enc.GetBytes('data'), 0, $h, 36, 4)
  [Array]::Copy([BitConverter]::GetBytes([int]$dataSize), 0, $h, 40, 4)
  return ,$h
}

$dc = Get-DataChunk $all
$dataOffset = $dc[0]
$pcmLen = $dc[1]
Write-Host ('Audio: {0:N1}s of PCM (data@{1})' -f ($pcmLen / 2 / 16000), $dataOffset)

function New-WavPrefix([byte[]]$src, [int]$dataOffset, [int]$pcmBytes) {
  if ($pcmBytes % 2 -ne 0) { $pcmBytes = $pcmBytes - 1 }
  $hdr = New-WavHeader $pcmBytes
  $out = New-Object byte[] (44 + $pcmBytes)
  [Array]::Copy($hdr, 0, $out, 0, 44)
  [Array]::Copy($src, $dataOffset, $out, 44, $pcmBytes)
  return ,$out
}

# Binary-safe multipart POST via System.Net.Http (PS 5.1's Invoke-RestMethod
# corrupts binary byte[] bodies — this is the mechanism e2e-transcribe.ps1 uses).
Add-Type -AssemblyName System.Net.Http
function Invoke-Inference([int]$p, [byte[]]$wavBytes) {
  $client = New-Object System.Net.Http.HttpClient
  $client.Timeout = [TimeSpan]::FromSeconds(120)
  $form = New-Object System.Net.Http.MultipartFormDataContent
  $fileContent = New-Object System.Net.Http.ByteArrayContent -ArgumentList (,$wavBytes)
  $fileContent.Headers.ContentType = New-Object System.Net.Http.Headers.MediaTypeHeaderValue -ArgumentList 'audio/wav'
  $form.Add($fileContent, 'file', 'audio.wav')
  $form.Add((New-Object System.Net.Http.StringContent -ArgumentList 'json'), 'response_format')
  $form.Add((New-Object System.Net.Http.StringContent -ArgumentList '0'), 'temperature')
  $form.Add((New-Object System.Net.Http.StringContent -ArgumentList 'en'), 'language')
  $uri = ('http://127.0.0.1:{0}/inference' -f $p)
  $resp = $client.PostAsync($uri, $form).Result
  $body = $resp.Content.ReadAsStringAsync().Result
  $client.Dispose()
  if (-not $resp.IsSuccessStatusCode) { return '' }
  try { $j = $body | ConvertFrom-Json; return $j.text } catch { return $body }
}

# --- ensure a server ---
$startedServer = $null
if (Test-Port $Port) {
  Write-Host ('Using already-running whisper-server on port {0}' -f $Port)
} else {
  if (-not (Test-Path $binServer)) { Write-Host ('SKIP: whisper-server.exe not found at {0}' -f $binServer); exit 0 }
  $threads = [Math]::Max(4, [Environment]::ProcessorCount - 2)
  $argString = ('-m "{0}" --host 127.0.0.1 --port {1} -t {2}' -f $model, $Port, $threads)
  Write-Host ('Starting whisper-server on port {0} ...' -f $Port)
  $startedServer = Start-Process -FilePath $binServer -ArgumentList $argString -PassThru -WindowStyle Hidden
  $ready = $false
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Milliseconds 500
    if ($startedServer.HasExited) { break }
    if (Test-Port $Port) { $ready = $true; break }
  }
  if (-not $ready) { Write-Host 'FAIL: server did not become ready'; exit 1 }
  Write-Host 'Server ready.'
}

try {
  $fractions = @(0.25, 0.5, 0.75, 1.0)
  $final = ''
  foreach ($f in $fractions) {
    $bytes = [int]($pcmLen * $f)
    $wav = New-WavPrefix $all $dataOffset $bytes
    $text = (Invoke-Inference $Port $wav)
    if ($null -eq $text) { $text = '' }
    $text = $text.Trim()
    Write-Host ('  {0,4:P0}  ->  {1}' -f $f, $text)
    $final = $text
  }

  $lower = $final.ToLower()
  $ok = ($lower.Contains('quick') -and $lower.Contains('fox') -and $lower.Contains('lazy'))
  if ($ok) {
    Write-Host ''
    Write-Host 'PASS: growing prefixes transcribe; final contains the expected keywords.'
    $exit = 0
  } else {
    Write-Host ''
    Write-Host ('FAIL: final transcript missing expected keywords: {0}' -f $final)
    $exit = 1
  }
} finally {
  if ($startedServer -ne $null) {
    Write-Host 'Stopping the whisper-server this test started...'
    try { Stop-Process -Id $startedServer.Id -Force } catch { }
  }
  try { Remove-Item $wavPath -Force -ErrorAction SilentlyContinue } catch { }
}
exit $exit
