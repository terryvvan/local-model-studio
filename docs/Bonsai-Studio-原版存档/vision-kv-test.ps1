# vision-kv-test.ps1 -- controlled A/B for image prefill cost.
# Drives the Bonsai Studio app API (so it also exercises the app, not just llama-server).
# ASCII only on purpose (PowerShell 5.1 reads .ps1 as ANSI without a BOM).
param(
  [string]$App = 'http://127.0.0.1:8788',
  [string]$Img = 'C:\Windows\Web\Screen\img100.jpg',
  [int]$MaxEdge = 1280,
  [int]$TimeoutSec = 420
)

Add-Type -AssemblyName System.Drawing

function Post($u, $o) {
  $b = [Text.Encoding]::UTF8.GetBytes(($o | ConvertTo-Json -Depth 8 -Compress))
  $r = [Net.HttpWebRequest]::Create($u); $r.Method = 'POST'; $r.ContentType = 'application/json'
  $r.Timeout = 600000; $r.ContentLength = $b.Length
  $s = $r.GetRequestStream(); $s.Write($b, 0, $b.Length); $s.Close()
  $resp = $r.GetResponse()
  (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd()
}

function Shrink([string]$path, [int]$maxEdge, [string]$out) {
  $src = [System.Drawing.Image]::FromFile($path)
  $scale = [Math]::Min(1.0, $maxEdge / [Math]::Max($src.Width, $src.Height))
  $w = [int][Math]::Round($src.Width * $scale); $h = [int][Math]::Round($src.Height * $scale)
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($src, 0, 0, $w, $h)
  $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $ps = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $ps.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 85L)
  $bmp.Save($out, $enc, $ps)
  $g.Dispose(); $bmp.Dispose(); $src.Dispose()
  return [pscustomobject]@{ file = $out; w = $w; h = $h; bytes = (Get-Item $out).Length }
}

$small = Join-Path $env:TEMP 'bonsai-vision-test.jpg'
$info = Shrink $Img $MaxEdge $small
Write-Host ("[img] {0}x{1} -> {2} bytes ({3:N0} KB)" -f $info.w, $info.h, $info.bytes, ($info.bytes / 1KB))

$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($small))
$dataUrl = "data:image/jpeg;base64,$b64"

function AskImage([string]$label) {
  $body = @{ messages = @(@{ role = 'user'; content = @(
    @{ type = 'text'; text = 'Describe this image in one short sentence.' },
    @{ type = 'image_url'; image_url = @{ url = $dataUrl } }
  ) }) } | ConvertTo-Json -Depth 12 -Compress

  $sw = [Diagnostics.Stopwatch]::StartNew()
  $req = [Net.HttpWebRequest]::Create("$App/api/chat"); $req.Method = 'POST'; $req.ContentType = 'application/json'
  $req.Timeout = $TimeoutSec * 1000
  $bb = [Text.Encoding]::UTF8.GetBytes($body); $req.ContentLength = $bb.Length
  $st = $req.GetRequestStream(); $st.Write($bb, 0, $bb.Length); $st.Close()
  $txt = ''; $t = $null; $err = ''
  try {
    $resp = $req.GetResponse()
    $sr = New-Object IO.StreamReader($resp.GetResponseStream())
    while (-not $sr.EndOfStream) {
      $l = $sr.ReadLine()
      if ($l -like 'data: *') {
        $d = $l.Substring(6); if ($d -eq '[DONE]') { continue }
        try { $j = $d | ConvertFrom-Json
          if ($j.choices[0].delta.content) { $txt += $j.choices[0].delta.content }
          if ($j.timings) { $t = $j.timings } } catch {}
      }
    }
  } catch { $err = $_.Exception.Message }
  $sw.Stop()
  $row = [pscustomobject]@{
    cfg = $label; wall_s = [Math]::Round($sw.Elapsed.TotalSeconds, 1)
    prompt_tok = if ($t) { $t.prompt_n } else { $null }
    prefill_tps = if ($t) { [Math]::Round($t.prompt_per_second, 1) } else { $null }
    gen_tok = if ($t) { $t.predicted_n } else { $null }
    gen_tps = if ($t) { [Math]::Round($t.predicted_per_second, 1) } else { $null }
    answer = $txt.Trim(); err = $err
  }
  Write-Host ("[{0}] wall={1}s prompt={2}tok @{3}t/s gen={4}tok @{5}t/s" -f $row.cfg, $row.wall_s, $row.prompt_tok, $row.prefill_tps, $row.gen_tok, $row.gen_tps)
  if ($row.answer) { Write-Host ("        -> {0}" -f $row.answer.Substring(0, [Math]::Min(160, $row.answer.Length))) }
  if ($row.err) { Write-Host ("        !! {0}" -f $row.err) }
  return $row
}

function ApplyCfg([hashtable]$kv) {
  $cur = Invoke-RestMethod "$App/api/state" -TimeoutSec 20
  $next = @{}
  foreach ($k in $cur.settings.PSObject.Properties.Name) { $next[$k] = $cur.settings.$k }
  foreach ($k in $kv.Keys) { $next[$k] = $kv[$k] }
  $r = Post "$App/api/settings" $next | ConvertFrom-Json
  Write-Host ("[cfg] {0} -> restarted={1} changed={2} err={3}" -f ($kv.Keys -join ','), $r.restarted, ($r.changed -join ','), $r.error)
  if ($r.restarted) {
    for ($i = 0; $i -lt 90; $i++) {
      Start-Sleep -Seconds 1
      try { $s = Invoke-RestMethod "$App/api/state" -TimeoutSec 10; if ($s.server.ready) { Write-Host ("      engine ready after {0}s" -f ($i + 1)); break } } catch {}
    }
  }
  Start-Sleep -Seconds 2
}

$results = @()

ApplyCfg @{ vision = $true; lora = 'none'; cacheTypeK = 'f16'; cacheTypeV = 'f16'; ctx = 16384; batch = 2048; ubatch = 512; reasoningEffort = 'none'; maxTokens = 300 }
$results += AskImage 'f16 KV, no LoRA'

ApplyCfg @{ vision = $true; lora = 'none'; cacheTypeK = 'q8_0'; cacheTypeV = 'q8_0'; ctx = 16384; batch = 2048; ubatch = 512; reasoningEffort = 'none'; maxTokens = 300 }
$results += AskImage 'q8_0 KV, no LoRA'

ApplyCfg @{ vision = $true; lora = 'orcabonsai'; loraScale = 2.0; cacheTypeK = 'f16'; cacheTypeV = 'f16'; ctx = 16384; batch = 2048; ubatch = 512; reasoningEffort = 'none'; maxTokens = 300 }
$results += AskImage 'f16 KV, LoRA scale 2'

$out = 'F:\v\project\dsh-test\bonsai\results\vision-kv.json'
$results | ConvertTo-Json -Depth 5 | Set-Content -Path $out -Encoding UTF8
Write-Host ""
Write-Host "=== summary ==="
$results | Format-Table cfg, wall_s, prompt_tok, prefill_tps, gen_tok, gen_tps -AutoSize
Write-Host "written: $out"
