/** Compiler-free Windows PowerShell 5.1 host. Stdout contains only the supervisor protocol. */
export const SHELL_WINDOWS_MONITOR = String.raw`param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false, $true)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$job = [IntPtr]::Zero
$attributes = [IntPtr]::Zero
$jobValue = [IntPtr]::Zero
$processList = [IntPtr]::Zero
$processInfo = [IntPtr]::Zero
$startup = [IntPtr]::Zero
$limits = [IntPtr]::Zero
$memory = [IntPtr]::Zero
$times = [IntPtr]::Zero
$attributesInitialized = $false
$handles = New-Object 'System.Collections.Generic.Dictionary[uint32,System.IntPtr]'
$commandId = [long]0
$phase = 'startup'
$failureCode = 'failed'
$exitCode = 1

function Write-Protocol([string]$Value) {
    [Console]::Out.WriteLine($Value)
    [Console]::Out.Flush()
}

function New-NativeMethod([string]$Name, [string]$Dll, [type]$ReturnType, [type[]]$ParameterTypes) {
    $method = $script:typeBuilder.DefinePInvokeMethod($Name, $Dll, $Name,
        [System.Reflection.MethodAttributes]'Public,Static,PinvokeImpl',
        [System.Reflection.CallingConventions]::Standard, $ReturnType, $ParameterTypes,
        [System.Runtime.InteropServices.CallingConvention]::Winapi,
        [System.Runtime.InteropServices.CharSet]::Unicode)
    $method.SetImplementationFlags([System.Reflection.MethodImplAttributes]::PreserveSig)
}

function New-ZeroBuffer([int]$Size) {
    $buffer = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($Size)
    try {
        [System.Runtime.InteropServices.Marshal]::Copy((New-Object byte[] $Size), 0, $buffer, $Size)
        return $buffer
    } catch {
        [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
        throw
    }
}

function Assert-Deadline([int]$Milliseconds) {
    if ($script:clock.ElapsedMilliseconds -ge $Milliseconds) {
        $script:failureCode = 'deadline'
        throw 'Native operation timed out.'
    }
}

function Read-Command {
    $script:inputLine.Length = 0
    while ($true) {
        $value = [Console]::In.Read()
        if ($value -lt 0) {
            if ($script:inputLine.Length -ne 0) { throw 'Incomplete command.' }
            return $null
        }
        if ($value -eq 10) { return $script:inputLine.ToString() }
        if ($value -gt 127 -or $script:inputLine.Length -ge 64) { throw 'Invalid command.' }
        [void]$script:inputLine.Append([char]$value)
    }
}

function Read-CommandId([string]$Line, [string]$Prefix) {
    $id = [long]0
    if (-not $Line.StartsWith($Prefix, [StringComparison]::Ordinal) -or
        -not [long]::TryParse($Line.Substring($Prefix.Length), [Globalization.NumberStyles]::None,
            [Globalization.CultureInfo]::InvariantCulture, [ref]$id) -or
        $id -le 0 -or $id -gt 9007199254740991L) { throw 'Invalid command id.' }
    return $id
}

function Assert-Argument([string]$Value) {
    if ($null -eq $Value -or $Value.IndexOf([char]0) -ge 0) { throw 'Invalid launch argument.' }
}

function Add-QuotedArgument([System.Text.StringBuilder]$Command, [string]$Value) {
    # CRT quoting doubles backslashes before quotes and before the closing quote.
    [void]$Command.Append([char]34)
    $slashes = 0
    for ($index = 0; $index -lt $Value.Length; $index++) {
        $current = $Value[$index]
        if ($current -eq [char]92) { $slashes++; continue }
        if ($current -eq [char]34) {
            [void]$Command.Append([char]92, (2 * $slashes + 1))
            [void]$Command.Append([char]34)
        } else {
            [void]$Command.Append([char]92, $slashes)
            [void]$Command.Append($current)
        }
        $slashes = 0
    }
    [void]$Command.Append([char]92, (2 * $slashes))
    [void]$Command.Append([char]34)
}

function Read-JobIds {
    $returned = [uint32]0
    if (-not $script:native::QueryInformationJobObject($script:job, 3, $script:processList,
        [uint32]$script:processListBytes, [ref]$returned)) { throw 'Job query failed.' }
    $assigned = [System.Runtime.InteropServices.Marshal]::ReadInt32($script:processList, 0)
    $count = [System.Runtime.InteropServices.Marshal]::ReadInt32($script:processList, 4)
    if ($assigned -ne $count -or $count -lt 0 -or $count -gt 4096 -or $returned -lt 8 -or
        $returned -gt $script:processListBytes -or $returned -lt (8 + $count * $script:pointerBytes)) {
        throw 'Incomplete job membership.'
    }
    $script:ids.Clear()
    $script:membership.Clear()
    for ($index = 0; $index -lt $count; $index++) {
        $pidValue = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($script:processList,
            (8 + $index * $script:pointerBytes)).ToInt64()
        if ($script:pointerBytes -eq 4) { $pidValue = $pidValue -band 4294967295L }
        if ($pidValue -le 0 -or $pidValue -gt [uint32]::MaxValue -or
            -not $script:membership.Add([uint32]$pidValue)) { throw 'Ambiguous job membership.' }
        $script:ids.Add([uint32]$pidValue)
    }
}

function Test-Exited([IntPtr]$Handle) {
    $waitResult = $script:native::WaitForSingleObject($Handle, 0)
    if ($waitResult -eq 0) { return $true }
    if ($waitResult -eq 258) { return $false }
    throw 'Process exit query failed.'
}

function Update-ProcessHandles {
    $script:removed.Clear()
    foreach ($item in $script:handles.GetEnumerator()) {
        Assert-Deadline 1000
        if (-not $script:membership.Contains($item.Key)) {
            # A fresh job list and an exited retained handle are both required for removal.
            if (-not (Test-Exited $item.Value)) { throw 'Missing live job member.' }
            $script:removed.Add($item.Key)
        }
    }
    foreach ($memberId in $script:removed) {
        if (-not $script:native::CloseHandle($script:handles[$memberId])) { throw 'Handle close failed.' }
        [void]$script:handles.Remove($memberId)
    }
    foreach ($memberId in $script:ids) {
        Assert-Deadline 1000
        if ($script:handles.ContainsKey($memberId)) { continue }
        # QUERY_INFORMATION, VM_READ and SYNCHRONIZE. Handles are never inheritable.
        $handle = $script:native::OpenProcess(0x00100410, $false, $memberId)
        if ($handle -eq [IntPtr]::Zero) { throw 'Process handle unavailable.' }
        try { $script:handles.Add($memberId, $handle) }
        catch { [void]$script:native::CloseHandle($handle); throw }
    }
}

function Read-WorkingSet([IntPtr]$Handle) {
    [System.Runtime.InteropServices.Marshal]::WriteInt32($script:memory, 0, $script:memoryBytes)
    if (-not $script:native::GetProcessMemoryInfo($Handle, $script:memory, [uint32]$script:memoryBytes)) {
        throw 'Process memory unavailable.'
    }
    # DWORD cb, DWORD PageFaultCount, SIZE_T PeakWorkingSetSize, SIZE_T WorkingSetSize.
    $bytes = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($script:memory,
        (8 + $script:pointerBytes)).ToInt64()
    if ($script:pointerBytes -eq 4) { $bytes = $bytes -band 4294967295L }
    if ($bytes -le 0 -or $bytes -gt 9007199254740991L) { throw 'Invalid working set.' }
    return $bytes
}

function Measure-Members {
    $script:memberBytes = [long]0
    $script:memberRssBytes.Clear()
    $script:includeBreakdown = $script:ids.Count -le 256
    foreach ($memberId in $script:ids) {
        Assert-Deadline 1000
        $handle = $script:handles[$memberId]
        $inJob = $false
        if (-not $script:native::IsProcessInJob($handle, $script:job, [ref]$inJob)) {
            throw 'Membership query failed.'
        }
        if (-not $inJob) {
            if (Test-Exited $handle) { return $false }
            throw 'Process is outside its job.'
        }
        if (Test-Exited $handle) { return $false }
        try { $workingSet = Read-WorkingSet $handle }
        catch {
            if (Test-Exited $handle) { return $false }
            throw
        }
        if ($workingSet -gt (9007199254740991L - $script:memberBytes)) { throw 'Working set overflow.' }
        $script:memberBytes += $workingSet
        if ($script:includeBreakdown) { $script:memberRssBytes.Add($workingSet) }
    }
    return $true
}

function Write-Sample([long]$Id) {
    $script:clock.Restart()
    Read-JobIds
    Update-ProcessHandles
    if (-not (Measure-Members)) {
        # One fresh snapshot may discard a short-lived member proven exited on its pinned handle.
        Assert-Deadline 1000
        Read-JobIds
        Update-ProcessHandles
        if (-not (Measure-Members)) { throw 'Unstable job membership.' }
    }
    Assert-Deadline 1000
    $helperBytes = Read-WorkingSet ($script:native::GetCurrentProcess())
    if ($helperBytes -gt (9007199254740991L - $script:memberBytes)) { throw 'Working set overflow.' }
    $bytes = $script:memberBytes + $helperBytes
    # Four native FILETIME values occupy independent eight-byte slots.
    if (-not $script:native::GetProcessTimes($script:native::GetCurrentProcess(), $script:times,
        [IntPtr]::Add($script:times, 8), [IntPtr]::Add($script:times, 16), [IntPtr]::Add($script:times, 24))) {
        throw 'Helper CPU unavailable.'
    }
    $kernelTicks = [System.Runtime.InteropServices.Marshal]::ReadInt64($script:times, 16)
    $userTicks = [System.Runtime.InteropServices.Marshal]::ReadInt64($script:times, 24)
    if ($kernelTicks -lt 0 -or $userTicks -lt 0 -or $kernelTicks -gt ([long]::MaxValue - $userTicks)) {
        throw 'Invalid helper CPU.'
    }
    $cpuMs = [long][Math]::Floor(($kernelTicks + $userTicks) / 10000.0)
    if ($cpuMs -gt 9007199254740991L) { throw 'Helper CPU overflow.' }
    $culture = [Globalization.CultureInfo]::InvariantCulture
    $script:response.Length = 0
    [void]$script:response.Append('{"event":"sample","id":').Append($Id.ToString($culture))
    [void]$script:response.Append(',"rssBytes":').Append($bytes.ToString($culture)).Append(',"pids":[')
    for ($index = 0; $index -lt $script:ids.Count; $index++) {
        if ($index -ne 0) { [void]$script:response.Append(',') }
        [void]$script:response.Append($script:ids[$index].ToString($culture))
    }
    [void]$script:response.Append('],"helperRssBytes":').Append($helperBytes.ToString($culture))
    if ($script:includeBreakdown) {
        [void]$script:response.Append(',"memberRssBytes":[')
        for ($index = 0; $index -lt $script:memberRssBytes.Count; $index++) {
            if ($index -ne 0) { [void]$script:response.Append(',') }
            [void]$script:response.Append($script:memberRssBytes[$index].ToString($culture))
        }
        [void]$script:response.Append(']')
    } else { [void]$script:response.Append(',"breakdownOmitted":true') }
    [void]$script:response.Append(',"cpuMs":').Append($cpuMs.ToString($culture)).Append('}')
    # Numeric-only ASCII stays below 64 KiB, including all 4096 permitted member ids.
    if ($script:response.Length -gt 65536) { throw 'Sample line too long.' }
    Assert-Deadline 1000
    Write-Protocol ($script:response.ToString())
}

function Stop-Job {
    $script:clock.Restart()
    if (-not $script:native::TerminateJobObject($script:job, 1)) { throw 'Job termination failed.' }
    while ($true) {
        Assert-Deadline 180
        Read-JobIds
        Assert-Deadline 180
        if ($script:ids.Count -eq 0) { return }
        [Threading.Thread]::Sleep(1)
    }
}

try {
    $config = [System.IO.File]::ReadAllText($ConfigPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    [string]$executable = $config.executable
    [string]$cwd = $config.cwd
    [string[]]$targetArgs = @()
    if ($null -ne $config.args) { $targetArgs = [string[]]$config.args }
    Assert-Argument $executable
    Assert-Argument $cwd
    if ($executable.Length -eq 0 -or $cwd.Length -eq 0) { throw 'Missing launch configuration.' }
    $command = New-Object System.Text.StringBuilder
    Add-QuotedArgument $command $executable
    foreach ($argument in $targetArgs) {
        Assert-Argument $argument
        [void]$command.Append(' ')
        Add-QuotedArgument $command $argument
    }
    if ($command.Length -ge 32767) { throw 'Command line too long.' }

    # Reflection.Emit produces only managed P/Invoke stubs in this process. No compiler is launched.
    $assemblyName = New-Object System.Reflection.AssemblyName('VompShellNative')
    $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName,
        [System.Reflection.Emit.AssemblyBuilderAccess]::Run)
    $module = $assembly.DefineDynamicModule('VompShellNative')
    $typeBuilder = $module.DefineType('VompShellNative', [System.Reflection.TypeAttributes]'Public,Abstract,Sealed')
    $pointerRef = [UIntPtr].MakeByRefType()
    $uintRef = [uint32].MakeByRefType()
    $boolRef = [bool].MakeByRefType()
    New-NativeMethod CreateJobObjectW kernel32.dll ([IntPtr]) ([type[]]@([IntPtr], [string]))
    New-NativeMethod SetHandleInformation kernel32.dll ([bool]) ([type[]]@([IntPtr], [uint32], [uint32]))
    New-NativeMethod SetInformationJobObject kernel32.dll ([bool]) ([type[]]@([IntPtr], [int], [IntPtr], [uint32]))
    New-NativeMethod QueryInformationJobObject kernel32.dll ([bool]) ([type[]]@([IntPtr], [int], [IntPtr], [uint32], $uintRef))
    New-NativeMethod TerminateJobObject kernel32.dll ([bool]) ([type[]]@([IntPtr], [uint32]))
    New-NativeMethod InitializeProcThreadAttributeList kernel32.dll ([bool]) ([type[]]@([IntPtr], [int], [uint32], $pointerRef))
    New-NativeMethod UpdateProcThreadAttribute kernel32.dll ([bool]) ([type[]]@([IntPtr], [uint32], [UIntPtr], [IntPtr], [UIntPtr], [IntPtr], [IntPtr]))
    New-NativeMethod DeleteProcThreadAttributeList kernel32.dll ([void]) ([type[]]@([IntPtr]))
    New-NativeMethod CreateProcessW kernel32.dll ([bool]) ([type[]]@([string], [System.Text.StringBuilder], [IntPtr], [IntPtr], [bool], [uint32], [IntPtr], [string], [IntPtr], [IntPtr]))
    New-NativeMethod OpenProcess kernel32.dll ([IntPtr]) ([type[]]@([uint32], [bool], [uint32]))
    New-NativeMethod IsProcessInJob kernel32.dll ([bool]) ([type[]]@([IntPtr], [IntPtr], $boolRef))
    New-NativeMethod GetProcessMemoryInfo psapi.dll ([bool]) ([type[]]@([IntPtr], [IntPtr], [uint32]))
    New-NativeMethod GetCurrentProcess kernel32.dll ([IntPtr]) ([type[]]@())
    New-NativeMethod GetProcessTimes kernel32.dll ([bool]) ([type[]]@([IntPtr], [IntPtr], [IntPtr], [IntPtr], [IntPtr]))
    New-NativeMethod WaitForSingleObject kernel32.dll ([uint32]) ([type[]]@([IntPtr], [uint32]))
    New-NativeMethod CloseHandle kernel32.dll ([bool]) ([type[]]@([IntPtr]))
    $native = $typeBuilder.CreateType()

    $pointerBytes = [IntPtr]::Size
    if ($pointerBytes -ne 4 -and $pointerBytes -ne 8) { throw 'Unsupported pointer size.' }
    $wide = $pointerBytes -eq 8
    $limitBytes = 112
    $startupBytes = 72
    $attributeOffset = 68
    $processInfoBytes = 16
    $memoryBytes = 40
    if ($wide) {
        $limitBytes = 144
        $startupBytes = 112
        $attributeOffset = 104
        $processInfoBytes = 24
        $memoryBytes = 72
    }
    $processListBytes = 8 + 4096 * $pointerBytes
    $processList = New-ZeroBuffer $processListBytes
    $processInfo = New-ZeroBuffer $processInfoBytes
    $startup = New-ZeroBuffer $startupBytes
    $limits = New-ZeroBuffer $limitBytes
    $memory = New-ZeroBuffer $memoryBytes
    $times = New-ZeroBuffer 32
    $jobValue = New-ZeroBuffer $pointerBytes
    $ids = New-Object 'System.Collections.Generic.List[uint32]'
    $memberRssBytes = New-Object 'System.Collections.Generic.List[long]'(256)
    $membership = New-Object 'System.Collections.Generic.HashSet[uint32]'
    $removed = New-Object 'System.Collections.Generic.List[uint32]'
    $response = New-Object System.Text.StringBuilder
    $inputLine = New-Object System.Text.StringBuilder(64)
    $clock = New-Object System.Diagnostics.Stopwatch

    # NULL security attributes and name create an unnamed, non-inheritable job.
    $job = $native::CreateJobObjectW([IntPtr]::Zero, $null)
    if ($job -eq [IntPtr]::Zero) { throw 'Job creation failed.' }
    if (-not $native::SetHandleInformation($job, 1, 0)) { throw 'Job handle setup failed.' }
    [System.Runtime.InteropServices.Marshal]::WriteInt32($limits, 16, 0x00002000)
    if (-not $native::SetInformationJobObject($job, 9, $limits, [uint32]$limitBytes)) { throw 'Job limits failed.' }
    $attributeBytes = [UIntPtr]::Zero
    $sized = $native::InitializeProcThreadAttributeList([IntPtr]::Zero, 1, 0, [ref]$attributeBytes)
    if ($sized -or $attributeBytes.ToUInt64() -eq 0 -or $attributeBytes.ToUInt64() -gt 1048576) {
        throw 'Attribute sizing failed.'
    }
    $attributes = New-ZeroBuffer ([int]$attributeBytes.ToUInt64())
    if (-not $native::InitializeProcThreadAttributeList($attributes, 1, 0, [ref]$attributeBytes)) {
        throw 'Attribute initialization failed.'
    }
    $attributesInitialized = $true
    [System.Runtime.InteropServices.Marshal]::WriteIntPtr($jobValue, 0, $job)
    # PROC_THREAD_ATTRIBUTE_JOB_LIST is 0x2000D. Its value outlives the attribute list.
    if (-not $native::UpdateProcThreadAttribute($attributes, 0, [UIntPtr]::new([uint32]0x0002000D), $jobValue,
        [UIntPtr]::new([uint32]$pointerBytes), [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Job attribute failed.' }
    [System.Runtime.InteropServices.Marshal]::WriteInt32($startup, 0, $startupBytes)
    [System.Runtime.InteropServices.Marshal]::WriteIntPtr($startup, $attributeOffset, $attributes)
    Write-Protocol '{"event":"ready"}'
    $phase = 'start'
    $line = Read-Command
    if ($null -eq $line) { $exitCode = 0 }
    else {
        if ($line -cne 'start') { throw 'Start authorization missing.' }
        # JOB_LIST assigns ownership atomically, with no suspended or uncontained target interval.
        # No handles are inherited. NULL environment inherits the already-sanitized helper environment.
        if (-not $native::CreateProcessW($executable, $command, [IntPtr]::Zero, [IntPtr]::Zero, $false,
            0x08080000, [IntPtr]::Zero, $cwd, $startup, $processInfo)) { throw 'Target creation failed.' }
        $targetHandle = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($processInfo, 0)
        $targetId = [uint32]([long][System.Runtime.InteropServices.Marshal]::ReadInt32($processInfo, (2 * $pointerBytes)) -band 4294967295L)
        $handles.Add($targetId, $targetHandle)
        [System.Runtime.InteropServices.Marshal]::WriteIntPtr($processInfo, 0, [IntPtr]::Zero)
        $threadHandle = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($processInfo, $pointerBytes)
        if (-not $native::CloseHandle($threadHandle)) { throw 'Thread handle close failed.' }
        [System.Runtime.InteropServices.Marshal]::WriteIntPtr($processInfo, $pointerBytes, [IntPtr]::Zero)
        Write-Protocol ('{"event":"spawned","pid":' + $targetId.ToString([Globalization.CultureInfo]::InvariantCulture) + '}')
        while ($true) {
            $phase = 'command'
            $commandId = [long]0
            $line = Read-Command
            if ($null -eq $line) { $phase = 'stop'; Stop-Job; break }
            if ($line.StartsWith('sample:', [StringComparison]::Ordinal)) {
                $phase = 'sample'
                $commandId = Read-CommandId $line 'sample:'
                Write-Sample $commandId
            } elseif ($line.StartsWith('stop:', [StringComparison]::Ordinal)) {
                $phase = 'stop'
                $commandId = Read-CommandId $line 'stop:'
                Stop-Job
                Write-Protocol ('{"event":"stopped","id":' + $commandId.ToString([Globalization.CultureInfo]::InvariantCulture) + '}')
                break
            } else { throw 'Unknown command.' }
        }
        $exitCode = 0
    }
} catch {
    # Only fixed phase/code strings enter diagnostics; exception/source/argument text stays private.
    try {
        $errorFields = ',"phase":"' + $phase + '","code":"' + $failureCode + '"}'
        if ($commandId -gt 0) {
            Write-Protocol ('{"event":"error","id":' + $commandId.ToString([Globalization.CultureInfo]::InvariantCulture) + $errorFields)
        } else { Write-Protocol ('{"event":"error"' + $errorFields) }
    } catch { }
} finally {
    # Closing the final job handle also terminates members on EOF and unexpected errors.
    if ($job -ne [IntPtr]::Zero) { [void]$native::CloseHandle($job) }
    if ($processInfo -ne [IntPtr]::Zero) {
        foreach ($offset in @(0, [IntPtr]::Size)) {
            $handle = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($processInfo, $offset)
            if ($handle -ne [IntPtr]::Zero) { [void]$native::CloseHandle($handle) }
        }
    }
    foreach ($handle in $handles.Values) { [void]$native::CloseHandle($handle) }
    if ($attributesInitialized) { $native::DeleteProcThreadAttributeList($attributes) }
    foreach ($buffer in @($attributes, $jobValue, $processList, $processInfo, $startup, $limits, $memory, $times)) {
        if ($buffer -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buffer) }
    }
}
exit $exitCode
`;
