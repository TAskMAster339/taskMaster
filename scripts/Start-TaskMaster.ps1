param(
    [switch]$Dev,
    [switch]$BuildOnly
)

$ErrorActionPreference = "Stop"

if ($Dev -and $BuildOnly) {
    throw "Параметры -Dev и -BuildOnly нельзя использовать одновременно."
}

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if ((Test-Path (Join-Path $cargoBin "cargo.exe")) -and ($env:Path -notlike "*$cargoBin*")) {
    $env:Path = "$cargoBin;$env:Path"
}

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) {
    throw "Не найден npm. Установите Node.js LTS и повторите запуск."
}
$npmPath = $npmCommand.Source

if (-not (Test-Path (Join-Path $projectRoot "node_modules"))) {
    Write-Host "Установка зависимостей проекта..."
    & $npmPath ci
    if ($LASTEXITCODE -ne 0) {
        throw "npm ci завершился с ошибкой (код $LASTEXITCODE)."
    }
}

if ($Dev) {
    & $npmPath run tauri -- dev
    if ($LASTEXITCODE -ne 0) {
        throw "Запуск режима разработки завершился с ошибкой (код $LASTEXITCODE)."
    }
    exit 0
}

Write-Host "Сборка taskMaster..."
& $npmPath run tauri -- build --no-bundle
if ($LASTEXITCODE -ne 0) {
    throw "Сборка завершилась с ошибкой (код $LASTEXITCODE)."
}

if ($BuildOnly) {
    Write-Host "Готово: $projectRoot\src-tauri\target\release\taskmaster.exe"
    exit 0
}

$appPath = Join-Path $projectRoot "src-tauri\target\release\taskmaster.exe"
if (-not (Test-Path $appPath)) {
    throw "Сборка завершилась, но исполняемый файл не найден: $appPath"
}

Write-Host "Запуск taskMaster..."
& $appPath
if ($LASTEXITCODE -ne 0) {
    throw "Приложение завершилось с ошибкой (код $LASTEXITCODE)."
}
