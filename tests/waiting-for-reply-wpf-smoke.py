"""Windows-only: shows a real card briefly and verifies timer-driven exit."""
import base64
import json
import os
from pathlib import Path
import subprocess
import time

root = Path(__file__).resolve().parents[1]
script = root / "VCPDistributedServer/Plugin/WaitingForUrReply/windows_dialog.ps1"
bootstrap = "$ProgressPreference='SilentlyContinue'; & ([scriptblock]::Create([IO.File]::ReadAllText('" + str(script).replace("'", "''") + "', [Text.Encoding]::UTF8)))"
encoded = base64.b64encode(bootstrap.encode("utf-16-le")).decode("ascii")
exe = str(Path(os.environ.get("SystemRoot", r"C:\Windows")) /
          "System32/WindowsPowerShell/v1.0/powershell.exe")
for options in [[], [["1", "继续，中文 $() <>&"], ["2", "~"]]]:
    start = time.monotonic()
    result = subprocess.run(
        [exe, "-NoLogo", "-NoProfile", "-NonInteractive", "-STA",
         "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
        input=json.dumps({"title": "单卡片真实冒烟", "prompt": "中文 / $() / <>&\n无需操作，自动关闭。",
                          "options": options, "placeholder": "预填中文", "timeout": 2}, ensure_ascii=False),
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    assert result.returncode == 0, result.stderr
    assert not result.stderr.strip(), result.stderr
    assert json.loads(result.stdout) == {"kind": "cancel", "text": ""}, result.stdout
    assert 1.8 <= time.monotonic() - start < 15
    print("PASS: real WPF card, options=", len(options), "timer closed and process exited")