Option Explicit

Dim WshShell, projectPath, commandToRun

projectPath = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
commandToRun = "cmd /c cd /d """ & projectPath & """ && npx electron . --desktop-only"

Set WshShell = CreateObject("WScript.Shell")
WshShell.Run commandToRun, 0, False
Set WshShell = Nothing

WScript.Quit