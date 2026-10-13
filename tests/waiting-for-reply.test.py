import base64
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "VCPDistributedServer/Plugin/WaitingForUrReply"
spec = importlib.util.spec_from_file_location("waiting_reply", PLUGIN / "waiting_for_reply.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReplyTests(unittest.TestCase):
    def call(self, response, options=None, prompt="问题"):
        result = subprocess.CompletedProcess([], 0, json.dumps(response, ensure_ascii=False), "")
        with patch.object(module.subprocess, "run", return_value=result) as run:
            value = module.UserInputHandler()._show_windows_dialog(
                prompt, options or [], 30, "预填", "标题")
        return value, run.call_args

    def test_unicode_multiline_and_literal_sentinels(self):
        for text in ["中文,逗号\n第二行😀", "CANCELLED", "DISABLED", '$("$x"); `恶意`']:
            self.assertEqual(self.call({"kind": "text", "text": text})[0], text)

    def test_data_not_executable(self):
        prompt = '$(Start-Process calc); "中文"\n<>&'
        _, args = self.call({"kind": "cancel"}, prompt=prompt)
        command = args.args[0]
        bootstrap = base64.b64decode(command[-1]).decode("utf-16-le")
        self.assertNotIn(prompt, bootstrap)
        self.assertIn("ReadAllText", bootstrap)
        self.assertEqual(json.loads(args.kwargs["input"])["prompt"], prompt)
        self.assertEqual(args.kwargs["encoding"], "utf-8")
        self.assertEqual(args.kwargs["timeout"], 35)
        self.assertIn("-STA", command)

    def test_option_is_not_disable_command(self):
        self.assertEqual(self.call({"kind": "option", "text": "~"}, [("1", "~")])[0], "~")

    def test_invalid_option(self):
        self.assertEqual(self.call({"kind": "option", "text": "foreign"}, [("1", "yes")])[0],
                         "（对方未回复明确内容）")

    def test_text_number_legacy_mapping(self):
        self.assertEqual(self.call({"kind": "text", "text": "2"}, [("1", "甲"), ("2", "乙")])[0], "乙")

    def test_disable(self):
        for response in [{"kind": "disable"}, {"kind": "text", "text": " disable "}]:
            self.assertIn("[System Warning]", self.call(response)[0])

    def test_cancel_and_empty(self):
        for response in [{"kind": "cancel"}, {"kind": "text", "text": "  "}, {"kind": "unknown"}]:
            self.assertEqual(self.call(response)[0], "（对方未回复明确内容）")

    def test_timeout_and_failure(self):
        handler = module.UserInputHandler()
        for error in [subprocess.TimeoutExpired("powershell", 1), OSError("missing")]:
            with patch.object(module.subprocess, "run", side_effect=error):
                self.assertEqual(handler._show_windows_dialog("x", [], 1), "（对方未回复明确内容）")
        with patch.object(module.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "failed")):
            self.assertEqual(handler._show_windows_dialog("x", [], 1), "（对方未回复明确内容）")

    def test_zero_timeout_does_not_open(self):
        with patch.object(module.subprocess, "run") as run:
            self.assertEqual(module.UserInputHandler()._show_windows_dialog("x", [], 0), "（对方未回复明确内容）")
            run.assert_not_called()

    def test_options_parsing(self):
        self.assertEqual(module.parse_options({"option01": " 甲 ", "option09": "乙", "option02": ""}),
                         [("1", "甲"), ("9", "乙")])


if __name__ == "__main__":
    unittest.main()