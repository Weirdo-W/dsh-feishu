<#
.SYNOPSIS
    停止飞书-DSH 桥。
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$pidFile = Join-Path $root 'bridge.pid'
if (Test-Path $pidFile) {
    $procId = [int](Get-Content $pidFile)
    Get-Process -Id $procId -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Remove-Item $pidFile -ErrorAction SilentlyContinue
    Write-Host "已停止 PID=$procId" -ForegroundColor Green
} else {
    # 兜底：按命令行匹配
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*dsh-feishu*src*index.js*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "已停止 PID=$($_.ProcessId)" }
    Write-Host '完成。' -ForegroundColor Green
}
