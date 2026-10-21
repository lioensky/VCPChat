Set WshShell = CreateObject("WScript.Shell")
Set WshEnv = WshShell.Environment("Process")
projectPath = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
runtimesBase = projectPath & "\..\runtimes"
WshEnv("PATH") = runtimesBase & "\node;" & runtimesBase & "\git\cmd;" & runtimesBase & "\python;" & runtimesBase & "\python\Scripts;" & WshEnv("PATH")
WshShell.CurrentDirectory = projectPath

WshShell.Run "cmd /c npx electron . --rag-observer-only", 0, False
