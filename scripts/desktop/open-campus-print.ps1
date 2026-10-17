param(
    [ValidateSet('user', 'admin', 'stop')]
    [string]$View = 'user',
    [switch]$SkipBrowser
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$portableNode = Join-Path $projectRoot 'runtime\node.exe'
$nodePath = if (Test-Path -LiteralPath $portableNode -PathType Leaf) { $portableNode } else { (Get-Command node.exe -ErrorAction Stop).Source }
$mutex = $null
$ownsMutex = $false
try {
    Push-Location -LiteralPath $projectRoot
    try {
        $configurationCode = "const c=require('./backend/config').loadConfig();console.log(JSON.stringify({host:c.host,port:c.port,origin:c.publicOrigin,dataDir:c.dataDir}));"
        if (Test-Path -LiteralPath '.env') { $settingsJson = & $nodePath --env-file=.env -e $configurationCode }
        else { $settingsJson = & $nodePath -e $configurationCode }
        if ($LASTEXITCODE -ne 0) { throw '无法读取校园打印配置，请检查项目配置。' }
        $settings = $settingsJson | ConvertFrom-Json
    } finally { Pop-Location }
    $localHost = if ($settings.host -eq '::1') { '[::1]' } elseif ($settings.host -eq 'localhost') { 'localhost' } else { '127.0.0.1' }
    $baseUrl = if ($settings.origin) { $settings.origin } else { 'http://' + $localHost + ':' + $settings.port }
    $controlDirectory = Join-Path $settings.dataDir 'desktop-control'
    $instanceFile = Join-Path $controlDirectory 'instance.json'
    function Test-CampusService {
        try {
            $response = Invoke-RestMethod -Uri ($baseUrl + '/api/public/config') -TimeoutSec 2
            if ($response.success -and $response.data.product.id -eq 'campus-print-v1') { return $true }
            throw '此地址正在运行其他服务，请检查校园打印端口。'
        } catch {
            $networkFailure = $_.Exception
            while ($null -ne $networkFailure) {
                if ($networkFailure.GetType().FullName -in @('System.Net.WebException', 'System.Net.Http.HttpRequestException', 'System.Threading.Tasks.TaskCanceledException', 'System.OperationCanceledException', 'System.TimeoutException')) { return $false }
                $networkFailure = $networkFailure.InnerException
            }
            throw
        }
    }
    $hashAlgorithm = [Security.Cryptography.SHA256]::Create()
    try { $mutexSuffix = [BitConverter]::ToString($hashAlgorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectRoot))).Replace('-', '').Substring(0, 20) } finally { $hashAlgorithm.Dispose() }
    $mutex = New-Object Threading.Mutex($false, ('Local\CampusPrintDesktop-' + $mutexSuffix))
    $ownsMutex = $mutex.WaitOne(30000)
    if (-not $ownsMutex) { throw '另一入口正在启动，请稍后重新双击。' }
    if ($View -eq 'stop') {
        if (-not (Test-CampusService)) {
            if (Test-Path -LiteralPath $instanceFile) {
                $staleInstance = Get-Content -LiteralPath $instanceFile -Raw | ConvertFrom-Json
                $staleProcess = Get-Process -Id ([int]$staleInstance.pid) -ErrorAction SilentlyContinue
                if ($staleProcess) { throw '服务未监听，但原桌面进程仍存在；请先核对进程状态。' }
                Remove-Item -LiteralPath $instanceFile -Force
            }
            Write-Output '校园打印服务已停止。'
            return
        }
        if (-not (Test-Path -LiteralPath $instanceFile)) {
            if (Test-CampusService) { throw '当前服务不是由桌面入口启动，请回原启动终端按 Ctrl+C。' }
            Write-Output '校园打印服务已停止。'
            return
        }
        $instance = Get-Content -LiteralPath $instanceFile -Raw | ConvertFrom-Json
        $stopRequest = @{ instanceId = $instance.instanceId } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText((Join-Path $controlDirectory 'stop.json'), $stopRequest, (New-Object Text.UTF8Encoding($false)))
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            if (-not (Test-Path -LiteralPath $instanceFile)) { Write-Output '校园打印服务已停止。'; return }
            Start-Sleep -Milliseconds 500
        }
        throw '停止尚未结束。请等待正在处理的任务完成后再试。'
    }
    if (-not (Test-CampusService)) {
        $logDirectory = Join-Path $settings.dataDir 'desktop-logs'
        New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
        $serverArguments = if (Test-Path -LiteralPath (Join-Path $projectRoot '.env')) { @('--env-file=.env', 'scripts/desktop/service-host.js') } else { @('scripts/desktop/service-host.js') }
        $appProcess = Start-Process -FilePath $nodePath -ArgumentList $serverArguments -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDirectory 'service.stdout.log') -RedirectStandardError (Join-Path $logDirectory 'service.stderr.log')
        $started = $false
        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            if (Test-CampusService) { $started = $true; break }
            if ($appProcess.HasExited) { throw ('服务启动失败，请查看 ' + (Join-Path $logDirectory 'service.stderr.log')) }
            Start-Sleep -Milliseconds 500
        }
        if (-not $started) { throw '服务启动超时，请检查运行日志后重试。' }
    }
    $targetUrl = if ($View -eq 'admin') { $baseUrl + '/admin/' } else { $baseUrl + '/' }
    if (-not $SkipBrowser) { Start-Process -FilePath $targetUrl }
    Write-Output ('入口已就绪：' + $targetUrl)
} catch {
    if ($SkipBrowser) { Write-Error $_; exit 1 }
    Add-Type -AssemblyName System.Windows.Forms
    [Windows.Forms.MessageBox]::Show($_.Exception.Message, '校园打印', 'OK', 'Error') | Out-Null
    exit 1
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
