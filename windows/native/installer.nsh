; Included by electron-builder's NSIS script (spec step 26). Puts $INSTDIR\cli, which holds clop.exe, on the user's PATH
; and records the install folder; uninstalling undoes both. The PATH edit runs in PowerShell, which keeps the value's
; registry type, handles a PATH of any length (NSIS strings are fixed-size) and broadcasts WM_SETTINGCHANGE. The script is
; embedded in the installer and the uninstaller, so neither depends on files in $INSTDIR.

!macro clopPath ACTION
  InitPluginsDir
  File "/oname=$PLUGINSDIR\clop-path.ps1" "${PROJECT_DIR}\native\path.ps1"
  ; A trailing backslash before the closing quote would escape it, so the folder goes in without one.
  StrCpy $R9 "$INSTDIR"
  StrCpy $R8 $R9 1 -1
  ${if} $R8 == "\"
    StrCpy $R9 $R9 -1
  ${endif}
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\clop-path.ps1" -Action ${ACTION} -Dir "$R9\cli" -InstallDir "$R9"'
  Pop $0
  ${if} $0 != 0
    DetailPrint "Could not change PATH for the clop command ($0)."
  ${endif}
!macroend

!macro customInstall
  !insertmacro clopPath add
!macroend

!macro customUnInstall
  ; An update runs the old uninstaller first; the new installer adds the same folder back, so leave PATH alone then.
  ${ifNot} ${isUpdated}
    !insertmacro clopPath remove
  ${endif}
!macroend
