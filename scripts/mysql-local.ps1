<#
  تشغيل MySQL المثبت محليًا (بدون Docker وبدون صلاحيات مدير) لبيئة التطوير.

    powershell -ExecutionPolicy Bypass -File scripts/mysql-local.ps1 init     # مرة واحدة
    powershell -ExecutionPolicy Bypass -File scripts/mysql-local.ps1 start
    powershell -ExecutionPolicy Bypass -File scripts/mysql-local.ps1 stop
    powershell -ExecutionPolicy Bypass -File scripts/mysql-local.ps1 status

  البيانات في %LOCALAPPDATA%\lawha-mysql (خارج المستودع)، والخادم يستمع على 127.0.0.1 فقط.
  يقرأ MYSQL_DATABASE وMYSQL_USER وMYSQL_PASSWORD وMYSQL_ROOT_PASSWORD وMYSQL_PORT من .env.
  مسار MySQL الافتراضي: C:\Program Files\MySQL\MySQL Server 8.4 (يمكن تغييره بـ MYSQL_HOME).
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('init', 'start', 'stop', 'status')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$mysqlHome = if ($env:MYSQL_HOME) { $env:MYSQL_HOME } else { 'C:\Program Files\MySQL\MySQL Server 8.4' }
$bin = Join-Path $mysqlHome 'bin'
$base = Join-Path $env:LOCALAPPDATA 'lawha-mysql'
$dataDir = Join-Path $base 'data'
$ini = Join-Path $base 'my.ini'
$logFile = Join-Path $base 'mysqld.log'

function Read-DotEnv {
  $path = Join-Path $repo '.env'
  if (-not (Test-Path $path)) { throw '.env غير موجود. انسخ .env.example إلى .env أولًا.' }
  $values = @{}
  foreach ($line in Get-Content -Encoding UTF8 $path) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') {
      $values[$Matches[1]] = $Matches[2].Trim().Trim('"')
    }
  }
  foreach ($key in 'MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_ROOT_PASSWORD') {
    if (-not $values[$key]) { throw "$key مطلوب في .env" }
  }
  if (-not $values['MYSQL_PORT']) { $values['MYSQL_PORT'] = '3306' }
  return $values
}

function Invoke-Mysql([string]$sql, [string]$rootPassword) {
  # كلمة المرور عبر متغير بيئة مؤقت لا عبر سطر الأوامر.
  $env:MYSQL_PWD = $rootPassword
  try {
    $sql | & (Join-Path $bin 'mysql.exe') --protocol=TCP -h 127.0.0.1 -P $cfg.MYSQL_PORT -uroot --default-character-set=utf8mb4
    if ($LASTEXITCODE -ne 0) { throw 'فشل تنفيذ أمر SQL' }
  } finally {
    Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue
  }
}

function Test-Running([string]$rootPassword) {
  $ErrorActionPreference = 'Continue'
  $env:MYSQL_PWD = $rootPassword
  try {
    & (Join-Path $bin 'mysqladmin.exe') --protocol=TCP -h 127.0.0.1 -P $cfg.MYSQL_PORT -uroot ping 2>&1 | Out-Null
    return $LASTEXITCODE -eq 0
  } finally {
    Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue
  }
}

function Start-Server([string]$rootPassword) {
  if (Test-Running $rootPassword) { Write-Host 'MySQL يعمل بالفعل.'; return }
  Start-Process -FilePath (Join-Path $bin 'mysqld.exe') -ArgumentList "--defaults-file=`"$ini`"" -WindowStyle Hidden
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Running $rootPassword) { Write-Host "MySQL يعمل على 127.0.0.1:$($cfg.MYSQL_PORT)"; return }
  }
  throw "لم يبدأ MySQL خلال 30 ثانية. راجع $logFile"
}

if (-not (Test-Path (Join-Path $bin 'mysqld.exe'))) { throw "لم يُعثر على MySQL في $mysqlHome" }
$cfg = Read-DotEnv

switch ($Action) {
  'init' {
    if (Test-Path $dataDir) { throw "مجلد البيانات موجود بالفعل: $dataDir" }
    New-Item -ItemType Directory -Force $base | Out-Null
    $iniContent = @"
[mysqld]
basedir="$($mysqlHome -replace '\\','/')"
datadir="$($dataDir -replace '\\','/')"
port=$($cfg.MYSQL_PORT)
bind-address=127.0.0.1
mysqlx=OFF
character-set-server=utf8mb4
collation-server=utf8mb4_0900_ai_ci
default-time-zone=+00:00
log-error="$($logFile -replace '\\','/')"
"@
    [IO.File]::WriteAllText($ini, $iniContent, (New-Object Text.UTF8Encoding $false))
    & (Join-Path $bin 'mysqld.exe') "--defaults-file=$ini" --initialize-insecure
    if ($LASTEXITCODE -ne 0) { throw "فشلت تهيئة MySQL. راجع $logFile" }
    Start-Server ''

    $db = $cfg.MYSQL_DATABASE; $user = $cfg.MYSQL_USER
    $pass = $cfg.MYSQL_PASSWORD -replace "'", "''"
    $rootPass = $cfg.MYSQL_ROOT_PASSWORD -replace "'", "''"
    $sql = @"
CREATE DATABASE IF NOT EXISTS ``$db`` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS ``${db}_test`` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS ``${db}_shadow`` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS '$user'@'localhost' IDENTIFIED BY '$pass';
CREATE USER IF NOT EXISTS '$user'@'127.0.0.1' IDENTIFIED BY '$pass';
GRANT ALL PRIVILEGES ON ``$db``.* TO '$user'@'localhost', '$user'@'127.0.0.1';
GRANT ALL PRIVILEGES ON ``${db}_test``.* TO '$user'@'localhost', '$user'@'127.0.0.1';
GRANT ALL PRIVILEGES ON ``${db}_shadow``.* TO '$user'@'localhost', '$user'@'127.0.0.1';
ALTER USER 'root'@'localhost' IDENTIFIED BY '$rootPass';
FLUSH PRIVILEGES;
"@
    Invoke-Mysql $sql ''
    Write-Host "تمت التهيئة: القواعد $db و${db}_test و${db}_shadow والمستخدم $user. البيانات في $dataDir"
  }
  'start' { Start-Server $cfg.MYSQL_ROOT_PASSWORD }
  'stop' {
    if (-not (Test-Running $cfg.MYSQL_ROOT_PASSWORD)) { Write-Host 'MySQL متوقف.'; break }
    $env:MYSQL_PWD = $cfg.MYSQL_ROOT_PASSWORD
    try { & (Join-Path $bin 'mysqladmin.exe') --protocol=TCP -h 127.0.0.1 -P $cfg.MYSQL_PORT -uroot shutdown }
    finally { Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue }
    Write-Host 'تم إيقاف MySQL.'
  }
  'status' {
    if (Test-Running $cfg.MYSQL_ROOT_PASSWORD) { Write-Host "MySQL يعمل على 127.0.0.1:$($cfg.MYSQL_PORT)" }
    else { Write-Host 'MySQL متوقف.' }
  }
}
