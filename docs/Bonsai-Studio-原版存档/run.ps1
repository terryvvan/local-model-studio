# Ternary Bonsai 2 27B launcher (PrismML llama.cpp fork, Windows CUDA 12.4)
#
#   .\run.ps1 orig                 -> published model behaviour (no adapter)
#   .\run.ps1 abl                  -> OrcaBonsai refusal ablation, scale 1
#   .\run.ps1 abl2 -server         -> scale 2 (see the --lora-scaled note below)
#   .\run.ps1 orig -p "hi"         -> single prompt, non-interactive
#   .\run.ps1 orig -c 32768 -n 16384 -effort medium
#   .\run.ps1 abl -server          -> OpenAI-compatible API on http://127.0.0.1:8081/v1
#
# SCALE-2 GOTCHA: --lora-scaled <path>:<scale> is unusable with a Windows path --
# the build splits FNAME:SCALE on the last colon, finds the drive letter "F:", and
# dies with 'lora-scaled format: FNAME:SCALE'. abl2 therefore loads the adapter
# UNapplied and sets the scale at runtime:
#   POST http://127.0.0.1:<port>/lora-adapters   [{"id":0,"scale":2.0}]
# That endpoint answers with a BARE object (not {"value":[...]}) when only one
# adapter is loaded. On the CLI there is no runtime route, so use '-server' mode
# for scale 2 -- it is the only supported path.
#
# Only ONE instance at a time: the 5.95 GB pack plus KV cache fills an 8 GB card.
# ASCII only on purpose: PowerShell 5.1 reads BOM-less non-ASCII scripts as ANSI.
param(
    [Parameter(Position = 0)][string]$Mode = 'orig',
    [string]$p = '',
    [int]$c = 8192,
    [int]$n = 16384,
    [int]$ngl = 999,
    [ValidateSet('none', 'medium', 'low', 'xhigh')][string]$effort = 'medium',
    [switch]$server,
    [int]$port = 8081
)

$ErrorActionPreference = 'Stop'
$root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe     = Join-Path $root 'llamacpp\bin\llama-cli.exe'
$srvExe  = Join-Path $root 'llamacpp\bin\llama-server.exe'
$model   = Join-Path $root 'models\Ternary-Bonsai-2-27B-PTQ1_0.gguf'
$adapter = Join-Path $root 'lora\bonsai-abliterate-lora.gguf'

if (!(Test-Path $exe))     { throw "missing binary: $exe" }
if (!(Test-Path $model))   { throw "missing model: $model" }

# The binary directory must be first on PATH so the cudart DLLs resolve.
$env:PATH = (Join-Path $root 'llamacpp\bin') + ';' + $env:PATH

$loraArgs = @()
switch ($Mode) {
    'orig' { }
    'abl'  {
        if (!(Test-Path $adapter)) { throw "missing adapter: $adapter" }
        $loraArgs = @('--lora', $adapter)
    }
    'abl2' {
        if (!(Test-Path $adapter)) { throw "missing adapter: $adapter" }
        if (!$server) { throw "mode abl2 needs -server (runtime scaling; --lora-scaled cannot parse a Windows path)" }
        $loraArgs = @('--lora-init-without-apply', '--lora', $adapter)
    }
    default { throw "unknown mode '$Mode' (use orig, abl or abl2)" }
}

# Thinking mode sampling, per the model card. Greedy (-t 0) is used for A/B runs
# so the two modes can be compared token for token.
$common = @(
    '-m', $model,
    '--no-mmap',
    '-ngl', "$ngl",
    '-fa', 'on',
    '-c', "$c",
    '--temp', '0',
    '--top-k', '1',
    '--top-p', '1.0',
    '--min-p', '0',
    '--repeat-penalty', '1.0',
    '--no-warmup',
    '--reasoning-effort', $effort,
    '-sys', 'You are a helpful assistant.'
)

if ($server) {
    # OpenAI-compatible endpoint on http://127.0.0.1:$port -- keep this window open.
    # -n is meaningless to the server; the client sends max_tokens instead.
    $srvArgs = $common + @('-np', '1', '--cache-ram', '8192', '--host', '127.0.0.1', '--port', "$port")
    Write-Host "mode=$Mode ctx=$c ngl=$ngl effort=$effort  server: http://127.0.0.1:$port"
    if ($Mode -eq 'abl2') {
        Write-Host ""
        Write-Host "abl2 starts at scale 1.0 -- over-drive it once the server is up:"
        Write-Host ("  Invoke-RestMethod http://127.0.0.1:{0}/lora-adapters -Method Post ``" -f $port)
        Write-Host "      -ContentType 'application/json' -Body '[{`"id`":0,`"scale`":2.0}]'"
        Write-Host ""
    }
    & $srvExe @srvArgs @loraArgs
    exit $LASTEXITCODE
}

$common += @('-n', "$n")
# NOTE: this build has no --no-conversation; -st with a predefined -p is already
# non-interactive, and without -p it drops into the interactive chat loop.
if ($p -ne '') { $common += @('-p', $p, '-st') }

Write-Host "mode=$Mode ctx=$c n=$n ngl=$ngl effort=$effort"
Write-Host "cmd: $exe $($common -join ' ') $($loraArgs -join ' ')"
& $exe @common @loraArgs
