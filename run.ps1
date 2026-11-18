<#
.SYNOPSIS
    启动飞书 ⇄ DSH 桥（前台运行，Ctrl+C 退出）。
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { throw '找不到 node，请先安装 Node.js（>=18）。' }

if (-not (Test-Path (Join-Path $root 'node_modules\@larksuiteoapi\node-sdk'))) {
    Write-Host '首次运行，安装依赖…'
    npm install --no-audit --no-fund --ignore-scripts
}
if (-not (Test-Path (Join-Path $root 'config.json'))) {
    throw '缺少 config.json，请先复制 config.example.json 为 config.json 并填写 AppID/AppSecret。'
}

$pidFile = Join-Path $root 'bridge.pid'
$p = Start-Process -FilePath $node.Source -ArgumentList @((Join-Path $root 'src\index.js')) `
    -WorkingDirectory $root -PassThru -NoNewWindow
Set-Content -LiteralPath $pidFile -Value $p.Id -Encoding ascii
Write-Host "桥已启动 PID=$($p.Id)。Ctrl+C 结束。"
try {
    while (-not $p.HasExited) { Start-Sleep -Seconds 3 }
    Write-Host "进程退出，exit=$($p.ExitCode)"
}
finally {
    if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
}
