param(
    [Parameter(Mandatory=$true)][ValidateSet('compile','inspect')][string]$Mode,
    [Parameter(Mandatory=$true)][string]$Source,
    [string]$Destination
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
if ($Mode -eq 'compile') {
    Add-Type -Path $Source -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll') -OutputAssembly $Destination -OutputType ConsoleApplication
    exit 0
}
Add-Type -Path $Source -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
try {
    $policySelfTest = [BashVisualizationWindowsInspector]::VerifierPolicySelfTest()
    [Console]::WriteLine((ConvertTo-Json -Compress -Depth 10 @{event='ready'; verifierPolicySelfTest=$policySelfTest}))
    while ($null -ne ($line = [Console]::ReadLine())) {
        $request = $null
        try {
            $request = ConvertFrom-Json $line
            switch ($request.op) {
                'pin' { $value = [BashVisualizationWindowsInspector]::Pin([string]$request.key, [int]$request.pid, [string]$request.minimum, [string]$request.maximum, [string]$request.image, [string]$request.marker, [string]$request.expected) }
                'snapshot' { $value = [BashVisualizationWindowsInspector]::Snapshot([string]$request.key, [string]$request.exitDeadline) }
                'kill' { $value = [BashVisualizationWindowsInspector]::Kill([string]$request.key) }
                default { throw 'Unsupported inspector operation' }
            }
            [Console]::WriteLine((ConvertTo-Json -Compress -Depth 10 @{id=$request.id; value=$value}))
        } catch {
            $response = @{id=$request.id; error=$_.Exception.Message}
            $native = $_.Exception
            while ($null -ne $native -and $native -isnot [BashVisualizationWindowsInspector+NativeQueryException]) { $native = $native.InnerException }
            if ($null -ne $native) {
                $response.nativeApi = $native.NativeApi
                $response.nativeError = $native.NativeErrorCode
                $response.exitRechecked = $native.ExitRechecked
                $response.exitConfirmedAt = $native.ExitConfirmedAt
            }
            [Console]::WriteLine((ConvertTo-Json -Compress $response))
        }
    }
} finally {
    [BashVisualizationWindowsInspector]::Dispose()
}
