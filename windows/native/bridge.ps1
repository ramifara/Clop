param([switch]$Check)
$ErrorActionPreference = 'Stop'
try {
  $source = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'Bridge.cs')
  Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase
  $references = @('System.Windows.Forms','System.Drawing','System.Web.Extensions','System.Core','Microsoft.CSharp','Accessibility', [System.Windows.Automation.AutomationElement].Assembly.Location, [System.Windows.Automation.ControlType].Assembly.Location, [System.Windows.Point].Assembly.Location)
  Add-Type -TypeDefinition $source -ReferencedAssemblies $references
  if ($Check) { Write-Output 'Windows bridge compiled successfully'; exit 0 }
  [ClopWindows.Bridge]::Run()
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}
