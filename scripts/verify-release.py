"""Require every promised platform before making the release visible."""
from pathlib import Path
import hashlib
import json

root = Path("release-assets")
version = json.loads(Path("src-tauri/tauri.conf.json").read_text())["version"]
expected = {f"rlearn_{version}_aarch64.dmg", f"rlearn_{version}_x64.dmg",
            f"rlearn_{version}_x64-setup.exe", f"rlearn_{version}_x64_en-US.msi",
            f"rlearn_{version}_amd64.AppImage", f"rlearn_{version}_amd64.deb"}
actual = {p.name for p in root.iterdir() if p.is_file()}
assert actual == expected, f"Missing or unexpected assets: missing={expected - actual}, unexpected={actual - expected}"
(root / "SHA256SUMS").write_text("".join(
    f"{hashlib.sha256((root / name).read_bytes()).hexdigest()}  {name}\n" for name in sorted(actual)
))
print("All four platforms present; SHA256SUMS generated")
