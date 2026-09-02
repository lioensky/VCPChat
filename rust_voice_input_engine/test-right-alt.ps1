param(
    [ValidateSet("ScanCode", "VirtualKey")]
    [string]$InjectionMode = "ScanCode",

    [ValidateRange(50, 30000)]
    [int]$DurationMs = 1000,

    [ValidateRange(0, 10)]
    [int]$CountdownSeconds = 3
)

$ErrorActionPreference = "Stop"

if (-not ("RightAltInput.NativeMethods" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace RightAltInput
{
    public static class NativeMethods
    {
        private const uint INPUT_KEYBOARD = 1;
        private const ushort VK_RMENU = 0xA5;
        private const ushort RIGHT_ALT_SCAN_CODE = 0x38;

        private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        private const uint KEYEVENTF_KEYUP = 0x0002;
        private const uint KEYEVENTF_SCANCODE = 0x0008;

        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT
        {
            public uint type;
            public INPUTUNION data;
        }

        [StructLayout(LayoutKind.Explicit)]
        private struct INPUTUNION
        {
            // INPUT's native union is sized by its largest member (MOUSEINPUT).
            // Keeping only KEYBDINPUT makes Marshal.SizeOf<INPUT> too small
            // on x64 and causes SendInput to fail with ERROR_INVALID_PARAMETER.
            [FieldOffset(0)]
            public MOUSEINPUT mouse;

            [FieldOffset(0)]
            public KEYBDINPUT keyboard;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint flags;
            public uint time;
            public UIntPtr extraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT
        {
            public ushort virtualKey;
            public ushort scanCode;
            public uint flags;
            public uint time;
            public UIntPtr extraInfo;
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(
            uint inputCount,
            [In] INPUT[] inputs,
            int inputSize
        );

        private static INPUT CreateVirtualKeyInput(bool keyUp)
        {
            return new INPUT
            {
                type = INPUT_KEYBOARD,
                data = new INPUTUNION
                {
                    keyboard = new KEYBDINPUT
                    {
                        virtualKey = VK_RMENU,
                        scanCode = 0,
                        flags = KEYEVENTF_EXTENDEDKEY | (keyUp ? KEYEVENTF_KEYUP : 0),
                        time = 0,
                        extraInfo = UIntPtr.Zero
                    }
                }
            };
        }

        private static INPUT CreateScanCodeInput(bool keyUp)
        {
            return new INPUT
            {
                type = INPUT_KEYBOARD,
                data = new INPUTUNION
                {
                    keyboard = new KEYBDINPUT
                    {
                        virtualKey = 0,
                        scanCode = RIGHT_ALT_SCAN_CODE,
                        flags = KEYEVENTF_SCANCODE
                            | KEYEVENTF_EXTENDEDKEY
                            | (keyUp ? KEYEVENTF_KEYUP : 0),
                        time = 0,
                        extraInfo = UIntPtr.Zero
                    }
                }
            };
        }

        private static void SendSingle(INPUT input, string operation)
        {
            INPUT[] inputs = { input };
            uint sent = SendInput(1, inputs, Marshal.SizeOf<INPUT>());
            if (sent != 1)
            {
                int error = Marshal.GetLastWin32Error();
                throw new Win32Exception(
                    error,
                    String.Format(
                        "{0}: SendInput injected {1} of 1 event; Win32 error {2}",
                        operation,
                        sent,
                        error
                    )
                );
            }
        }

        public static void SetRightAlt(bool pressed, bool useScanCode)
        {
            INPUT input = useScanCode
                ? CreateScanCodeInput(!pressed)
                : CreateVirtualKeyInput(!pressed);

            SendSingle(
                input,
                String.Format(
                    "Right Alt {0} ({1})",
                    pressed ? "down" : "up",
                    useScanCode ? "E0 38 scan code" : "VK_RMENU"
                )
            );
        }
    }
}
'@
}

$useScanCode = $InjectionMode -eq "ScanCode"

Write-Host ""
Write-Host "Right Alt SendInput diagnostic" -ForegroundColor Cyan
Write-Host "  Injection mode : $InjectionMode"
Write-Host "  Hold duration  : $DurationMs ms"
Write-Host "  Elevated       : $([Security.Principal.WindowsPrincipal]::new(
    [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"
Write-Host ""
Write-Host "Focus the window where real Right Alt normally starts voice input." -ForegroundColor Yellow

for ($remaining = $CountdownSeconds; $remaining -gt 0; $remaining--) {
    Write-Host "Injecting in $remaining..."
    Start-Sleep -Seconds 1
}

$pressed = $false
try {
    Write-Host "Right Alt DOWN" -ForegroundColor Green
    [RightAltInput.NativeMethods]::SetRightAlt($true, $useScanCode)
    $pressed = $true

    Start-Sleep -Milliseconds $DurationMs
}
finally {
    if ($pressed) {
        [RightAltInput.NativeMethods]::SetRightAlt($false, $useScanCode)
        Write-Host "Right Alt UP" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "Test completed. The key-up event was sent." -ForegroundColor Cyan