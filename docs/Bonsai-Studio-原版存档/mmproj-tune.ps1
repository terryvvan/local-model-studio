# Why was the first image request so slow? (4145 prompt tokens, 29 tok/s prefill, 154 s
# wall, and decode collapsed to 10 t/s vs 22 t/s for text.)
#
# Two suspects, and they need separating:
#   1. --image-min-tokens 1024 forcing the vision encoder to emit many image tokens
#   2. the batch config / image tiling itself
# Each config gets its OWN server (settings like --image-min-tokens are startup-only) and
# inside each server we run three requests in order: text, image, text-again. The last one
# is the tell -- if the second text request is still 10 t/s, the mmproj load permanently
# slows decode on this machine (very plausible: 7842/8188 MiB leaves almost no headroom).
# ASCII only (PowerShell 5.1 mangles non-ASCII source without BOM).
param(
    [string]$Bin = 'F:\v\project\dsh-test\bonsai\llamacpp\bin',
    [string]$Model = 'F:\v\project\dsh-test\bonsai\models\Ternary-Bonsai-2-27B-PTQ1_0.gguf',
    [string]$Mmproj = 'F:\v\project\dsh-test\bonsai\models\Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf',
    [string]$Image = 'C:\Windows\Web\Screen\img100.jpg',
    [string]$OutDir = 'F:\v\project\dsh-test\bonsai\results',
    [int]$Ctx = 8192,
    [int]$Port = 8093
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$env:PATH = $Bin + ';' + $env:PATH

$bytes = [System.IO.File]::ReadAllBytes($Image)
$dataUrl = "data:image/jpeg;base64," + [Convert]::ToBase64String($bytes)
Write-Host ("image {0} -> base64 {1:N2} MB" -f $Image, ($dataUrl.Length / 1MB))

function Wait-Health {
    param([int]$Port, [System.Diagnostics.Process]$Proc, [string]$ErrLog)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt 900) {
        if ($Proc.HasExited) { throw "server exited early; see $ErrLog" }
        try { if ((Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 5).status -eq 'ok') { return $sw.Elapsed.TotalSeconds } } catch { Start-Sleep -Seconds 3 }
    }
    throw "health never became ok"
}

function Send-Req {
    param([int]$Port, [string]$Label, [object[]]$Content, [int]$MaxTok)
    $body = @{ messages = @(@{ role = 'user'; content = $Content }); max_tokens = $MaxTok; temperature = 0.3 } |
            ConvertTo-Json -Depth 12 -Compress
    $t = [Diagnostics.Stopwatch]::StartNew()
    try {
        $r = Invoke-RestMethod "http://127.0.0.1:$Port/v1/chat/completions" -Method Post `
            -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 1800
        $t.Stop()
        $row = [pscustomobject]@{
            label = $Label
            wall  = [math]::Round($t.Elapsed.TotalSeconds, 1)
            ptok  = $r.usage.prompt_tokens
            ptps  = [math]::Round($r.timings.prompt_per_second, 1)
            gtok  = $r.usage.completion_tokens
            gtps  = [math]::Round($r.timings.predicted_per_second, 1)
            head  = (([string]$r.choices[0].message.content -replace '\s+', ' ').Trim())
        }
    } catch {
        $t.Stop()
        $row = [pscustomobject]@{ label = $Label; wall = [math]::Round($t.Elapsed.TotalSeconds, 1); ptok = -1; ptps = -1; gtok = -1; gtps = -1;
                                  head = "FAILED: " + $_.Exception.Message + " | " + $_.ErrorDetails.Message }
    }
    "{0,-22} wall {1,6:N1}s | prompt {2,5} tok @ {3,5:N1} t/s | gen {4,4} tok @ {5,5:N1} t/s" -f `
        $row.label, $row.wall, $row.ptok, $row.ptps, $row.gtok, $row.gtps
    return $row
}

$configs = @(
    [pscustomobject]@{ name = 'min-tokens 1024 + default batch'; extra = @('--image-min-tokens', '1024') },
    [pscustomobject]@{ name = 'min-tokens 256';                  extra = @('--image-min-tokens', '256') },
    [pscustomobject]@{ name = 'min-tokens 256 + big batch';      extra = @('--image-min-tokens', '256', '-b', '2048', '-ub', '512') }
)

$rows = @()
foreach ($c in $configs) {
    Write-Host ""
    Write-Host ("########## {0} ##########" -f $c.name)
    $tag = ($c.name -replace '[^a-zA-Z0-9]', '_')
    $argv = @('-m', $Model, '--mmproj', $Mmproj, '--no-mmap', '-ngl', '99', '-fa', 'on',
              '-c', "$Ctx", '-np', '1', '--cache-ram', '4096') + $c.extra +
            @('--host', '127.0.0.1', '--port', "$Port")
    $proc = Start-Process -FilePath (Join-Path $Bin 'llama-server.exe') -ArgumentList $argv -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $OutDir "mmproj-$tag.log") `
        -RedirectStandardError  (Join-Path $OutDir "mmproj-$tag.err.log")
    try {
        $up = Wait-Health -Port $Port -Proc $proc -ErrLog (Join-Path $OutDir "mmproj-$tag.err.log")
        Write-Host ("server up in {0:N0}s (pid {1})" -f $up, $proc.Id)
        $vramAfterLoad = (nvidia-smi --query-gpu=memory.used --format=csv,noheader) -replace ' MiB',''
        Write-Host ("VRAM after load: {0} MiB" -f $vramAfterLoad)

        $rows += (Send-Req -Port $Port -Label '1-text'        -Content @(@{ type = 'text'; text = 'Reply with one short sentence: what is 17 times 23?' }) -MaxTok 120) | ForEach-Object { $_ | Add-Member -NotePropertyName cfg -NotePropertyValue $c.name -PassThru }
        $rows += (Send-Req -Port $Port -Label '2-text+image'  -Content @(@{ type = 'text'; text = 'What is in this image? Answer in one sentence.' },
                                                                         @{ type = 'image_url'; image_url = @{ url = $dataUrl } }) -MaxTok 160) | ForEach-Object { $_ | Add-Member -NotePropertyName cfg -NotePropertyValue $c.name -PassThru }
        $rows += (Send-Req -Port $Port -Label '3-text-after'  -Content @(@{ type = 'text'; text = 'Reply with one short sentence: what is 12 times 12?' }) -MaxTok 120) | ForEach-Object { $_ | Add-Member -NotePropertyName cfg -NotePropertyValue $c.name -PassThru }

        "--- mmproj / image lines ---"
        Get-Content (Join-Path $OutDir "mmproj-$tag.err.log") -Encoding UTF8 -ErrorAction SilentlyContinue |
            Select-String -Pattern 'mmproj|multimodal|image|n_tokens|encode' | Select-Object -Last 6 | ForEach-Object { $_.Line }
    } catch {
        Write-Host ("CONFIG FAILED: {0}" -f $_.Exception.Message)
    } finally {
        if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
        Start-Sleep -Seconds 3
    }
}

$rows | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $OutDir 'mmproj-tune.json') -Encoding UTF8
Write-Host ""
Write-Host ("saved {0} rows to {1}" -f @($rows).Count, (Join-Path $OutDir 'mmproj-tune.json'))
