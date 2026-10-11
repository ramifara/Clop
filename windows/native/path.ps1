# Puts a folder on the user's PATH or takes it off (spec step 26), for the installer and the portable tray's "Install
# command-line tool". The value keeps its registry type, so entries written as %VARIABLE% stay unexpanded, any length is
# safe (NSIS strings are not), other entries (empty ones too) stay exactly as they were, and open programs are told with
# WM_SETTINGCHANGE so a new terminal finds `clop` at once.
# -InstallDir records where the app lives, for a clop.exe that is not inside the app's folder (-Portable marks a portable
# app, whose folder only exists while it runs); removing takes the record away only when it is still ours.
param(
  [Parameter(Mandatory)][ValidateSet('add', 'remove', 'status')][string]$Action,
  [Parameter(Mandatory)][string]$Dir,
  [string]$InstallDir,
  [switch]$Portable
)
$ErrorActionPreference = 'Stop'
$same = { param($a, $b) $a.Trim().TrimEnd('\').Equals($b.Trim().TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) }
# Loaded before anything changes, so a machine that blocks Add-Type (Constrained Language) still gets the PATH edit,
# only without the broadcast.
$broadcast = $true
try {
  Add-Type -Namespace ClopPath -Name Native -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);'
} catch { $broadcast = $false }

# Only adding may create a key; removing and status open what is there and leave a missing key missing.
$open = { param($name) if ($Action -eq 'add') { [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($name) } else { [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($name, $Action -eq 'remove') } }

$key = & $open 'Environment'
if (-not $key -and $Action -eq 'status') { 'not installed' }
if ($key) { try {
  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
  if ($key.GetValueNames() -contains 'Path') { $kind = $key.GetValueKind('Path') }
  $current = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $entries = if ($current) { @($current -split ';') } else { @() }
  $others = @($entries | Where-Object { $_ -eq '' -or -not (& $same $_ $Dir) })
  if ($Action -eq 'status') { if ($others.Count -lt $entries.Count) { 'installed' } else { 'not installed' }; exit 0 }
  $value = if ($Action -eq 'remove') { $others -join ';' } elseif ($others.Count -lt $entries.Count) { $current } elseif ($current) { if ($current.EndsWith(';')) { $current + $Dir } else { $current + ';' + $Dir } } else { $Dir }
  if ($value -ne $current) {
    if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String) { $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString }
    if ($value) { $key.SetValue('Path', $value, $kind) } else { $key.DeleteValue('Path', $false) }
    if ($broadcast) {
      $result = [UIntPtr]::Zero
      [void][ClopPath.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
    }
  }
} finally { $key.Close() } }

if ($InstallDir -and $Action -ne 'status') {
  $app = & $open 'Software\Clop for Windows'
  if ($app) { try {
    if ($Action -eq 'add') {
      $app.SetValue('InstallDir', $InstallDir, [Microsoft.Win32.RegistryValueKind]::String)
      $app.SetValue('Portable', [int][bool]$Portable, [Microsoft.Win32.RegistryValueKind]::DWord)
    } elseif ($Action -eq 'remove' -and (& $same ([string]$app.GetValue('InstallDir', '')) $InstallDir)) {
      $app.DeleteValue('InstallDir', $false)
      $app.DeleteValue('Portable', $false)
    }
  } finally { $app.Close() } }
}
