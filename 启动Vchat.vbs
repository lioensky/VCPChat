Option Explicit

Dim WshShell, projectPath, electronPath, commandToRun

projectPath = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
electronPath = projectPath & "\node_modules\electron\dist\electron.exe"
commandToRun = """" & electronPath & """ ."

' 无启动动画的独立兜底入口，不依赖 Rust 启动器。
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = projectPath
WshShell.Run commandToRun, 0, False
Set WshShell = Nothing

WScript.Quit
