Option Explicit

Dim WshShell, commandToRun, projectPath

projectPath = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)

commandToRun = "cmd /c cd /d """ & projectPath & """ && npx electron . --rag-observer-only"

Set WshShell = CreateObject("WScript.Shell")

WshShell.Run commandToRun, 0, False

Set WshShell = Nothing
WScript.Quit
