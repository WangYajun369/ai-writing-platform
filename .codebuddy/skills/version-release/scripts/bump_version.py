#!/usr/bin/env python3
"""
TimeWrite 版本号自动化更新脚本
用法:
  python3 .codebuddy/skills/version-release/scripts/bump_version.py major     # 大版本 0.1.0 → 1.0.0
  python3 .codebuddy/skills/version-release/scripts/bump_version.py minor     # 新功能 0.1.0 → 0.2.0
  python3 .codebuddy/skills/version-release/scripts/bump_version.py patch     # 优化   0.1.0 → 0.1.1
  python3 .codebuddy/skills/version-release/scripts/bump_version.py set 0.5.0 # 重置为指定版本
"""

import json
import re
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent.parent

FILES = {
    "package.json": {
        "path": PROJECT_ROOT / "package.json",
        "type": "json",
        "key": "version",
    },
    "Cargo.toml": {
        "path": PROJECT_ROOT / "src-tauri" / "Cargo.toml",
        "type": "toml_top",
        "pattern": r'^version\s*=\s*"([^"]+)"',
        "replacement": 'version = "{version}"',
    },
    "tauri.conf.json": {
        "path": PROJECT_ROOT / "src-tauri" / "tauri.conf.json",
        "type": "json",
        "key": "version",
    },
    "README.md（应用信息表格版本）": {
        "path": PROJECT_ROOT / "README.md",
        "type": "regex",
        "pattern": r"\| 版本 \| (\d+\.\d+\.\d+) \|",
        "replacement": "| 版本 | {version} |",
    },
    ".github/workflows/release.yml": {
        "path": PROJECT_ROOT / ".github" / "workflows" / "release.yml",
        "type": "regex",
        "pattern": r"(default:\s*)'\d+\.\d+\.\d+'",
        "replacement": r"\1'{version}'",
    },
}


def read_current_version() -> str:
    """从 package.json 读取当前版本号"""
    pkg_path = PROJECT_ROOT / "package.json"
    with open(pkg_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data["version"]


def bump_version(current: str, level: str) -> str:
    """递进版本号: major / minor / patch"""
    parts = [int(x) for x in current.split(".")]
    if len(parts) != 3:
        raise ValueError(f"版本号格式错误，需要 X.Y.Z 格式: {current}")

    major, minor, patch = parts
    if level == "major":
        return f"{major + 1}.0.0"
    elif level == "minor":
        return f"{major}.{minor + 1}.0"
    elif level == "patch":
        return f"{major}.{minor}.{patch + 1}"
    else:
        raise ValueError(f"未知的递进等级: {level}，可选: major/minor/patch")


def update_file(filepath: Path, old_ver: str, new_ver: str, cfg: dict):
    """根据文件类型更新版本号"""
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    if cfg["type"] == "json":
        data = json.loads(content)
        data[cfg["key"]] = new_ver
        new_content = json.dumps(data, indent=2, ensure_ascii=False)
        if filepath.suffix == ".json":
            new_content += "\n"
    elif cfg["type"] == "regex" or cfg["type"] == "toml_top":
        pattern = cfg["pattern"]
        replacement = cfg["replacement"].format(version=new_ver)
        # re.MULTILINE 确保 ^/$ 能匹配每行开头/结尾
        new_content, count = re.subn(pattern, replacement, content, count=1, flags=re.MULTILINE)
        if count == 0:
            raise RuntimeError(
                f"在 {filepath.name} 中未匹配到版本号模式: {pattern}"
            )
    else:
        raise ValueError(f"未知文件类型: {cfg['type']}")

    with open(filepath, "w", encoding="utf-8") as f:
        f.write(new_content)


def main():
    if len(sys.argv) < 2:
        print("用法: bump_version.py <major|minor|patch|set> [version]")
        sys.exit(1)

    action = sys.argv[1]
    current = read_current_version()

    if action == "set":
        if len(sys.argv) < 3:
            print("set 命令需要指定版本号，例如: bump_version.py set 0.5.0")
            sys.exit(1)
        new_version = sys.argv[2]
    elif action in ("major", "minor", "patch"):
        new_version = bump_version(current, action)
    else:
        print(f"未知操作: {action}，可选: major / minor / patch / set")
        sys.exit(1)

    print(f"当前版本: {current}")
    print(f"目标版本: {new_version}")
    print()

    # 更新所有文件
    for name, cfg in FILES.items():
        filepath = cfg["path"]
        if not filepath.exists():
            print(f"⚠️  跳过（文件不存在）: {name}")
            continue
        try:
            update_file(filepath, current, new_version, cfg)
            print(f"✅ 已更新: {name}")
        except Exception as e:
            print(f"❌ 更新失败 {name}: {e}")

    print()
    print("=" * 50)
    print(f"版本 {current} → {new_version} 更新完成！")
    print(f"请检查以上文件，确认无误后执行:")
    print(f"  git add -A")
    print(f'  git commit -m "chore: bump version to {new_version}"')
    print(f"  git tag v{new_version}")
    print(f"  git push origin main --tags")


if __name__ == "__main__":
    main()
