"""VChat 米家子进程协议：stdout 只输出一行一个 JSON 对象。"""
import base64
import io
import json
import logging
import os
import sys
import tempfile
import time
from contextlib import redirect_stdout
from pathlib import Path

AUTH_PATH = Path.home() / ".config" / "mijia-api-auth.json"
AUTH_FIELDS = ("userId", "deviceId", "ssecurity", "serviceToken")
PROTOCOL = sys.stdout


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}, ensure_ascii=True), file=PROTOCOL, flush=True)


class BridgeError(Exception):
    def __init__(self, code):
        self.code = code


def read_auth():
    try:
        return json.loads(AUTH_PATH.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        raise BridgeError("login_required") from None
    except (OSError, ValueError):
        raise BridgeError("auth_file_invalid") from None


def validate_auth(auth):
    if not isinstance(auth, dict) or not all(auth.get(key) for key in AUTH_FIELDS):
        raise BridgeError("auth_file_invalid")


def save_auth(auth):
    AUTH_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".mijia-auth-", dir=AUTH_PATH.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            json.dump(auth, file)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp, AUTH_PATH)
    finally:
        Path(temp).unlink(missing_ok=True)


def show_qr(login_url):
    from qrcode import QRCode
    qr = QRCode(border=4, box_size=6)
    qr.add_data(login_url)
    image = io.BytesIO()
    qr.make_image().save(image, format="PNG")
    emit("qr", png=base64.b64encode(image.getvalue()).decode("ascii"))


def open_api(auth):
    from mijiaAPI import mijiaAPI
    validate_auth(auth)
    api = mijiaAPI(auth)
    available = api.available
    if (available() if callable(available) else available) is False:
        raise BridgeError("auth_expired")
    return api

def list_devices(auth):
    return device_rows(open_api(auth))

def device_rows(api):
    devices = api.get_devices_list()
    if not isinstance(devices, list):
        raise BridgeError("invalid_cloud_response")
    rows = []
    for item in devices:
        if not isinstance(item, dict) or not item.get("did"):
            continue
        online = item.get("isOnline", item.get("is_online", item.get("online")))
        rows.append({
            "id": str(item["did"]),
            "name": str(item.get("name") or "未命名设备"),
            "model": str(item.get("model") or ""),
            "online": online if isinstance(online, bool) else None,
        })
    return rows


def rows_by_property(rows, did):
    if not isinstance(rows, list):
        raise BridgeError("invalid_cloud_response")
    indexed = {}
    for row in rows:
        if not isinstance(row, dict) or str(row.get("did")) != did:
            continue
        siid, piid = row.get("siid"), row.get("piid")
        if type(siid) is int and type(piid) is int:
            key = (siid, piid)
            indexed[key] = row if key not in indexed else {}
    return indexed

def valid_read(prop, value):
    return type(value) is bool if prop["type"] == "boolean" else type(value) is int

def valid_write(prop, value):
    if not valid_read(prop, value):
        return False
    if prop["type"] == "boolean":
        return True
    return prop["min"] <= value <= prop["max"] and (value - prop["min"]) % prop["step"] == 0

def property_operation(command):
    raw = sys.stdin.read(8193)
    if len(raw) > 8192:
        raise BridgeError("invalid_request")
    try:
        request = json.loads(raw)
    except ValueError:
        raise BridgeError("invalid_request") from None
    if not isinstance(request, dict) or not isinstance(request.get("id"), str):
        raise BridgeError("invalid_request")
    did = request["id"]
    if not did or len(did) > 256:
        raise BridgeError("invalid_request")

    api = open_api(read_auth())
    device = next((d for d in device_rows(api) if d["id"] == did), None)
    if device is None:
        raise BridgeError("device_not_found")
    capabilities = json.loads(Path(__file__).with_name("capabilities.json").read_text(encoding="utf-8"))
    props = capabilities.get(device["model"], {}).get("properties", [])
    if not props:
        raise BridgeError("unsupported_device")

    if command == "write":
        mode, changes = request.get("mode"), request.get("changes")
        if mode not in ("immediate", "apply") or not isinstance(changes, dict) or not changes:
            raise BridgeError("invalid_request")
        allowed = {p["key"]: p for p in props if p.get("commit") == mode}
        if any(key not in allowed or not valid_write(allowed[key], value) for key, value in changes.items()):
            raise BridgeError("invalid_request")
        props = [p for p in props if p["key"] in changes]
        if device["online"] is False:
            raise BridgeError("device_offline")

    targets = [{"did": did, "siid": p["siid"], "piid": p["piid"]} for p in props]

    def read_values(items):
        requested = [{"did": did, "siid": p["siid"], "piid": p["piid"]} for p in items]
        received = rows_by_property(api.get_devices_prop(requested), did)
        values = {}
        for p in items:
            row = received.get((p["siid"], p["piid"]), {})
            value = row.get("value")
            if type(row.get("code")) is int and row["code"] == 0 and valid_read(p, value):
                values[p["key"]] = value
        return values

    if command == "read":
        return {"model": device["model"], "values": read_values(props)}

    results = {p["key"]: {"status": "unconfirmed"} for p in props}
    payload = [{**target, "value": changes[p["key"]]} for target, p in zip(targets, props)]
    try:
        written = rows_by_property(api.set_devices_prop(payload), did)
    except Exception:
        # A request without a trustworthy receipt can still have reached the device.
        return {"results": results}
    accepted = []
    for p in props:
        code = written.get((p["siid"], p["piid"]), {}).get("code")
        if type(code) is int:
            if code == 0:
                accepted.append(p)
            else:
                results[p["key"]] = {"status": "rejected", "code": code}
    if accepted:
        try:
            time.sleep(0.5)
            observed = read_values(accepted)
        except Exception:
            observed = {}
        for key, value in observed.items():
            results[key] = {
                "status": "confirmed" if value == changes[key] else "unconfirmed",
                "value": value,
            }
    return {"results": results}

def run(command):
    if command == "list":
        return list_devices(read_auth())
    if command == "login":
        from mijiaAPI import mijiaLogin
        login = mijiaLogin()
        login._print_qr = show_qr  # mijiaAPI 2.0.1 的二维码输出回调
        auth = login.QRlogin()
        emit("verifying")
        devices = list_devices(auth)
        save_auth(auth)
        return devices
    raise BridgeError("unsupported_command")


def main():
    logging.disable(logging.CRITICAL)
    try:
        command = sys.argv[1] if len(sys.argv) == 2 else ""
        with redirect_stdout(sys.stderr):
            if command in ("read", "write"):
                result = property_operation(command)
            else:
                result = {"devices": run(command)}
        emit("properties" if command in ("read", "write") else "devices", **result)
    except BridgeError as exc:
        emit("error", code=exc.code)
    except ModuleNotFoundError:
        emit("error", code="sdk_missing")
    except OSError:
        emit("error", code="io_error")
    except Exception:
        emit("error", code="request_failed")


if __name__ == "__main__":
    main()