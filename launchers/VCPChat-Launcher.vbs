Option Explicit

' Windows double-click entry. Keep this independent from start.bat and the
' upstream VBS launchers so existing developer workflows remain unchanged.
Dim shell, fso, projectRoot, tauriExe, electronExe, npmExe, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
projectRoot = fso.GetParentFolderName(WScript.ScriptFullName)
projectRoot = fso.GetParentFolderName(projectRoot)
tauriExe = projectRoot & "\apps\bootstrap-installer\src-tauri\target\release\VCPChat-Setup.exe"
If fso.FileExists(tauriExe) Then
  shell.CurrentDirectory = projectRoot
  shell.Run """" & tauriExe & """ --source-root """ & projectRoot & """", 1, False
  Set fso = Nothing
  Set shell = Nothing
  WScript.Quit 0
End If

electronExe = projectRoot & "\node_modules\electron\dist\electron.exe"
If fso.FileExists(electronExe) Then
  command = """" & electronExe & """ """" & projectRoot & "\bootstrap\recovery-main.cjs""""
  shell.CurrentDirectory = projectRoot
  shell.Run command, 0, False
Else
  npmExe = "npm.cmd"
  If shell.Environment("Process")("PATH") = "" Then
    MsgBox "VCPChat 需要先安装 Node.js，并在项目目录运行 npm install。", 48, "VCPChat 启动器"
  Else
    shell.CurrentDirectory = projectRoot
    shell.Run npmExe & " --prefix """ & projectRoot & """ run vcpchat:ui", 0, False
  End If
End If
Set fso = Nothing
Set shell = Nothing
