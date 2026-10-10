# Puts a folder on the user's PATH or takes it off (spec step 26), for the installer and the tray's "Install command-line
# tool". The value keeps its registry type, so entries written as %VARIABLE% stay unexpanded, any length is safe (NSIS
# strings are not), and open programs are told with WM_SETTINGCHANGE so a new terminal finds `clop` at once.
# -InstallDir also records where the app lives, for a clop.exe that is not inside the app's folder.
param(
  [Parameter(Mandatory)][ValidateSet('add', 'remove', 'status')][string]$Action,
  [Parameter(Mandatory)][string]$Dir,
  [string]$InstallDir
)
$ErrorActionPreference = 'Stop'
$same = { param($a, $b) $a.Trim().TrimEnd('\').Equals($b.Trim().TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) }
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
  if ($key.GetValueNames() -contains 'Path') { $kind = $key.GetValueKind('Path') }
  $current = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $entries = @($current -split ';' | Where-Object { $_ -ne '' })
  $others = @($entries | Where-Object { -not (& $same $_ $Dir) })
  if ($Action -eq 'status') { if ($others.Count -lt $entries.Count) { 'installed' } else { 'not installed' }; exit 0 }
  $next = if ($Action -eq 'add') { $others + $Dir } else { $others }
  $value = $next -join ';'
  if ($value -ne $current) {
    if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String) { $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString }
    if ($value) { $key.SetValue('Path', $value, $kind) } else { $key.DeleteValue('Path', $false) }
    Add-Type -Namespace ClopPath -Name Native -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);'
    $result = [UIntPtr]::Zero
    [void][ClopPath.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
  }
} finally { $key.Close() }
if ($InstallDir) {
  if ($Action -eq 'add') { [void](New-Item -Path 'HKCU:\Software\Clop for Windows' -Force); Set-ItemProperty -Path 'HKCU:\Software\Clop for Windows' -Name InstallDir -Value $InstallDir }
  else { Remove-Item -Path 'HKCU:\Software\Clop for Windows' -Recurse -ErrorAction SilentlyContinue }
}
