# Local Model Studio -- end-to-end smoke test.
#
# ASCII ONLY on purpose: PowerShell 5.1 decodes a BOM-less .ps1 as ANSI, so Chinese
# characters in this file would corrupt the parser. The one UTF-8 probe builds its
# Chinese text from Unicode code points at runtime instead of embedding it.
#
# Usage:  powershell -ExecutionPolicy Bypass -File tools\smoke-test.ps1
#         powershell -ExecutionPolicy Bypass -File tools\smoke-test.ps1 -SkipTool

param(
  [int]    $Port    = 8890,
  [int]    $Timeout = 900,
  [switch] $SkipTool
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$base = "http://127.0.0.1:$Port"
$script:fails = 0

function Say($m)  { Write-Host $m }
function Pass($m) { Write-Host "  [PASS] $m" -ForegroundColor Green }
function Fail($m) { Write-Host "  [FAIL] $m" -ForegroundColor Red; $script:fails++ }
function Head($m) { Write-Host ""; Write-Host "=== $m ===" -ForegroundColor Cyan }

# POST/GET helpers. -Body is always sent as explicit UTF-8 bytes; passing a .NET
# string makes PowerShell 5.1 replace every non-ASCII char with '?'.
function PostJson($path, $obj, $timeout = 120) {
  $json  = $obj | ConvertTo-Json -Depth 12 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  return Invoke-WebRequest -Uri "$base$path" -Method Post -Body $bytes `
    -ContentType 'application/json; charset=utf-8' -UseBasicParsing -TimeoutSec $timeout
}
function GetJson($path, $timeout = 60) {
  return Invoke-WebRequest -Uri "$base$path" -Method Get -UseBasicParsing -TimeoutSec $timeout
}
function U8($codes) { return -join ($codes | ForEach-Object { [char]$_ }) }

# Parse our SSE envelope into an array of objects.
function ParseSse($content) {
  $out = @()
  foreach ($line in ($content -split "`n")) {
    if ($line -match '^data: ') {
      try { $out += (($line -replace '^data: ', '') | ConvertFrom-Json) } catch { }
    }
  }
  return $out
}
function Chat($text, $extra = @{}, $timeout = 900) {
  $body = @{ messages = @(@{ role = 'user'; content = $text }) }
  foreach ($k in $extra.Keys) { $body[$k] = $extra[$k] }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $r  = PostJson '/api/chat' $body $timeout
  $sw.Stop()
  return @{ events = ParseSse $r.Content; wall = [int]$sw.Elapsed.TotalSeconds }
}

# ---------------------------------------------------------------------- 1. state
Head '1. backend state'
try {
  $st = (GetJson '/api/state').Content | ConvertFrom-Json
  Pass "backend alive on $Port (mode=$($st.mode))"
  if ($st.chat.schema.groups.Count -ge 4) { Pass "chat schema groups = $($st.chat.schema.groups.Count)" }
  else { Fail 'chat schema missing groups' }
  if ($st.chat.presets.Count -ge 5) { Pass "presets = $(($st.chat.presets | ForEach-Object { $_.id }) -join ', ')" }
  else { Fail 'presets missing' }
  Say "  engine port=$($st.chat.port) alive=$($st.chat.alive) ready=$($st.chat.ready)"
  Say "  image bridge port=$($st.image.port) alive=$($st.image.alive) comfy=$($st.image.comfyAlive)"
  Say "  vram=$($st.gpu.used)/$($st.gpu.total) MiB  temp=$($st.gpu.temp)C util=$($st.gpu.util)%"
} catch { Fail "GET /api/state -> $($_.Exception.Message)" }

# ----------------------------------------------------------------- 2. chat (ASCII)
Head '2. chat round trip (ASCII)'
try {
  $c = Chat 'Reply with exactly: SMOKE OK'
  $ans = ($c.events | Where-Object { $_.type -eq 'delta' } | ForEach-Object { $_.text }) -join ''
  $stt = $c.events | Where-Object { $_.type -eq 'stats' }
  if ($ans -match 'SMOKE OK') { Pass "answer contains SMOKE OK ($($c.wall)s)" } else { Fail "unexpected answer: $ans" }
  if ($stt -and $stt.gen_tokens -gt 0) { Pass "stats: gen=$($stt.gen_tokens) tok @ $([math]::Round($stt.gen_tps,2)) t/s, prompt $([math]::Round($stt.prompt_tps,1)) t/s" }
  else { Fail 'stats.gen_tokens is empty (the usage/timings chunk guard regression)' }
  if (($c.events | Where-Object { $_.type -eq 'speed' }).Count -gt 0) { Pass 'speed events streamed' }
  else { Say '  [note] no speed events (short answer may finish before the first 16-token tick)' }
} catch { Fail "chat -> $($_.Exception.Message)" }

# ------------------------------------------------------------------ 3. chat (UTF-8)
Head '3. chat round trip (UTF-8 Chinese)'
try {
  # U+4F60 U+597D = hello ; asks the model to echo the word back
  $cn = U8 @(0x4F60, 0x597D)
  $c  = Chat ("Repeat this word back to me and nothing else: " + $cn)
  $ans = ($c.events | Where-Object { $_.type -eq 'delta' } | ForEach-Object { $_.text }) -join ''
  if ($ans -match $cn) { Pass "UTF-8 round trip intact ($($c.wall)s): $ans" }
  else { Fail "Chinese did not survive or was not echoed: $ans" }
  if ($ans -match '\?\?') { Fail 'answer contains ?? -- request body was not sent as UTF-8 bytes' }
} catch { Fail "utf8 chat -> $($_.Exception.Message)" }

# --------------------------------------------------------------- 4. cross-modal
if (-not $SkipTool) {
  Head '4. cross-modal: chat asks the model to draw, model calls generate_image'
  try {
    $c    = Chat 'Draw a picture of an orange cat sitting on a windowsill in warm sunlight.'
    $hist = $c.events | Group-Object type | Sort-Object Name | ForEach-Object { "$($_.Name)x$($_.Count)" }
    Say "  events: $($hist -join ' ')"
    $tool = $c.events | Where-Object { $_.type -eq 'tool' }
    $img  = $c.events | Where-Object { $_.type -eq 'image' }
    if ($tool) { Pass "model invoked tool: $(($tool | Select-Object -First 1 | ConvertTo-Json -Compress -Depth 5))" }
    else { Fail 'no tool event -- the model did not call generate_image' }
    if ($img) {
      $names = @($img | ForEach-Object { $_.images } | ForEach-Object { $_ } | ForEach-Object { if ($_.url) { $_.url } else { $_.file } })
      Pass "image produced: $($names -join ', ')"
    } else { Fail 'no image event' }
    Say "  wall=$($c.wall)s"
    $last = ($c.events | Where-Object { $_.type -eq 'delta' } | ForEach-Object { $_.text }) -join ''
    if ($last) { Say "  closing text: $last" }
  } catch { Fail "cross-modal -> $($_.Exception.Message)" }
} else { Head '4. cross-modal (skipped)' }

# ---------------------------------------------------------- 5. image tab direct
Head '5. image tab (direct generate)'
try {
  $b = @{ prompt = 'a red teapot on a wooden table, studio light'; width = 768; height = 768; steps = 8 }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $r = PostJson '/api/image/generate' $b 600
  $sw.Stop()
  $j = $r.Content | ConvertFrom-Json
  if ($j.ok) { Pass "job accepted in $([int]$sw.Elapsed.TotalSeconds)s" } else { Fail "generate rejected: $($r.Content)" }

  # The bridge's /api/status returns the job snapshot at the TOP level, not wrapped in
  # {job:{...}}. Accept both shapes (server.js runImageJob does the same with
  # `const jb = st.job || st`). Getting this wrong made the loop break on the very
  # first poll and report an empty state.
  $deadline = (Get-Date).AddMinutes(8)
  $st = $null; $jb = $null; $seen = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $st = ((GetJson '/api/image/status').Content | ConvertFrom-Json)
    $jb = if ($st.job) { $st.job } else { $st }
    if ($jb.state) { $seen = $true }
    if ($seen -and ($jb.state -eq 'done' -or $jb.state -eq 'error')) { break }
    if (-not $seen -and $sw.Elapsed.TotalSeconds -gt 90) { break }
  }
  if ($jb.state -eq 'done') { Pass "job done: $(@($jb.images).Count) image(s)" }
  elseif ($jb.state -eq 'error') { Fail "job error: $($jb.error)" }
  else { Fail "job did not finish (state=$($jb.state))" }
  $imgs = @($jb.images)
  if ($imgs.Count -gt 0) {
    $one = $imgs[0]
    # Fetch via `url` (a /img/<cache-hash>_<name> route). `name` alone is the PRE-dedup
    # name and can point at a file that does not exist: the real one gets a "__32"
    # collision suffix that only shows up in `rel`/`cache`/`url`.
    $path = if ($one.url) { $one.url } elseif ($one.file) { '/img/' + (Split-Path -Leaf $one.file) } else { $null }
    $ir = Invoke-WebRequest -Uri "$base$path" -UseBasicParsing -TimeoutSec 60
    if ($ir.StatusCode -eq 200 -and $ir.Headers['Content-Type'] -match 'image') {
      Pass "GET $path -> $($ir.RawContentLength) bytes, $($ir.Headers['Content-Type'])"
    } else { Fail "GET $path -> $($ir.StatusCode) $($ir.Headers['Content-Type'])" }
  }
} catch { Fail "image -> $($_.Exception.Message)" }

# ------------------------------------------------------------------- 6. verdict
Head 'verdict'
if ($script:fails -eq 0) { Write-Host '  ALL CHECKS PASSED' -ForegroundColor Green }
else { Write-Host "  $($script:fails) CHECK(S) FAILED" -ForegroundColor Red }
$fin = ((GetJson '/api/state' 60).Content | ConvertFrom-Json)
Say "  final mode=$($fin.mode) vram=$($fin.gpu.used) MiB  chatAlive=$($fin.chat.alive) imageAlive=$($fin.image.alive)"
exit $script:fails
