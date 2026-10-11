; Included by electron-builder's NSIS script (spec step 26). Puts $INSTDIR\cli, which holds clop.exe, on the user's PATH
; and records the install folder; uninstalling undoes both. The PATH edit runs in PowerShell, which keeps the value's
; registry type, handles a PATH of any length (NSIS strings are fixed-size) and broadcasts WM_SETTINGCHANGE. The script is
; embedded in the installer and the uninstaller, so neither depends on files in $INSTDIR.
;
; It also adds Explorer's right-click verbs (spec step 39) and the Send To shortcut, and removes them again. The statements between the
; BEGIN and END markers are generated from `core/shell-verbs.ts` (`nsisInstall`, `nsisUninstall`); `core/shell-verbs.test.ts` fails when they differ.

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

!macro clopVerbsAdd
  ; BEGIN explorer-verbs-install
  WriteRegStr HKCU "Software\Classes\*\shell\Clop.Optimise" "" "Optimise with Clop"
  WriteRegStr HKCU "Software\Classes\*\shell\Clop.Optimise" "Icon" "$INSTDIR\Clop for Windows.exe,0"
  WriteRegStr HKCU "Software\Classes\*\shell\Clop.Optimise" "AppliesTo" 'System.FileExtension:=".png" OR System.FileExtension:=".jpg" OR System.FileExtension:=".jpeg" OR System.FileExtension:=".gif" OR System.FileExtension:=".webp" OR System.FileExtension:=".avif" OR System.FileExtension:=".heic" OR System.FileExtension:=".heif" OR System.FileExtension:=".jxl" OR System.FileExtension:=".bmp" OR System.FileExtension:=".tif" OR System.FileExtension:=".tiff" OR System.FileExtension:=".svg" OR System.FileExtension:=".mp4" OR System.FileExtension:=".mov" OR System.FileExtension:=".qt" OR System.FileExtension:=".m4v" OR System.FileExtension:=".webm" OR System.FileExtension:=".mkv" OR System.FileExtension:=".avi" OR System.FileExtension:=".m2v" OR System.FileExtension:=".mpg" OR System.FileExtension:=".mpeg" OR System.FileExtension:=".mp3" OR System.FileExtension:=".m4a" OR System.FileExtension:=".aac" OR System.FileExtension:=".wav" OR System.FileExtension:=".aif" OR System.FileExtension:=".aiff" OR System.FileExtension:=".flac" OR System.FileExtension:=".ogg" OR System.FileExtension:=".opus" OR System.FileExtension:=".pdf"'
  WriteRegStr HKCU "Software\Classes\*\shell\Clop.Optimise\command" "" '"$INSTDIR\Clop for Windows.exe" --clop-optimise -- "%1"'
  WriteRegStr HKCU "Software\Classes\*\shell\Clop.OptimiseAggressive" "" "Optimise (aggressive)"
  WriteRegStr HKCU "Software\Classes\*\shell\Clop.OptimiseAggressive" "Icon" "$INSTDIR\Clop for Windows.exe,0"
  WriteRegStr HKCU "Software\Classes\*\shell\Clop.OptimiseAggressive" "AppliesTo" 'System.FileExtension:=".png" OR System.FileExtension:=".jpg" OR System.FileExtension:=".jpeg" OR System.FileExtension:=".gif" OR System.FileExtension:=".webp" OR System.FileExtension:=".avif" OR System.FileExtension:=".heic" OR System.FileExtension:=".heif" OR System.FileExtension:=".jxl" OR System.FileExtension:=".bmp" OR System.FileExtension:=".tif" OR System.FileExtension:=".tiff" OR System.FileExtension:=".svg" OR System.FileExtension:=".mp4" OR System.FileExtension:=".mov" OR System.FileExtension:=".qt" OR System.FileExtension:=".m4v" OR System.FileExtension:=".webm" OR System.FileExtension:=".mkv" OR System.FileExtension:=".avi" OR System.FileExtension:=".m2v" OR System.FileExtension:=".mpg" OR System.FileExtension:=".mpeg" OR System.FileExtension:=".mp3" OR System.FileExtension:=".m4a" OR System.FileExtension:=".aac" OR System.FileExtension:=".wav" OR System.FileExtension:=".aif" OR System.FileExtension:=".aiff" OR System.FileExtension:=".flac" OR System.FileExtension:=".ogg" OR System.FileExtension:=".opus" OR System.FileExtension:=".pdf"'
  WriteRegStr HKCU "Software\Classes\*\shell\Clop.OptimiseAggressive\command" "" '"$INSTDIR\Clop for Windows.exe" --clop-optimise-aggressive -- "%1"'
  WriteRegStr HKCU "Software\Classes\*\shell\Clop.Downscale" "" "Downscale"
  WriteRegStr HKCU "Software\Classes\*\shell\Clop.Downscale" "Icon" "$INSTDIR\Clop for Windows.exe,0"
  WriteRegStr HKCU "Software\Classes\*\shell\Clop.Downscale" "AppliesTo" 'System.FileExtension:=".png" OR System.FileExtension:=".jpg" OR System.FileExtension:=".jpeg" OR System.FileExtension:=".gif" OR System.FileExtension:=".webp" OR System.FileExtension:=".avif" OR System.FileExtension:=".heic" OR System.FileExtension:=".heif" OR System.FileExtension:=".jxl" OR System.FileExtension:=".bmp" OR System.FileExtension:=".tif" OR System.FileExtension:=".tiff" OR System.FileExtension:=".svg" OR System.FileExtension:=".mp4" OR System.FileExtension:=".mov" OR System.FileExtension:=".qt" OR System.FileExtension:=".m4v" OR System.FileExtension:=".webm" OR System.FileExtension:=".mkv" OR System.FileExtension:=".avi" OR System.FileExtension:=".m2v" OR System.FileExtension:=".mpg" OR System.FileExtension:=".mpeg" OR System.FileExtension:=".mp3" OR System.FileExtension:=".m4a" OR System.FileExtension:=".aac" OR System.FileExtension:=".wav" OR System.FileExtension:=".aif" OR System.FileExtension:=".aiff" OR System.FileExtension:=".flac" OR System.FileExtension:=".ogg" OR System.FileExtension:=".opus"'
  WriteRegStr HKCU "Software\Classes\*\shell\Clop.Downscale\command" "" '"$INSTDIR\Clop for Windows.exe" --clop-downscale -- "%1"'
  WriteRegStr HKCU "Software\Classes\*\shell\Clop.StripExif" "" "Strip EXIF"
  WriteRegStr HKCU "Software\Classes\*\shell\Clop.StripExif" "Icon" "$INSTDIR\Clop for Windows.exe,0"
  WriteRegStr HKCU "Software\Classes\*\shell\Clop.StripExif" "AppliesTo" 'System.FileExtension:=".png" OR System.FileExtension:=".jpg" OR System.FileExtension:=".jpeg" OR System.FileExtension:=".gif" OR System.FileExtension:=".webp" OR System.FileExtension:=".avif" OR System.FileExtension:=".heic" OR System.FileExtension:=".heif" OR System.FileExtension:=".jxl" OR System.FileExtension:=".bmp" OR System.FileExtension:=".tif" OR System.FileExtension:=".tiff" OR System.FileExtension:=".svg" OR System.FileExtension:=".mp4" OR System.FileExtension:=".mov" OR System.FileExtension:=".qt" OR System.FileExtension:=".m4v" OR System.FileExtension:=".webm" OR System.FileExtension:=".mkv" OR System.FileExtension:=".avi" OR System.FileExtension:=".m2v" OR System.FileExtension:=".mpg" OR System.FileExtension:=".mpeg"'
  WriteRegStr HKCU "Software\Classes\*\shell\Clop.StripExif\command" "" '"$INSTDIR\Clop for Windows.exe" --clop-strip-exif -- "%1"'
  WriteRegStr HKCU "Software\Classes\*\shell\Clop.RunPipeline" "" "Run pipeline..."
  WriteRegStr HKCU "Software\Classes\*\shell\Clop.RunPipeline" "Icon" "$INSTDIR\Clop for Windows.exe,0"
  WriteRegStr HKCU "Software\Classes\*\shell\Clop.RunPipeline" "AppliesTo" 'System.FileExtension:=".png" OR System.FileExtension:=".jpg" OR System.FileExtension:=".jpeg" OR System.FileExtension:=".gif" OR System.FileExtension:=".webp" OR System.FileExtension:=".avif" OR System.FileExtension:=".heic" OR System.FileExtension:=".heif" OR System.FileExtension:=".jxl" OR System.FileExtension:=".bmp" OR System.FileExtension:=".tif" OR System.FileExtension:=".tiff" OR System.FileExtension:=".svg" OR System.FileExtension:=".mp4" OR System.FileExtension:=".mov" OR System.FileExtension:=".qt" OR System.FileExtension:=".m4v" OR System.FileExtension:=".webm" OR System.FileExtension:=".mkv" OR System.FileExtension:=".avi" OR System.FileExtension:=".m2v" OR System.FileExtension:=".mpg" OR System.FileExtension:=".mpeg" OR System.FileExtension:=".mp3" OR System.FileExtension:=".m4a" OR System.FileExtension:=".aac" OR System.FileExtension:=".wav" OR System.FileExtension:=".aif" OR System.FileExtension:=".aiff" OR System.FileExtension:=".flac" OR System.FileExtension:=".ogg" OR System.FileExtension:=".opus" OR System.FileExtension:=".pdf"'
  WriteRegStr HKCU "Software\Classes\*\shell\Clop.RunPipeline\command" "" '"$INSTDIR\Clop for Windows.exe" --clop-run-pipeline -- "%1"'
  CreateShortCut "$SENDTO\Optimise with Clop.lnk" "$INSTDIR\Clop for Windows.exe" "--clop-optimise --" "$INSTDIR\Clop for Windows.exe" 0
  ; END explorer-verbs-install
!macroend

!macro clopVerbsRemove
  ; BEGIN explorer-verbs-uninstall
  DeleteRegKey HKCU "Software\Classes\*\shell\Clop.Optimise"
  DeleteRegKey HKCU "Software\Classes\*\shell\Clop.OptimiseAggressive"
  DeleteRegKey HKCU "Software\Classes\*\shell\Clop.Downscale"
  DeleteRegKey HKCU "Software\Classes\*\shell\Clop.StripExif"
  DeleteRegKey HKCU "Software\Classes\*\shell\Clop.RunPipeline"
  Delete "$SENDTO\Optimise with Clop.lnk"
  ; END explorer-verbs-uninstall
!macroend

!macro customInstall
  !insertmacro clopPath add
  !insertmacro clopVerbsAdd
!macroend

!macro customUnInstall
  ; An update runs the old uninstaller first; the new installer adds the same folder back, so leave PATH alone then.
  ${ifNot} ${isUpdated}
    !insertmacro clopPath remove
    !insertmacro clopVerbsRemove
  ${endif}
!macroend
