param(
    [ValidateSet('setup', 'user', 'admin', 'stop', 'check')]
    [string]$Action = 'user',
    [switch]$SkipBrowser
)
$ErrorActionPreference = 'Stop'
$portableRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$portableNode = Join-Path $portableRoot 'runtime\node.exe'
try {
    if (-not [Environment]::Is64BitOperatingSystem) { throw '请使用64位Windows 10/11（x64）电脑。' }
    if (-not (Test-Path -LiteralPath $portableNode -PathType Leaf)) { throw '缺少内置运行环境，请先完整解压整个ZIP，不要在压缩包内运行。' }
    if (-not (Test-Path -LiteralPath (Join-Path $portableRoot 'node_modules\express\package.json'))) { throw '依赖文件不完整，请重新完整解压整个ZIP。' }
    Push-Location -LiteralPath $portableRoot
    try {
        if ($Action -eq 'stop') {
            & (Join-Path $PSScriptRoot 'open-campus-print.ps1') -View stop -SkipBrowser
            if (-not $?) { throw '停止服务失败，请查看运行日志。' }
            return
        }
        $portableArguments = @()
        if (Test-Path -LiteralPath '.env') { $portableArguments = @('--env-file=.env') }
        if ($Action -eq 'check') {
            & $portableNode @portableArguments 'scripts/desktop/portable-check.js'
            if ($LASTEXITCODE -ne 0) { throw '运行环境检查未通过。' }
            return
        }
        $portableConfigCode = "const c=require('./backend/config').loadConfig();console.log(JSON.stringify({dbPath:c.dbPath,dataDir:c.dataDir,host:c.host,port:c.port,origin:c.publicOrigin}));"
        $portableSettingsJson = & $portableNode @portableArguments '-e' $portableConfigCode
        if ($LASTEXITCODE -ne 0) { throw '配置读取失败，请检查.env。' }
        $portableSettings = $portableSettingsJson | ConvertFrom-Json
        if ($Action -eq 'setup') {
            $portableRuntimeLock = Join-Path ([IO.Path]::GetDirectoryName($portableSettings.dbPath)) 'campus-print.runtime.lock'
            if (Test-Path -LiteralPath $portableRuntimeLock) { throw '服务正在运行或存在未处理的运行锁，请先停止服务再设置。' }
            & $portableNode @portableArguments 'scripts/desktop/portable-check.js'
            if ($LASTEXITCODE -ne 0) { throw '请先解决运行环境问题。' }
            if (-not (Test-Path -LiteralPath '.env')) {
                Copy-Item -LiteralPath '.env.example' -Destination '.env' -ErrorAction Stop
            }
            & $portableNode '--env-file=.env' 'scripts/backend/init-db.js'
            if ($LASTEXITCODE -ne 0) { throw '数据库初始化失败。' }
            $portableAdminProbe = "const {loadConfig}=require('./backend/config');const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(loadConfig().dbPath,{readOnly:true});try{console.log(d.prepare('SELECT count(*) AS n FROM users WHERE role=?').get('admin').n);}finally{d.close();}"
            $portableAdminCount = & $portableNode '--env-file=.env' '-e' $portableAdminProbe
            if ($LASTEXITCODE -ne 0) { throw '无法核对管理员状态。' }
            if ([int]$portableAdminCount -eq 0) {
                Write-Host '请创建这台电脑的管理员。没有默认账号或默认密码。'
                & $portableNode '--env-file=.env' 'scripts/backend/init-admin.js'
                if ($LASTEXITCODE -ne 0) { throw '管理员尚未创建。请重新运行首次设置。' }
            } else {
                Write-Host '已有管理员，保留现有账号与密码。'
            }
            Write-Host '首次设置已完成。请双击“02-启动用户端”或“03-启动经营后台”。'
            return
        }
        if (-not (Test-Path -LiteralPath '.env')) { throw '请先双击“01-首次设置”创建本机管理员，再启动。' }
        $portableBaseUrl = if ($portableSettings.origin) { $portableSettings.origin } else { 'http://127.0.0.1:' + $portableSettings.port }
        $portableExisting = $null
        try { $portableExisting = Invoke-RestMethod -Uri ($portableBaseUrl + '/api/public/config') -TimeoutSec 2 } catch { }
        if ($portableExisting.success) {
            $portableInstancePath = Join-Path $portableSettings.dataDir 'desktop-control\instance.json'
            if (-not (Test-Path -LiteralPath $portableInstancePath)) { throw '此端口已运行其他副本，请先使用那个副本的停止入口，或修改本包.env中的PORT。' }
            $portableInstance = Get-Content -LiteralPath $portableInstancePath -Raw | ConvertFrom-Json
            if (-not (Get-Process -Id ([int]$portableInstance.pid) -ErrorAction SilentlyContinue)) { throw '此端口已有服务，但本副本的运行记录已失效，请先核对端口。' }
        }
        & (Join-Path $PSScriptRoot 'open-campus-print.ps1') -View $Action -SkipBrowser:$SkipBrowser
        if (-not $?) { throw '启动失败，请查看var\desktop-logs中的日志。' }
    } finally { Pop-Location }
} catch {
    Write-Host ('操作未完成：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
