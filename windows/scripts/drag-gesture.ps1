param([long]$Window, [int]$Width, [int]$Height, [int]$X, [int]$Y, [int]$MoveX = 90, [int]$MoveY = 40, [int]$Hold = 600, [int]$PressDelay = 300, [int]$ToX = -1, [int]$ToY = -1, [int]$Settle = 800, [switch]$Escape)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ClopDragGesture {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
}
'@
[ClopDragGesture]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
Write-Output 'Positioning the source window'
[ClopDragGesture]::SetWindowPos([IntPtr]$Window, [IntPtr]::Zero, 60, 60, $Width, $Height, 4) | Out-Null
[ClopDragGesture]::SetForegroundWindow([IntPtr]$Window) | Out-Null
[ClopDragGesture]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 150
try {
  Write-Output 'Pressing the mouse'
  [ClopDragGesture]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
  Start-Sleep -Milliseconds $PressDelay
  Write-Output 'Moving the mouse'
  [ClopDragGesture]::SetCursorPos($X + $MoveX, $Y + $MoveY) | Out-Null
  Start-Sleep -Milliseconds $Hold
  if ($ToX -ge 0 -and $ToY -ge 0) {
    # Carry the drag to a target (screen pixels) in steps, so the window under the cursor sees the drag enter, move over it and then drop.
    $fromX = $X + $MoveX; $fromY = $Y + $MoveY
    Write-Output "Moving to the target $ToX,$ToY"
    foreach ($step in 1..8) {
      [ClopDragGesture]::SetCursorPos([int]($fromX + ($ToX - $fromX) * $step / 8), [int]($fromY + ($ToY - $fromY) * $step / 8)) | Out-Null
      Start-Sleep -Milliseconds 80
    }
    [ClopDragGesture]::SetCursorPos($ToX + 2, $ToY + 1) | Out-Null
    Start-Sleep -Milliseconds 80
    [ClopDragGesture]::SetCursorPos($ToX, $ToY) | Out-Null
    Start-Sleep -Milliseconds $Settle
  }
  if ($Escape) {
    [ClopDragGesture]::keybd_event(27,0,0,[UIntPtr]::Zero)
    Start-Sleep -Milliseconds 300
    [ClopDragGesture]::keybd_event(27,0,2,[UIntPtr]::Zero)
    [ClopDragGesture]::SetCursorPos($X + $MoveX + 60, $Y + $MoveY) | Out-Null
    Start-Sleep -Milliseconds 500
  }
} finally {
  Write-Output 'Releasing the mouse'
  [ClopDragGesture]::keybd_event(27,0,2,[UIntPtr]::Zero)
  [ClopDragGesture]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
}
