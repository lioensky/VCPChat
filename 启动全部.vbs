Option Explicit

Dim WshShell, projectPath, launcherPath

projectPath = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
launcherPath = """" & projectPath & "\StartVCPchat.exe"""

' 兼容旧快捷方式：Rust 启动器现在独立负责启动、进度监听与生命周期监督。
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run launcherPath, 0, False
Set WshShell = Nothing

WScript.Quit