#!/usr/bin/env python3
"""
MirageInk (TimeWrite) 版本号自动化更新脚本
用法:
  python3 .codebuddy/skills/version-release/scripts/bump_version.py major       # 大版本 0.1.0 → 1.0.0
  python3 .codebuddy/skills/version-release/scripts/bump_version.py minor       # 新功能 0.1.0 → 0.2.0
  python3 .codebuddy/skills/version-release/scripts/bump_version.py patch       # 优化   0.1.0 → 0.1.1
  python3 .codebuddy/skills/version-release/scripts/bump_version.py set 0.5.0   # 重置为指定版本
  python3 .codebuddy/skills/version-release/scripts/bump_version.py major --dry-run  # 预览模式（不写入文件）

涉及更新的 5 个文件：
  - package.json           → JSON 字段 version
  - src-tauri/Cargo.toml   → TOML 字段 package.version
  - src-tauri/tauri.conf.json → JSON 字段 version
  - README.md              → 应用信息表格中的版本号
  - .github/workflows/release.yml → workflow_dispatch 默认值
  - docs/CHANGELOG.md      → 自动插入新版本条目头部（## vX.Y.Z (日期)）
"""

import json
import re
import sys
from datetime import datetime
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

CHANGELOG_PATH = PROJECT_ROOT / "docs" / "CHANGELOG.md"


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
        new_content, count = re.subn(pattern, replacement, content, count=1, flags=re.MULTILINE)
        if count == 0:
            raise RuntimeError(
                f"在 {filepath.name} 中未匹配到版本号模式: {pattern}"
            )
    else:
        raise ValueError(f"未知文件类型: {cfg['type']}")

    with open(filepath, "w", encoding="utf-8") as f:
        f.write(new_content)


def insert_changelog_entry(new_version: str):
    """在 docs/CHANGELOG.md 中插入新版本条目头部（与现有格式一致）"""
    if not CHANGELOG_PATH.exists():
        print(f"⚠️  CHANGELOG.md 不存在，跳过插入版本条目。")
        return

    with open(CHANGELOG_PATH, "r", encoding="utf-8") as f:
        content = f.read()

    today = datetime.now().strftime("%Y-%m-%d")
    new_entry = f"## v{new_version} ({today})"

    # 检查是否已存在该版本条目（避免重复插入）
    if new_entry in content:
        print(f"⚠️  CHANGELOG.md 中已存在 {new_entry}，跳过插入。")
        return

    # 在第一个 ## v 标题之前插入（即最新版本条目位置）
    # 找到 # 更新日志 之后的第一个 ## v 标题
    changelog_header = "# 更新日志\n"
    idx = content.find(changelog_header)
    if idx == -1:
        print(f"⚠️  未在 CHANGELOG.md 中找到 '# 更新日志' 标题，在文件顶部插入。")
        new_content = new_entry + "\n\n" + content
    else:
        # 在 # 更新日志 行后的第一个换行之后、第一个 ## v 之前插入
        insert_pos = idx + len(changelog_header)
        # 跳过可能的空行
        while insert_pos < len(content) and content[insert_pos] == '\n':
            insert_pos += 1
        new_content = content[:insert_pos] + new_entry + "\n\n" + content[insert_pos:]

    with open(CHANGELOG_PATH, "w", encoding="utf-8") as f:
        f.write(new_content)
    print(f"✅ 已在 CHANGELOG.md 中插入: {new_entry}")


def update_changelog_header(old_ver: str, new_ver: str):
    """当执行 set 命令时，同时更新 CHANGELOG.md 中已有版本条目的版本号"""
    if not CHANGELOG_PATH.exists():
        return

    with open(CHANGELOG_PATH, "r", encoding="utf-8") as f:
        content = f.read()

    # 匹配 ## v{old_ver} (日期) 格式
    pattern = rf"^## v{re.escape(old_ver)} \((\d{{4}}-\d{{2}}-\d{{2}})\)"
    new_header = f"## v{new_ver} (\\1)"
    new_content, count = re.subn(pattern, new_header, content, count=1, flags=re.MULTILINE)

    if count > 0:
        with open(CHANGELOG_PATH, "w", encoding="utf-8") as f:
            f.write(new_content)
        print(f"✅ 已同步 CHANGELOG.md 中的版本标题: v{old_ver} → v{new_ver}")
    else:
        print(f"⚠️  未在 CHANGELOG.md 中找到 v{old_ver} 的版本标题，可能为新版本号。")

    return count


def main():
    dry_run = "--dry-run" in sys.argv
    args = [a for a in sys.argv[1:] if a != "--dry-run"]

    if len(args) < 1:
        print("用法: bump_version.py <major|minor|patch|set> [version] [--dry-run]")
        print("  --dry-run  预览模式，仅显示将要执行的操作，不实际修改文件")
        sys.exit(1)

    action = args[0]
    current = read_current_version()

    if action == "set":
        if len(args) < 2:
            print("set 命令需要指定版本号，例如: bump_version.py set 0.5.0")
            sys.exit(1)
        new_version = args[1]
    elif action in ("major", "minor", "patch"):
        new_version = bump_version(current, action)
    else:
        print(f"未知操作: {action}，可选: major / minor / patch / set")
        sys.exit(1)

    print(f"当前版本: {current}")
    print(f"目标版本: {new_version}")

    if dry_run:
        print()
        print("[DRY-RUN 模式] 以下文件将被更新（未实际写入）：")
        for name, cfg in FILES.items():
            filepath = cfg["path"]
            exists = "存在" if filepath.exists() else "缺失"
            print(f"  {'✅' if filepath.exists() else '⚠️'} {name} ({exists})")
        print()
        print("=" * 50)
        print(f"[DRY-RUN] 版本 {current} → {new_version}（未执行）")
        return

    print()

    updated_count = 0
    failed_count = 0

    # 更新所有文件
    for name, cfg in FILES.items():
        filepath = cfg["path"]
        if not filepath.exists():
            print(f"⚠️  跳过（文件不存在）: {name}")
            failed_count += 1
            continue
        try:
            update_file(filepath, current, new_version, cfg)
            print(f"✅ 已更新: {name}")
            updated_count += 1
        except Exception as e:
            print(f"❌ 更新失败 {name}: {e}")
            failed_count += 1

    # 处理 CHANGELOG.md
    if action == "set":
        # set 命令：更新已有版本条目的标题
        update_changelog_header(current, new_version)
    elif action in ("major", "minor", "patch"):
        # bump 命令：插入新版本条目
        insert_changelog_entry(new_version)

    print()
    print("=" * 50)
    print(f"版本 {current} → {new_version} 更新完成！")
    print(f"成功: {updated_count} 个文件, 失败: {failed_count} 个文件")
    print()

    # ========== 分支检测与提示 ==========
    current_branch = "main"
    try:
        import subprocess
        result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, cwd=PROJECT_ROOT
        )
        if result.returncode == 0:
            current_branch = result.stdout.strip()
    except Exception:
        pass

    # 检查 dev 是否已合并到 main（仅当在 main 分支时有意义）
    dev_merged = True
    if current_branch == "main":
        try:
            import subprocess
            result = subprocess.run(
                ["git", "branch", "--merged", "main"],
                capture_output=True, text=True, cwd=PROJECT_ROOT
            )
            if result.returncode == 0:
                merged_branches = result.stdout.strip()
                if "dev" not in merged_branches:
                    dev_merged = False
        except Exception:
            pass

    print("后续步骤:")
    print(f"  当前分支: {current_branch}")

    if current_branch != "main":
        print()
        print(f"  ⚠️  警告: 当前在 '{current_branch}' 分支，版本发布应在 'main' 分支执行！")
        print(f"  推荐流程:")
        print(f"    git checkout main")
        print(f"    git pull origin main")
        print(f"    git merge {current_branch}")
        print(f"    然后重新执行 bump_version.py")
        print()
        print(f"  如果确实要在 '{current_branch}' 分支操作（不推荐），执行:")
        print(f"    git add -A")
        print(f'    git commit -m "chore: bump version to v{new_version}"')
        print(f"    git tag v{new_version}")
        print(f"    git push origin {current_branch} --tags")
    elif not dev_merged:
        print()
        print(f"  ⚠️  警告: 'dev' 分支尚未完全合并到 'main'！")
        print(f"  请先执行: git merge dev")
        print(f"  然后再进行后续提交操作。")
        print()
        print(f"  git add -A")
        print(f'  git commit -m "chore: bump version to v{new_version}"')
        print(f"  git tag v{new_version}")
        print(f"  git push origin main --tags")
    else:
        print(f"  git add -A")
        print(f'  git commit -m "chore: bump version to v{new_version}"')
        print(f"  git tag v{new_version}")
        print(f"  git push origin main --tags")
        print()
        print(f"  发版后同步 dev:")
        print(f"    git checkout dev && git merge main && git push origin dev")

    print()
    print("📝 提醒: 使用 '--dry-run' 参数可预览操作而不写入文件。")


if __name__ == "__main__":
    main()
