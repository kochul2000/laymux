# PowerShell 5.1 호환. -Command 인자에서 큰따옴표가 변형되지 않도록 작은따옴표만 쓴다.
$global:__lmx_e = [string][char]27
$global:__lmx_b = [string][char]7
$global:__lmx_first = $true
$global:__lmx_running = $false
$global:__lmx_reader = $false

# 편집기의 키/검증/이력 설정을 바꾸지 않고 호스트에 반환되는 실행 단위를 관찰한다.
if ((Get-Module PSReadLine) -and (Test-Path Function:PSConsoleHostReadLine)) {
    $global:__lmx_reader = $true
    $global:__lmx_readline = $function:PSConsoleHostReadLine
    function global:PSConsoleHostReadLine {
        $line = & $global:__lmx_readline
        if (-not [string]::IsNullOrWhiteSpace($line)) {
            $tokens = $null; $parseErrors = $null
            $ast = [System.Management.Automation.Language.Parser]::ParseInput($line, [ref]$tokens, [ref]$parseErrors)
            if ($ast.EndBlock.Statements.Count -gt 0) {
                $previous = Get-History -Count 1
                $global:__lmx_history = if ($previous) { $previous.Id } else { -1 }
                $global:__lmx_running = $true
                # 성공 스트림에 쓰면 OSC가 명령 문자열에 섞이므로 호스트 UI에 직접 쓴다.
                $Host.UI.Write($global:__lmx_e + ']133;C' + $global:__lmx_b)
            }
        }
        return $line
    }
}

function global:prompt {
    # 다른 cmdlet이 $?를 덮기 전에 호스트 실행 결과를 캡처한다.
    $succeeded = $?
    $e = $global:__lmx_e; $b = $global:__lmx_b
    $r = ''
    if ($global:__lmx_running) {
        $global:__lmx_running = $false
        $last = Get-History -Count 1
        $r = $e + ']133;D'
        # Ctrl+C/이력 미관측은 결과 없는 종료다. 이전 native 종료 코드를 재사용하지 않는다.
        if ($last -and $last.Id -ne $global:__lmx_history -and $last.ExecutionStatus -ne 'Stopped') {
            $r += if ($succeeded) { ';0' } else { ';1' }
        }
        $r += $b
    } elseif ($global:__lmx_first -and $global:__lmx_reader) {
        $r = $e + ']133;A' + $b
    }
    $global:__lmx_first = $false
    $loc = (Get-Location).ProviderPath
    $cwd = $loc.Replace([char]92, '/')
    if ($cwd.StartsWith('//')) { $r += $e + ']7;' + $cwd + $b }
    else { $r += $e + ']7;file://localhost/' + $cwd + $b }
    return $r + 'PS ' + $loc + '> '
}
