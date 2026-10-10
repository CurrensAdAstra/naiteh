# Start naiteh in Tauri dev mode from a PowerShell session.
#
# Refreshes PATH from the registry first, so tools installed with winget in
# this session (Node, rustup, Build Tools) are found without opening a new
# terminal. Also disables Corepack's interactive download prompt.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\dev.ps1 [-Install]

param(
    [switch]$Install  # run `pnpm install` before starting
)

$ErrorActionPreference = 'Stop'

$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [Environment]::GetEnvironmentVariable('Path', 'User')
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'

foreach ($tool in 'node', 'cargo') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "$tool not found on PATH. See README.md > Prerequisites > Windows."
    }
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    corepack enable
}

Set-Location (Join-Path $PSScriptRoot '..')

if ($Install -or -not (Test-Path 'node_modules')) {
    pnpm install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

pnpm tauri dev
exit $LASTEXITCODE
