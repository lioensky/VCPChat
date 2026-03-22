Option Explicit

Dim WshShell, fso, projectPath, splashPath, vchatCommand, desktopCommand

' 获取脚本所在的目录（假设 .vbs 文件在项目根目录）
Set fso = CreateObject("Scripting.FileSystemObject")
projectPath = fso.GetParentFolderName(WScript.ScriptFullName)
splashPath = """" & projectPath & "\NativeSplash.exe"""

' 构建 VChat 主程序启动命令
vchatCommand = "cmd /c cd /d """ & projectPath & """ && npx electron ."

' 构建 V桌面启动命令（作为第二实例，附带 --desktop-only 参数）
desktopCommand = "cmd /c cd /d """ & projectPath & """ && npx electron . --desktop-only"

Set WshShell = CreateObject("WScript.Shell")

' 第一步：启动启动动画（NativeSplash.exe）
WshShell.Run splashPath, 0, False

' 第二步：启动 VChat 主程序
WshShell.Run vchatCommand, 0, False

' 第三步：等待几秒让 VChat 主进程完成初始化，然后启动 V桌面
' 因为 V桌面以 --desktop-only 作为第二实例运行，需要主进程先获取单实例锁
WScript.Sleep 5000

' 第四步：启动 V桌面
WshShell.Run desktopCommand, 0, False

Set fso = Nothing
Set WshShell = Nothing

WScript.Quit