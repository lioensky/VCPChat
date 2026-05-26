# -*- coding: utf-8 -*-
import sys
import json
import os
import subprocess

def print_json_output(status, result=None, error=None):
    """Helper function to format and print JSON output."""
    output = {"status": status}
    if result is not None:
        output["result"] = result
    if error is not None:
        output["error"] = error
    print(json.dumps(output, ensure_ascii=False))

def main():
    try:
        # 1. Read input from stdin
        input_line = sys.stdin.readline()
        if not input_line:
            raise ValueError("No input received from stdin.")
            
        input_data = json.loads(input_line)
        time_description = input_data.get("time_description")
        reminder_text = input_data.get("reminder_text", "")

        if not time_description:
            raise ValueError("'time_description' parameter is required.")

        if reminder_text is None:
            reminder_text = ""
        else:
            reminder_text = str(reminder_text).strip()

        # 2. Prepare paths for the background script and its assets
        current_dir = os.path.dirname(os.path.abspath(__file__))
        run_alarm_script_path = os.path.join(current_dir, "run_alarm.py")
        audio_path = os.path.join(current_dir, "AlarmRing.mp3")
        image_path = os.path.join(current_dir, "VCPAgent.png")
        
        # Ensure the background script exists
        if not os.path.exists(run_alarm_script_path):
            raise FileNotFoundError("The background alarm script 'run_alarm.py' was not found.")

        # 3. Launch the background process
        # We use sys.executable to ensure we're using the same Python interpreter
        # that's running this script.
        command = [
            sys.executable,
            run_alarm_script_path,
            time_description,
            audio_path,
            image_path,
            reminder_text
        ]

        # Use DETACHED_PROCESS creation flag on Windows to ensure the new process
        # runs independently and isn't terminated when this parent script exits.
        # For Linux/macOS, the default behavior of Popen is usually sufficient.
        creation_flags = 0
        if sys.platform == "win32":
            creation_flags = subprocess.DETACHED_PROCESS

        subprocess.Popen(command, creationflags=creation_flags, close_fds=True)

        # 4. Immediately respond with success
        success_message = f"好的，您的闹钟已经设定成功。时间：{time_description}"
        if reminder_text:
            success_message += f"，提醒事项：{reminder_text}"
        print_json_output(status="success", result=success_message)
        sys.stdout.flush()

    except Exception as e:
        print_json_output(status="error", error=f"An error occurred: {str(e)}")
        sys.stdout.flush()

if __name__ == "__main__":
    main()