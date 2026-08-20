Option Explicit

Dim WshShell, projectPath, launcherPath

projectPath = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
launcherPath = """" & projectPath & "\StartVCPchat.exe"""

' 兼容旧快捷方式；NativeSplash 已独立负责无控制台启动和监督 VChat。
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run launcherPath, 0, False
Set WshShell = Nothing

WScript.Quit
