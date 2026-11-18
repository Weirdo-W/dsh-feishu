<#
.SYNOPSIS
    注册/卸载“登录时自动启动飞书-DSH 桥”的计划任务。
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install-autostart.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install-autostart.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string]$TaskName = 'DSH-Feishu-Bridge',
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "已删除计划任务: $TaskName" -ForegroundColor Green
    return
}

$runScript = Join-Path $PSScriptRoot 'run.ps1'
if (-not (Test-Path $runScript)) { throw "找不到 $runScript" }

$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$argLine = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $runScript
$action = New-ScheduledTaskAction -Execute $psExe -Argument $argLine
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Description '飞书 ⇄ DeepSeek Harness 桥' -Force | Out-Null
Write-Host "已注册计划任务: $TaskName" -ForegroundColor Green
Write-Host "手动启动验证: Start-ScheduledTask -TaskName $TaskName"
