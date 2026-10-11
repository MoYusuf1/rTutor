"""Require every promised platform before making the release visible."""
from pathlib import Path
import hashlib
import json

root = Path("release-assets")
version = json.loads(Path("src-tauri/tauri.conf.json").read_text())["version"]
# bundlers differ on the name's case (rTutor_…dmg, rtutor_…deb), so compare without it
expected = {f"rtutor_{version}_aarch64.dmg", f"rtutor_{version}_x64.dmg",
            f"rtutor_{version}_x64-setup.exe", f"rtutor_{version}_x64_en-us.msi",
            f"rtutor_{version}_amd64.appimage", f"rtutor_{version}_amd64.deb"}
actual = {p.name.lower() for p in root.iterdir() if p.is_file()}
assert actual == expected, f"Missing or unexpected assets: missing={expected - actual}, unexpected={actual - expected}"
(root / "SHA256SUMS").write_text("".join(
    f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n" for p in sorted(root.iterdir()) if p.is_file() and p.name != "SHA256SUMS"
))
print("All four platforms present; SHA256SUMS generated")
