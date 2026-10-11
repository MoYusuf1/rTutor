"""Stage only finished installers, preserving executable mode for the Arch check."""
from pathlib import Path
import shutil
import sys

target = sys.argv[1]
root = Path("src-tauri/target") / target / "release/bundle"
expected = {"aarch64-apple-darwin": [".dmg"], "x86_64-apple-darwin": [".dmg"],
            "x86_64-pc-windows-msvc": [".exe", ".msi"], "x86_64-unknown-linux-gnu": [".AppImage", ".deb"]}[target]
out = Path("release-assets")
out.mkdir(exist_ok=True)
for suffix in expected:
    files = list(root.rglob("*" + suffix))
    assert len(files) == 1, f"Expected exactly one {suffix} installer, found {files}"
    shutil.copy2(files[0], out / files[0].name)
    print(files[0].name)
