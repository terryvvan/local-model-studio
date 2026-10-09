# Follow-up to ollama-test.ps1: the import SUCCEEDED (Ollama 0.23.2 parsed the Prism GGUF
# with its private ternary tensor types and registered it as a model). The open question
# is now the one that matters: does it produce coherent text, or the garbage that the
# PrismML docs predict for a runtime without the Hadamard rotation?
#
# Also settles the second question -- can the OrcaBonsai LoRA ride along in Ollama?
# ASCII only (PowerShell 5.1 mangles non-ASCII source without BOM).
param(
    [string]$Ollama = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
    [string]$Lora = 'F:\v\project\dsh-test\bonsai\lora\bonsai-abliterate-lora.gguf',
    [string]$OutDir = 'F:\v\project\dsh-test\bonsai\results',
    [string]$Name = 'bonsai-test',
    [string]$Port = '11434',
    [int]$MaxTok = 400
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:OLLAMA_HOST = "127.0.0.1:$Port"

$srv = Start-Process -FilePath $Ollama -ArgumentList 'serve' -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $OutDir 'ollama-serve2.log') `
    -RedirectStandardError (Join-Path $OutDir 'ollama-serve2.err.log')
$sw = [Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt 120) {
    try { [void](Invoke-RestMethod "http://127.0.0.1:$Port/api/version" -TimeoutSec 5); break } catch { Start-Sleep -Seconds 2 }
}

function Invoke-Ollama {
    param([string]$Model, [string]$Prompt, [int]$NumPredict, [string]$Label)
    $body = @{
        model    = $Model
        prompt   = $Prompt
        stream   = $false
        think    = $false
        options  = @{ num_predict = $NumPredict; temperature = 0.7; num_ctx = 8192 }
    } | ConvertTo-Json -Depth 5 -Compress
    Write-Host ""
    Write-Host ("=== {0} ===" -f $Label)
    $t = [Diagnostics.Stopwatch]::StartNew()
    try {
        $r = Invoke-RestMethod "http://127.0.0.1:$Port/api/generate" -Method Post `
            -ContentType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 900
        $t.Stop()
        $txt = [string]$r.response
        $evalCount = $r.eval_count
        $evalDur = $r.eval_duration
        $tps = if ($evalDur -and $evalDur -gt 0) { [math]::Round($evalCount / ($evalDur / 1e9), 2) } else { 0 }
        "answer ({0} chars, {1} tokens, {2:N0}s):" -f $txt.Length, $evalCount, $t.Elapsed.TotalSeconds
        $show = if ($txt.Length -gt 1200) { $txt.Substring(0, 1200) } else { $txt }
        $show
        "--- timing: load {0} ms | prompt_eval {1} tok / {2} ms | eval {3} tok / {4} ms => {5} t/s" -f `
            $r.load_duration, $r.prompt_eval_count, [int]($r.prompt_eval_duration / 1e6), $evalCount, [int]($evalDur / 1e6), $tps
    } catch {
        $t.Stop()
        "FAILED after {0:N0}s: {1}" -f $t.Elapsed.TotalSeconds, $_.Exception.Message
        if ($_.ErrorDetails.Message) { "server said: " + $_.ErrorDetails.Message }
    }
}

try {
    Write-Host "=== models registered ==="
    (& $Ollama list 2>&1) | Select-Object -Last 5

    # A factual question with one right answer -- garbage output is unmistakable.
    Invoke-Ollama -Model $Name -Prompt 'Reply with exactly one short sentence: what is 17 times 23?' -NumPredict $MaxTok -Label 'arithmetic sanity check'
    Invoke-Ollama -Model $Name -Prompt 'In one sentence, what is the capital of France?' -NumPredict $MaxTok -Label 'facts sanity check'

    Write-Host ""
    Write-Host "=== can the OrcaBonsai LoRA ride along? ==="
    $mf = Join-Path $OutDir 'Modelfile.bonsai-lora'
    @(
        "FROM $Name",
        "ADAPTER $Lora"
    ) | Set-Content $mf -Encoding ASCII
    Get-Content $mf
    $log = Join-Path $OutDir 'ollama-create-lora.log'
    $job = Start-Process -FilePath $Ollama -ArgumentList @('create', 'bonsai-lora-test', '-f', $mf) -PassThru -NoNewWindow `
        -RedirectStandardOutput $log -RedirectStandardError (Join-Path $OutDir 'ollama-create-lora.err.log')
    $t2 = [Diagnostics.Stopwatch]::StartNew()
    while (-not $job.HasExited -and $t2.Elapsed.TotalSeconds -lt 300) { Start-Sleep -Seconds 5 }
    if (-not $job.HasExited) { Stop-Process -Id $job.Id -Force; "create-with-ADAPTER still running after 5 min -> killed" }
    else { "create-with-ADAPTER exit code: {0}" -f $job.ExitCode }
    "--- stdout ---"
    Get-Content $log -ErrorAction SilentlyContinue | Select-Object -Last 12
    "--- stderr (strip ANSI) ---"
    (Get-Content (Join-Path $OutDir 'ollama-create-lora.err.log') -ErrorAction SilentlyContinue |
        ForEach-Object { $_ -replace "\x1b\[[0-9;?]*[a-zA-Z]", '' } |
        Where-Object { $_.Trim() -ne '' } | Select-Object -Last 12)
} finally {
    if (-not $srv.HasExited) { Stop-Process -Id $srv.Id -Force }
    Write-Host "ollama serve stopped"
}
