param(
  [Parameter(Mandatory=$true)][int]$TargetPid,
  [Parameter(Mandatory=$true)][string]$StopFile,
  [int]$MaximumSeconds = 300,
  [int]$IntervalMs = 25
)
$ErrorActionPreference = 'Stop'
# Only the owned render session is metered. No endpoint-wide peak or capture API is used.
$compileDirectory = Join-Path (Split-Path $StopFile) ('compiler-' + $PID)
New-Item -ItemType Directory -Path $compileDirectory -Force | Out-Null
$env:TEMP = $compileDirectory
$env:TMP = $compileDirectory
try {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class DeviceEnumerator {}
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
 [PreserveSig] int EnumAudioEndpoints(int flow, uint mask, out IMMDeviceCollection devices);
 [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
}
[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection {
 [PreserveSig] int GetCount(out uint count);
 [PreserveSig] int Item(uint index, out IMMDevice device);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
 [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object result);
 [PreserveSig] int OpenPropertyStore(uint access, out IntPtr properties);
 [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
 [PreserveSig] int GetState(out uint state);
}
[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2 {
 [PreserveSig] int GetAudioSessionControl();
 [PreserveSig] int GetSimpleAudioVolume();
 [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
}
[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator {
 [PreserveSig] int GetCount(out int count);
 [PreserveSig] int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object control);
}
[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2 {
 [PreserveSig] int GetState(out int state);
 [PreserveSig] int GetDisplayName();
 [PreserveSig] int SetDisplayName();
 [PreserveSig] int GetIconPath();
 [PreserveSig] int SetIconPath();
 [PreserveSig] int GetGroupingParam();
 [PreserveSig] int SetGroupingParam();
 [PreserveSig] int RegisterAudioSessionNotification();
 [PreserveSig] int UnregisterAudioSessionNotification();
 [PreserveSig] int GetSessionIdentifier();
 [PreserveSig] int GetSessionInstanceIdentifier();
 [PreserveSig] int GetProcessId(out uint pid);
 [PreserveSig] int IsSystemSoundsSession();
 [PreserveSig] int SetDuckingPreference();
}
[ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioMeterInformation {
 [PreserveSig] int GetPeakValue(out float peak);
 [PreserveSig] int GetMeteringChannelCount(out uint count);
}
[ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISimpleAudioVolume {
 [PreserveSig] int SetMasterVolume(float volume, ref Guid context);
 [PreserveSig] int GetMasterVolume(out float volume);
 [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
 [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}
[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
 [PreserveSig] int RegisterControlChangeNotify();
 [PreserveSig] int UnregisterControlChangeNotify();
 [PreserveSig] int GetChannelCount(out uint count);
 [PreserveSig] int SetMasterVolumeLevel();
 [PreserveSig] int SetMasterVolumeLevelScalar();
 [PreserveSig] int GetMasterVolumeLevel(out float db);
 [PreserveSig] int GetMasterVolumeLevelScalar(out float volume);
 [PreserveSig] int SetChannelVolumeLevel();
 [PreserveSig] int SetChannelVolumeLevelScalar();
 [PreserveSig] int GetChannelVolumeLevel();
 [PreserveSig] int GetChannelVolumeLevelScalar();
 [PreserveSig] int SetMute();
 [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}
public class MeterSample {
 public string kind = "sample";
 public double unixMs;
 public double elapsedMs;
 public int pid;
 public string endpointId;
 public float peak;
 public float sessionVolume;
 public bool sessionMute;
 public float endpointVolume;
 public bool endpointMute;
 public int sessionState;
 public long workingSet;
 public long privateBytes;
}
public class OwnedSessionMeter : IDisposable {
 IAudioSessionControl2 control;
 IAudioMeterInformation meter;
 ISimpleAudioVolume volume;
 IAudioEndpointVolume endpointVolume;
 string endpointId;
 Process process;
 Stopwatch timer = Stopwatch.StartNew();
 double origin = (DateTime.UtcNow - new DateTime(1970,1,1)).TotalMilliseconds;
 long workingSet, privateBytes;
 double nextMemory;
 static void Check(int hr) { Marshal.ThrowExceptionForHR(hr); }
 static void Release(object obj) { if (obj != null && Marshal.IsComObject(obj)) Marshal.ReleaseComObject(obj); }
 public bool Open(int pid) {
   IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new DeviceEnumerator();
   IMMDeviceCollection devices = null;
   try {
     Check(enumerator.EnumAudioEndpoints(0, 1, out devices));
     uint count; Check(devices.GetCount(out count));
     for (uint i=0; i<count; i++) {
       IMMDevice device=null; object manager=null; IAudioSessionEnumerator sessions=null;
       try {
         Check(devices.Item(i,out device));
         Guid iid = typeof(IAudioSessionManager2).GUID;
         Check(device.Activate(ref iid,23,IntPtr.Zero,out manager));
         Check(((IAudioSessionManager2)manager).GetSessionEnumerator(out sessions));
         int n; Check(sessions.GetCount(out n));
         for (int j=0; j<n; j++) {
           object raw=null;
           try {
             Check(sessions.GetSession(j,out raw));
             IAudioSessionControl2 candidate=(IAudioSessionControl2)raw;
             uint owner; Check(candidate.GetProcessId(out owner));
             if (owner != (uint)pid) continue;
             meter=(IAudioMeterInformation)candidate;
             volume=(ISimpleAudioVolume)candidate;
             object endpoint;
             iid=typeof(IAudioEndpointVolume).GUID;
             Check(device.Activate(ref iid,23,IntPtr.Zero,out endpoint));
             endpointVolume=(IAudioEndpointVolume)endpoint;
             Check(device.GetId(out endpointId));
             control=candidate; raw=null;
             process=Process.GetProcessById(pid);
             return true;
           } finally { Release(raw); }
         }
       } finally { Release(sessions); Release(manager); Release(device); }
     }
     return false;
   } finally { Release(devices); Release(enumerator); }
 }
 public MeterSample Read() {
   MeterSample result=new MeterSample();
   result.elapsedMs=timer.Elapsed.TotalMilliseconds;
   result.unixMs=origin+result.elapsedMs;
   result.pid=process.Id; result.endpointId=endpointId;
   Check(meter.GetPeakValue(out result.peak));
   Check(volume.GetMasterVolume(out result.sessionVolume));
   Check(volume.GetMute(out result.sessionMute));
   Check(endpointVolume.GetMasterVolumeLevelScalar(out result.endpointVolume));
   Check(endpointVolume.GetMute(out result.endpointMute));
   Check(control.GetState(out result.sessionState));
   if (result.elapsedMs >= nextMemory) {
     process.Refresh(); workingSet=process.WorkingSet64; privateBytes=process.PrivateMemorySize64;
     nextMemory=result.elapsedMs+1000;
   }
   result.workingSet=workingSet; result.privateBytes=privateBytes;
   return result;
 }
 public void Dispose() {
   meter=null; volume=null;
   Release(control); control=null;
   Release(endpointVolume); endpointVolume=null;
   if (process!=null) process.Dispose();
 }
}
'@
$meter = New-Object OwnedSessionMeter
try {
  $deadline = [DateTime]::UtcNow.AddSeconds(12)
  while (-not $meter.Open($TargetPid)) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'No owned WASAPI render session found' }
    Start-Sleep -Milliseconds 100
  }
  [Console]::WriteLine('{"kind":"ready"}')
  $deadline = [DateTime]::UtcNow.AddSeconds($MaximumSeconds)
  while (([DateTime]::UtcNow -lt $deadline) -and -not (Test-Path -LiteralPath $StopFile)) {
    [Console]::WriteLine(($meter.Read() | ConvertTo-Json -Compress))
    Start-Sleep -Milliseconds $IntervalMs
  }
} finally { $meter.Dispose() }
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
} finally {
  Remove-Item -LiteralPath $compileDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
