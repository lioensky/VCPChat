Option Explicit

Dim WshShell, fso, projectPath, splashPath, vchatCommand, desktopCommand
Dim readyFilePath, waitCount

' 获取脚本所在的目录（假设 .vbs 文件在项目根目录）
Set fso = CreateObject("Scripting.FileSystemObject")
projectPath = fso.GetParentFolderName(WScript.ScriptFullName)
splashPath = """" & projectPath & "\NativeSplash.exe"""
readyFilePath = projectPath & "\.vcp_ready"

' 构建 VChat 主程序启动命令
vchatCommand = "cmd /c cd /d """ & projectPath & """ && npx electron ."

' 构建 V桌面启动命令（作为第二实例，附带 --desktop-only 参数）
desktopCommand = "cmd /c cd /d """ & projectPath & """ && npx electron . --desktop-only"

Set WshShell = CreateObject("WScript.Shell")

' 第一步：启动启动动画（NativeSplash.exe）
WshShell.Run splashPath, 0, False

' 第二步：启动 VChat 主程序
WshShell.Run vchatCommand, 0, False

' 第三步：等待 VChat 主窗口准备就绪
' 主窗口 ready-to-show 时会创建 .vcp_ready 文件作为信号
' 轮询检测该文件，最多等待 60 秒
waitCount = 0
Do While waitCount < 120
    WScript.Sleep 500
    waitCount = waitCount + 1
    If fso.FileExists(readyFilePath) Then
        Exit Do
    End If
Loop

' 额外等待 2 秒，确保主进程完全初始化（IPC 注册等）
WScript.Sleep 2000

' 第四步：启动 V桌面
WshShell.Run desktopCommand, 0, False

Set fso = Nothing
Set WshShell = Nothing

WScript.Quit