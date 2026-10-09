# Multimodal probe: the built-in web UI has no image upload because the server is started
# WITHOUT --mmproj. This measures what actually changes when the vision tower is attached:
# does /props report vision, does /v1/chat/completions accept an image_url part, how much
# VRAM does the projector cost, and what happens to decode speed.
# ASCII only (PowerShell 5.1 mangles non-ASCII source without BOM).
param(
    [string]$Bin = 'F:\v\project\dsh-test\bonsai\llamacpp\bin',
    [string]$Model = 'F:\v\project\dsh-test\bonsai\models\Ternary-Bonsai-2-27B-PTQ1_0.gguf',
    [string]$Mmproj = 'F:\v\project\dsh-test\bonsai\models\Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf',
    [string]$Image = 'C:\Users\LEGION\Pictures\带状孢疹减毒活疫苗和重组带状疱疹疫苗.png',
    [string]$OutDir = 'F:\v\project\dsh-test\bonsai\results',
    [int]$Ctx = 8192,
    [int]$Port = 8091
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$env:PATH = $Bin + ';' + $env:PATH

if (-not (Test-Path $Mmproj)) { throw "mmproj not found: $Mmproj" }
if (-not (Test-Path $Image)) { Write-Host "image not found, picking another"; $Image = (Get-ChildItem 'C:\Windows\Web\Screen' -Filter *.jpg | Select-Object -First 1).FullName }
Write-Host ("image: {0}" -f $Image)

# --image-min-tokens 1024 is the PrismML README's recommendation for small/grounding images.
$argv = @('-m', $Model, '--mmproj', $Mmproj, '--no-mmap', '-ngl', '99', '-fa', 'on',
          '-c', "$Ctx", '-np', '1', '--cache-ram', '4096', '--image-min-tokens', '1024',
          '--host', '127.0.0.1', '--port', "$Port")
$proc = Start-Process -FilePath (Join-Path $Bin 'llama-server.exe') -ArgumentList $argv -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $OutDir 'server-mmproj.log') `
    -RedirectStandardError (Join-Path $OutDir 'server-mmproj.err.log')
Write-Host ("launched pid {0}" -f $proc.Id)

$sw = [Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt 900) {
    if ($proc.HasExited) {
        Write-Host "server exited early; stderr tail:"
        Get-Content (Join-Path $OutDir 'server-mmproj.err.log') -Encoding UTF8 | Select-Object -Last 25
        return
    }
    try { if ((Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 5).status -eq 'ok') { break } } catch { Start-Sleep -Seconds 3 }
}
Write-Host ("health ok in {0:N0}s" -f $sw.Elapsed.TotalSeconds)

"=== /props modalities ==="
$p = Invoke-RestMethod "http://127.0.0.1:$Port/props" -TimeoutSec 30
"modalities : {0}" -f ($p.modalities | ConvertTo-Json -Compress)
"n_ctx      : {0}" -f $p.default_generation_settings.n_ctx
"=== nvidia-smi（带视觉塔的占用） ==="
nvidia-smi --query-gpu=memory.used --format=csv,noheader

function Send-Chat {
    param([string]$Label, [object[]]$Content, [int]$MaxTok = 400)
    $body = @{
        messages    = @(@{ role = 'user'; content = $Content })
        max_tokens  = $MaxTok
        temperature = 0.3
    } | ConvertTo-Json -Depth 12 -Compress
    Write-Host ""
    Write-Host ("=== {0} ===" -f $Label)
    $t = [Diagnostics.Stopwatch]::StartNew()
    try {
        $r = Invoke-RestMethod "http://127.0.0.1:$Port/v1/chat/completions" -Method Post `
            -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 1800
        $t.Stop()
        $txt = [string]$r.choices[0].message.content
        "OK in {0:N1}s | prompt {1} tok ({2:N0} tok/s) | gen {3} tok ({4:N1} tok/s)" -f `
            $t.Elapsed.TotalSeconds, $r.usage.prompt_tokens, $r.timings.prompt_per_second, `
            $r.usage.completion_tokens, $r.timings.predicted_per_second
        "answer: " + (($txt -replace '\s+', ' ').Trim())
    } catch {
        $t.Stop()
        "FAILED after {0:N1}s: {1}" -f $t.Elapsed.TotalSeconds, $_.Exception.Message
        if ($_.ErrorDetails.Message) { "server said: " + $_.ErrorDetails.Message }
    }
}

# 1) does the OpenAI-compatible endpoint accept an image_url data URL?
$bytes = [System.IO.File]::ReadAllBytes($Image)
$b64 = [Convert]::ToBase64String($bytes)
$mime = if ($Image -like '*.png') { 'image/png' } else { 'image/jpeg' }
Write-Host ("base64 payload: {0:N2} MB" -f ($b64.Length / 1MB))
$dataUrl = "data:$mime;base64,$b64"

Send-Chat -Label 'text only (sanity)' -Content @(@{ type = 'text'; text = 'Reply with one short sentence: what is 17 times 23?' }) -MaxTok 200

Send-Chat -Label 'image via /v1/chat/completions image_url' -Content @(
    @{ type = 'text'; text = 'Describe this image in two sentences. Reply in Chinese.' },
    @{ type = 'image_url'; image_url = @{ url = $dataUrl } }
) -MaxTok 500

Write-Host ""
Write-Host "=== server stderr: multimodal lines ==="
Get-Content (Join-Path $OutDir 'server-mmproj.err.log') -Encoding UTF8 -ErrorAction SilentlyContinue |
    Select-String -Pattern 'mmproj|clip|vision|image|projector|mtmd' | Select-Object -Last 12 | ForEach-Object { $_.Line }

if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
Write-Host ""
Write-Host "server stopped"
