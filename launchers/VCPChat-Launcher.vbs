Option Explicit

' Windows double-click entry. Keep this independent from start.bat and the
' upstream VBS launchers so existing developer workflows remain unchanged.
Dim shell, fso, projectRoot, tauriExe
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
projectRoot = fso.GetParentFolderName(WScript.ScriptFullName)
projectRoot = fso.GetParentFolderName(projectRoot)
tauriExe = projectRoot & "\VCPChat-Setup.exe"
If Not fso.FileExists(tauriExe) Then tauriExe = projectRoot & "\apps\bootstrap-installer\src-tauri\target\release\VCPChat-Setup.exe"
If fso.FileExists(tauriExe) Then
  shell.CurrentDirectory = projectRoot
  shell.Run """" & tauriExe & """ --source-root """ & projectRoot & """", 1, False
  Set fso = Nothing
  Set shell = Nothing
  WScript.Quit 0
End If

MsgBox "没有找到 VCPChat 图形启动器。请先在仓库根目录运行 npm run installer:portable 生成 VCPChat-Setup.exe。", 48, "VCPChat 启动器"
Set fso = Nothing
Set shell = Nothing
