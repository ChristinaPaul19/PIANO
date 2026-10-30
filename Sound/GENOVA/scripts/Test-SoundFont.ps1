[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot '..\config\audio.json'),
    [switch]$RenderOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $root 'verification'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
foreach ($name in @('version.log', 'render.log', 'audio-devices.log', 'playback.log', 'soundfont-test.mid', 'soundfont-test.wav', 'result.json')) {
    $previousOutput = Join-Path $outputDirectory $name
    if (Test-Path -LiteralPath $previousOutput) { Remove-Item -LiteralPath $previousOutput }
}
$result = [ordered]@{
    testedAt = [DateTime]::UtcNow.ToString('o')
    success = $false
    soundFontLoaded = $false
    nonSilentAudioRendered = $false
    playbackRequested = (-not $RenderOnly)
    playbackCompleted = $false
    audibleSoundIndependentlyConfirmed = $false
    error = $null
}

function Invoke-FluidSynth {
    param([string[]]$Arguments, [string]$LogName, [int]$TimeoutSeconds = 60)
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $config.fluidsynthExecutable
    $start.WorkingDirectory = Split-Path -Parent $config.fluidsynthExecutable
    $quoted = foreach ($argument in $Arguments) {
        if ($argument.Contains('"')) { throw 'An argument contains an unsupported quotation mark.' }
        '"' + $argument + '"'
    }
    $start.Arguments = $quoted -join ' '
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    $started = $false
    try {
        $started = $process.Start()
        if (-not $started) { throw 'FluidSynth could not start.' }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $timedOut = -not $process.WaitForExit($TimeoutSeconds * 1000)
        if ($timedOut) {
            Stop-Process -Id $process.Id -Force
            $process.WaitForExit()
        }
        $text = $stdout.Result + [Environment]::NewLine + $stderr.Result
        $text | Set-Content -LiteralPath (Join-Path $outputDirectory $LogName) -Encoding UTF8
        if ($timedOut) { throw "FluidSynth timed out; see $LogName." }
        if ($process.ExitCode -ne 0) { throw "FluidSynth exit code $($process.ExitCode); see $LogName." }
        # Verbose mode reports absent optional user/system config files even on success.
        $diagnostics = $text -replace "(?im)^Failed to (early-)?load config file '[^'\r\n]+' - file doesn't exist\.\r?$", ''
        if ($diagnostics -match '(?im)fluidsynth:\s*(error|panic):|failed to (load|create|open)|could not (load|create|open)') {
            throw "FluidSynth reported an error; see $LogName."
        }
        return $text
    }
    finally {
        if ($started -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force }
        $process.Dispose()
    }
}

function Measure-PcmWave {
    param([string]$Path)
    $reader = New-Object System.IO.BinaryReader([IO.File]::OpenRead($Path))
    try {
        if ([Text.Encoding]::ASCII.GetString($reader.ReadBytes(4)) -ne 'RIFF') { throw 'Missing RIFF header.' }
        [void]$reader.ReadUInt32()
        if ([Text.Encoding]::ASCII.GetString($reader.ReadBytes(4)) -ne 'WAVE') { throw 'Missing WAVE header.' }
        $format = $null
        $dataOffset = 0L
        $dataSize = 0L
        while ($reader.BaseStream.Position + 8 -le $reader.BaseStream.Length) {
            $id = [Text.Encoding]::ASCII.GetString($reader.ReadBytes(4))
            $size = $reader.ReadUInt32()
            $next = $reader.BaseStream.Position + $size + ($size % 2)
            if ($next -gt $reader.BaseStream.Length) { throw 'Truncated WAV chunk.' }
            if ($id -eq 'fmt ') {
                if ($size -lt 16) { throw 'Invalid WAV format chunk.' }
                $format = [ordered]@{
                    encoding = $reader.ReadUInt16()
                    channels = $reader.ReadUInt16()
                    sampleRate = $reader.ReadUInt32()
                    byteRate = $reader.ReadUInt32()
                    blockAlign = $reader.ReadUInt16()
                    bitsPerSample = $reader.ReadUInt16()
                }
            }
            elseif ($id -eq 'data') {
                $dataOffset = $reader.BaseStream.Position
                $dataSize = [long]$size
            }
            $reader.BaseStream.Position = $next
        }
        if ($null -eq $format -or $format.encoding -ne 1 -or $format.bitsPerSample -ne 16) {
            throw 'Expected 16-bit PCM WAV.'
        }
        if ($dataOffset -eq 0 -or $dataSize -eq 0 -or $format.byteRate -eq 0) { throw 'WAV contains no audio.' }
        $reader.BaseStream.Position = $dataOffset
        $peak = 0
        $nonzero = 0L
        for ($i = 0L; $i -lt [long]($dataSize / 2); $i++) {
            $sample = [Math]::Abs([int]$reader.ReadInt16())
            if ($sample -gt $peak) { $peak = $sample }
            if ($sample -gt 0) { $nonzero++ }
        }
        if ($peak -lt 32 -or $nonzero -lt 1000) { throw 'Rendered audio is silent or nearly silent.' }
        return [ordered]@{
            path = $Path
            durationSeconds = $dataSize / [double]$format.byteRate
            channels = $format.channels
            sampleRate = $format.sampleRate
            bitsPerSample = $format.bitsPerSample
            peakAmplitude = $peak
            nonzeroSamples = $nonzero
        }
    }
    finally { $reader.Dispose() }
}

try {
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    foreach ($path in @($config.fluidsynthExecutable, $config.soundFont)) {
        if (-not [IO.Path]::IsPathRooted($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Configured file does not exist or is not absolute: $path"
        }
    }
    $result['fluidsynthExecutable'] = $config.fluidsynthExecutable
    $result['soundFont'] = $config.soundFont
    $result['soundFontSHA256'] = (Get-FileHash -LiteralPath $config.soundFont -Algorithm SHA256).Hash
    $version = Invoke-FluidSynth -Arguments @('--version') -LogName 'version.log'
    $result['version'] = $version.Trim()

    # Three original test notes, 500 ms each, followed by one second of silence.
    [byte[]]$track = @(
        0x00,0xFF,0x51,0x03,0x07,0xA1,0x20,
        0x00,0xC0,0x00,
        0x00,0x90,0x3C,0x50, 0x83,0x60,0x80,0x3C,0x00,
        0x00,0x90,0x40,0x50, 0x83,0x60,0x80,0x40,0x00,
        0x00,0x90,0x43,0x50, 0x83,0x60,0x80,0x43,0x00,
        0x87,0x40,0xFF,0x2F,0x00
    )
    [byte[]]$header = @(0x4D,0x54,0x68,0x64,0,0,0,6,0,0,0,1,1,0xE0,0x4D,0x54,0x72,0x6B)
    $length = [BitConverter]::GetBytes([int]$track.Length)
    [Array]::Reverse($length)
    $midiPath = Join-Path $outputDirectory 'soundfont-test.mid'
    $wavePath = Join-Path $outputDirectory 'soundfont-test.wav'
    [IO.File]::WriteAllBytes($midiPath, [byte[]]($header + $length + $track))
    if (Test-Path -LiteralPath $wavePath) { Remove-Item -LiteralPath $wavePath }
    $sampleRate = [string]$config.sampleRate
    $gain = ([double]$config.gain).ToString([Globalization.CultureInfo]::InvariantCulture)
    $common = @('-n', '-i', '-r', $sampleRate, '-g', $gain)
    [void](Invoke-FluidSynth -Arguments ($common + @('-F', $wavePath, '-T', 'wav', '-O', 's16', $config.soundFont, $midiPath)) -LogName 'render.log')
    $result['render'] = Measure-PcmWave -Path $wavePath
    $result.soundFontLoaded = $true
    $result.nonSilentAudioRendered = $true

    if (-not $RenderOnly) {
        # -Q probes every exclusive-mode format and can stall some Windows drivers.
        [void](Invoke-FluidSynth -Arguments @('-o', 'help') -LogName 'audio-devices.log')
        $result['audioDriver'] = $config.audioDriver
        $playback = Invoke-FluidSynth -Arguments ($common + @('-a', $config.audioDriver, '-v', $config.soundFont, $midiPath)) -LogName 'playback.log'
        $noteOnCount = [regex]::Matches($playback, '(?m)^fluidsynth: noteon\s').Count
        $noteOffCount = [regex]::Matches($playback, '(?m)^fluidsynth: noteoff\s').Count
        if ($noteOnCount -ne 3 -or $noteOffCount -ne 3) { throw 'Playback did not process all three test notes.' }
        $result['noteOnCount'] = $noteOnCount
        $result['noteOffCount'] = $noteOffCount
        $result.playbackCompleted = $true
        $result['playbackNote'] = 'FluidSynth completed real-time playback to the Windows audio driver. Physical speaker audibility was not independently measured.'
    }
    $result.success = $true
}
catch {
    $result.error = $_.Exception.Message
    throw
}
finally {
    $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $outputDirectory 'result.json') -Encoding UTF8
}
$result | ConvertTo-Json -Depth 5
