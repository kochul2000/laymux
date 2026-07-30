param(
    [Parameter(Mandatory = $true)][int]$Lines,
    [Parameter(Mandatory = $true)][string]$RunId,
    [Parameter(Mandatory = $true)][string]$TerminalId,
    [Parameter(Mandatory = $true)][string]$BarrierPath,
    [int]$FlushEvery = 1
)

$ErrorActionPreference = "Stop"
if ($Lines -lt 1) { throw "Lines must be positive" }
if ($FlushEvery -lt 1) { throw "FlushEvery must be positive" }

[Console]::Out.WriteLine("ARMED-{0}-{1}" -f $RunId, $TerminalId)
[Console]::Out.Flush()
while (-not [System.IO.File]::Exists($BarrierPath)) {
    Start-Sleep -Milliseconds 10
}

for ($index = 1; $index -le $Lines; $index += 1) {
    [Console]::Out.WriteLine(
        "L{0:D6}-{1}-{2}-0123456789abcdef0123456789abcdef" -f $index, $RunId, $TerminalId
    )
    if (($index % $FlushEvery) -eq 0) { [Console]::Out.Flush() }
}
[Console]::Out.WriteLine("FINAL-{0}-{1}-{2}" -f $RunId, $TerminalId, $Lines)
[Console]::Out.Flush()
