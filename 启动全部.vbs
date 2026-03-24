Option Explicit

Dim WshShell, fso, projectPath, splashPath, desktopCommand, vchatCommand

' 获取脚本所在的目录（假设 .vbs 文件在项目根目录）
Set fso = CreateObject("Scripting.FileSystemObject")
projectPath = fso.GetParentFolderName(WScript.ScriptFullName)
splashPath = """" & projectPath & "\NativeSplash.exe"""

' 构建 V桌面启动命令（先启动，作为主实例获取单实例锁）
desktopCommand = "cmd /c cd /d """ & projectPath & """ && npx electron . --desktop-only"

' 构建 VChat 主程序启动命令（后启动，作为第二实例触发 bootstrapFullApp）
' 利用 Electron 单实例锁机制：第二实例会触发已运行实例的 second-instance 回调，
' 自动执行 bootstrapFullApp() 创建主窗口并完成所有模块初始化。
vchatCommand = "cmd /c cd /d """ & projectPath & """ && npx electron ."

Set WshShell = CreateObject("WScript.Shell")

' 第一步：启动启动动画（NativeSplash.exe）
WshShell.Run splashPath, 0, False

' 第二步：先启动 V桌面（更快展示桌面界面，提升用户体验）
WshShell.Run desktopCommand, 0, False

' 第三步：等待 3 秒让桌面进程获取单实例锁并完成初始化
WScript.Sleep 3000

' 第四步：启动 VChat 主程序（作为第二实例，触发桌面进程中的 bootstrapFullApp）
WshShell.Run vchatCommand, 0, False

Set fso = Nothing
Set WshShell = Nothing

WScript.Quit