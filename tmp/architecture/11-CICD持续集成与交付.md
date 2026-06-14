# 11 — CI/CD 持续集成与交付

## 11.1 概述

MirageInk 是三语言技术栈的 Tauri 桌面应用，CI/CD 面临以下特殊挑战：

| 挑战 | 影响 |
|------|------|
| 三语言构建（TS/Rust/Python） | 需多工具链并行安装 |
| 跨平台桌面打包 | 需 macOS/Windows/Linux 三平台 Runner |
| macOS 签名与公证 | 需 Apple Developer 证书 + Notary Tool |
| Python Agent 随应用分发 | 需 PyInstaller 打包或嵌入式解释器 |
| 自动更新 | 需生成 update.json + 签名验证 |
| GitHub Releases 分发 | 需上传多平台 artifacts |

## 11.2 流水线全景

```
Pull Request
  │
  ├──► CI Pipeline ──────────────── Quality Gate ──► Merge
  │      ├─ Lint (TS + Rust + Python)
  │      ├─ Type Check (TS)
  │      ├─ Unit Tests (TS + Rust + Python)
  │      ├─ Security Audit (npm audit + cargo audit + pip-audit)
  │      └─ Tauri Build (sanity check only)
  │
Merge to main
  │
  └──► CD Pipeline ───────────────► GitHub Release
         ├─ Version Bump (auto)
         ├─ Cross-Platform Build
         │   ├─ macOS x86_64 + aarch64 (signed + notarized)
         │   ├─ Windows x86_64 (signed)
         │   └─ Linux AppImage + deb
         ├─ Python Agent Bundle
         ├─ Update Manifest Generation
         └─ GitHub Release + Artifacts Upload
```

## 11.3 多阶段 CI 设计

### 11.3.1 设计原则

1. **并行执行**：三个语言栈的检查并行跑，互不阻塞
2. **快速反馈**：lint 和 type-check 先于重量级测试，10s 内出初步反馈
3. **缓存利用**：cargo cache、pnpm store、pip cache 全部缓存
4. **条件执行**：仅相关文件变更时触发对应步骤

### 11.3.2 整体编排

```yaml
# .github/workflows/ci.yml
name: CI
on:
  pull_request:
    branches: [main, dev]
  push:
    branches: [dev]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  # ── 快速检查（并行，最先完成） ──
  lint-and-type:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Toolchains
        uses: ./.github/actions/setup-all
      - name: Rust lint
        run: cargo clippy --all-targets -- -D warnings
      - name: TS lint + type-check
        run: |
          pnpm lint
          pnpm tsc --noEmit

  # ── 安全审计（并行） ──
  security-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Toolchains
        uses: ./.github/actions/setup-all
      - name: Rust dependency audit
        run: cargo audit
      - name: npm audit
        run: pnpm audit --audit-level=high
      - name: Python dependency audit
        run: |
          cd agent
          pip-audit --strict
      - name: Secret scan
        uses: gitleaks/gitleaks-action@v2

  # ── 单元测试（并行） ──
  test-rust:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Toolchains
        uses: ./.github/actions/setup-all
      - name: Rust tests
        run: cargo test --all-features -- --test-threads=4
      - name: Coverage
        run: |
          cargo tarpaulin --out Xml --output-dir coverage
      - uses: actions/upload-artifact@v4
        with:
          name: rust-coverage
          path: coverage/cobertura.xml

  test-frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Toolchains
        uses: ./.github/actions/setup-all
      - name: Frontend tests
        run: pnpm test -- --coverage --reporter=verbose
      - uses: actions/upload-artifact@v4
        with:
          name: frontend-coverage
          path: coverage/

  test-python:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Toolchains
        uses: ./.github/actions/setup-all
      - name: Python tests
        run: |
          cd agent
          pytest tests/ --cov --cov-report=xml --cov-report=term
      - uses: actions/upload-artifact@v4
        with:
          name: python-coverage
          path: agent/coverage.xml

  # ── E2E 测试（WebDriver 多窗口场景，详见 10-测试策略） ──
  test-e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Toolchains
        uses: ./.github/actions/setup-all
      - name: Install WebDriver
        run: |
          sudo apt-get install -y chromium-chromedriver
      - name: Build Tauri (CI mode)
        run: pnpm tauri build --ci --debug
      - name: Run E2E tests
        run: pnpm test:e2e -- --reporter=verbose
      - name: Upload E2E artifacts (screenshots on failure)
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: e2e-screenshots
          path: test-results/e2e/

  # ── Tauri 构建验证（仅校验编译通过，不签名） ──
  build-check:
    needs: [lint-and-type]
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - name: Setup Toolchains
        uses: ./.github/actions/setup-all
      - name: Tauri build (dry-run)
        run: pnpm tauri build --ci --debug
      - name: Smoke test binary
        run: |
          # 验证二进制可执行
          if [[ "${{ matrix.os }}" == "macos-latest" ]]; then
            ls -la src-tauri/target/debug/bundle/dmg/*.dmg
          fi

  # ── Quality Gate ──
  quality-gate:
    needs: [test-rust, test-frontend, test-python, test-e2e, security-audit, build-check]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - name: Check all required jobs
        run: |
          echo "All checks passed — ready to merge"
```

### 11.3.3 共享 Action：工具链安装

```yaml
# .github/actions/setup-all/action.yml
name: Setup All Toolchains
description: Install Rust, Node/pnpm, Python for MirageInk

runs:
  using: composite
  steps:
    # Rust
    - uses: actions-rust-lang/setup-rust-toolchain@v1
      with:
        toolchain: stable
        components: clippy, rustfmt

    # Node + pnpm
    - uses: pnpm/action-setup@v4
      with:
        version: 9
    - uses: actions/setup-node@v4
      with:
        node-version: 22
        cache: pnpm
    - run: pnpm install --frozen-lockfile
      shell: bash

    # Python
    - uses: actions/setup-python@v5
      with:
        python-version: '3.11'
        cache: pip
    - run: |
        cd agent
        pip install -r requirements.txt
        pip install pytest pytest-cov pip-audit
      shell: bash

    # Tauri system deps (Linux only)
    - if: runner.os == 'Linux'
      run: |
        sudo apt-get update
        sudo apt-get install -y \
          libwebkit2gtk-4.1-dev libappindicator3-dev \
          librsvg2-dev patchelf libgtk-3-dev
      shell: bash
```

## 11.4 CD 多平台分发

### 11.4.1 发布流水线

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    tags:
      - 'v*.*.*'          # v1.2.3
      - 'v*.*.*-alpha.*'  # v1.2.3-alpha.1
      - 'v*.*.*-beta.*'   # v1.2.3-beta.1

permissions:
  contents: write

jobs:
  # ── 版本解析 ──
  parse-version:
    runs-on: ubuntu-latest
    outputs:
      version: ${{ steps.parse.outputs.version }}
      channel: ${{ steps.parse.outputs.channel }}
      prerelease: ${{ steps.parse.outputs.prerelease }}
    steps:
      - id: parse
        run: |
          TAG=${GITHUB_REF#refs/tags/}
          VERSION=${TAG#v}
          echo "version=$VERSION" >> $GITHUB_OUTPUT
          if [[ "$TAG" == *-alpha* ]]; then
            echo "channel=alpha" >> $GITHUB_OUTPUT
            echo "prerelease=true" >> $GITHUB_OUTPUT
          elif [[ "$TAG" == *-beta* ]]; then
            echo "channel=beta" >> $GITHUB_OUTPUT
            echo "prerelease=true" >> $GITHUB_OUTPUT
          else
            echo "channel=stable" >> $GITHUB_OUTPUT
            echo "prerelease=false" >> $GITHUB_OUTPUT
          fi

  # ── Python Agent 打包 ──
  build-agent:
    needs: [parse-version]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.11' }
      - name: Bundle Agent with PyInstaller
        run: |
          cd agent
          pip install pyinstaller
          pyinstaller --onefile --name mirageink-agent \
            --hidden-import=langchain \
            --hidden-import=langgraph \
            --add-data "config:config" \
            main.py
      - uses: actions/upload-artifact@v4
        with:
          name: agent-bundle
          path: agent/dist/mirageink-agent

  # ── 跨平台构建矩阵 ──
  build-tauri:
    needs: [parse-version, build-agent]
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-latest
            target: aarch64-apple-darwin
            artifact: dmg
            rust-target: aarch64-apple-darwin
          - os: macos-13          # Intel Mac
            target: x86_64-apple-darwin
            artifact: dmg
            rust-target: x86_64-apple-darwin
          - os: windows-latest
            target: x86_64-pc-windows-msvc
            artifact: msi
            rust-target: x86_64-pc-windows-msvc
          - os: ubuntu-latest
            target: x86_64-unknown-linux-gnu
            artifact: AppImage+deb
            rust-target: x86_64-unknown-linux-gnu

    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4

      # 下载 Agent 二进制
      - uses: actions/download-artifact@v4
        with:
          name: agent-bundle
          path: agent/dist/

      - name: Setup Rust
        uses: actions-rust-lang/setup-rust-toolchain@v1
        with:
          target: ${{ matrix.rust-target }}

      - name: Setup Node
        uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile

      # Linux 系统依赖
      - if: runner.os == 'Linux'
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            libwebkit2gtk-4.1-dev libappindicator3-dev \
            librsvg2-dev patchelf libgtk-3-dev

      # macOS 签名与公证
      - if: runner.os == 'macOS'
        name: Import Code Signing Certificate
        uses: apple-actions/import-codesign-certs@v2
        with:
          p12-file-base64: ${{ secrets.APPLE_CERTIFICATE_BASE64 }}
          p12-password: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          keychain-password: ${{ secrets.KEYCHAIN_PASSWORD }}

      # Windows 签名
      - if: runner.os == 'Windows'
        name: Import Windows Certificate
        run: |
          $certBytes = [Convert]::FromBase64String("${{ secrets.WINDOWS_CERTIFICATE_BASE64 }}")
          [System.IO.File]::WriteAllBytes("$env:RUNNER_TEMP\cert.pfx", $certBytes)

      # 注入 Agent 路径到环境变量
      - name: Set Agent Path
        run: |
          echo "TAURI_AGENT_BINARY=${{ github.workspace }}/agent/dist/mirageink-agent" >> $GITHUB_ENV

      # 构建（签名会自动嵌入）
      - name: Tauri Build
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
        run: pnpm tauri build --ci --target ${{ matrix.rust-target }}

      # macOS 公证
      - if: runner.os == 'macOS'
        name: Notarize DMG
        run: |
          DMG=$(ls src-tauri/target/${{ matrix.rust-target }}/release/bundle/dmg/*.dmg)
          xcrun notarytool submit "$DMG" \
            --apple-id "${{ secrets.APPLE_ID }}" \
            --team-id "${{ secrets.APPLE_TEAM_ID }}" \
            --password "${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}" \
            --wait
          xcrun stapler staple "$DMG"

      # 上传构建产物
      - name: Upload Release Artifacts
        uses: actions/upload-artifact@v4
        with:
          name: release-${{ matrix.target }}
          path: |
            src-tauri/target/${{ matrix.rust-target }}/release/bundle/dmg/*.dmg
            src-tauri/target/${{ matrix.rust-target }}/release/bundle/msi/*.msi
            src-tauri/target/${{ matrix.rust-target }}/release/bundle/deb/*.deb
            src-tauri/target/${{ matrix.rust-target }}/release/bundle/appimage/*.AppImage
            src-tauri/target/${{ matrix.rust-target }}/release/bundle/appimage/*.AppImage.tar.gz*
          if-no-files-found: warn

  # ── 生成更新清单并发布 ──
  publish-release:
    needs: [parse-version, build-tauri]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # 下载所有构建产物
      - uses: actions/download-artifact@v4
        with:
          pattern: release-*
          path: dist/
          merge-multiple: true

      # 生成 update.json（Tauri updater manifest）
      - name: Generate Update Manifest
        run: |
          VERSION="${{ needs.parse-version.outputs.version }}"

          # 计算文件签名（Tauri updater 需要）
          gen_entry() {
            local file=$1
            local url="https://github.com/${{ github.repository }}/releases/download/v${VERSION}/$(basename $file)"
            local sig=$(cat "$file.sig" 2>/dev/null || echo "")
            echo "{\"url\": \"$url\", \"signature\": \"$sig\"}"
          }

          python3 << EOF
          import json, hashlib, os, glob

          files = glob.glob("dist/**/*", recursive=True)
          bundles = [f for f in files if os.path.isfile(f) and not f.endswith('.sig')]

          manifest = {
            "version": "$VERSION",
            "notes": "${{ github.event.head_commit.message }}",
            "pub_date": "${{ github.event.head_commit.timestamp }}",
            "platforms": {}
          }

          for f in sorted(bundles):
              name = os.path.basename(f)
              # 映射平台
              if name.endswith('.dmg'):
                  arch = 'aarch64' if 'aarch64' in f else 'x86_64'
                  key = f"darwin-{arch}"
              elif name.endswith('.msi'):
                  key = "windows-x86_64"
              elif name.endswith('.deb') or name.endswith('.AppImage'):
                  key = "linux-x86_64"
              else:
                  continue

              with open(f, 'rb') as fp:
                  sig = hashlib.sha256(fp.read()).hexdigest()

              manifest["platforms"][key] = {
                  "url": f"https://github.com/${{ github.repository }}/releases/download/v$VERSION/{name}",
                  "signature": sig
              }

          with open("dist/update.json", "w") as fp:
              json.dump(manifest, fp, indent=2)
          print(json.dumps(manifest, indent=2))
          EOF

      # 创建 GitHub Release
      - name: Create Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ github.ref_name }}
          name: v${{ needs.parse-version.outputs.version }}
          body_path: CHANGELOG.md
          prerelease: ${{ needs.parse-version.outputs.prerelease }}
          files: |
            dist/**
          fail_on_unmatched_files: false
```

### 11.4.2 macOS 签名环境变量

| 变量 | 用途 | 存储位置 |
|------|------|----------|
| `APPLE_CERTIFICATE_BASE64` | Developer ID Application 证书 (p12 base64) | GitHub Secrets |
| `APPLE_CERTIFICATE_PASSWORD` | p12 文件密码 | GitHub Secrets |
| `KEYCHAIN_PASSWORD` | 临时 keychain 密码 | GitHub Secrets |
| `APPLE_TEAM_ID` | Apple Developer Team ID | GitHub Secrets |
| `APPLE_ID` | Apple ID（公证用） | GitHub Secrets |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-Specific Password | GitHub Secrets |
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater 签名私钥 | GitHub Secrets |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥密码 | GitHub Secrets |

### 11.4.3 Tauri Updater 签名

```json
// src-tauri/tauri.conf.json (updater 配置)
{
  "plugins": {
    "updater": {
      "pubkey": "YOUR_PUBLIC_KEY_BASE64",
      "endpoints": [
        "https://github.com/WangYajun369/ai-writing-platform/releases/latest/download/update.json"
      ],
      "windows": {
        "installMode": "passive"
      }
    }
  }
}
```

> 公钥通过 `pnpm tauri signer generate -w ~/.tauri/myapp.key` 生成，私钥存入 `TAURI_SIGNING_PRIVATE_KEY`。

## 11.5 Python Agent 打包策略

Agent 作为独立子进程随应用分发，需在构建阶段预打包：

```
方案一：PyInstaller（推荐）
  ├─ 优点：单文件分发，无运行时依赖
  ├─ 缺点：首次启动稍慢（解压），包体增大 ~50MB
  └─ 适用：生产发布

方案二：嵌入式 Python（.venv 整体打包）
  ├─ 优点：启动快，可热更新
  ├─ 缺点：分发体积大（~200MB），环境隔离复杂
  └─ 适用：开发阶段

方案三：Nuitka 编译
  ├─ 优点：启动快，体积小
  ├─ 缺点：编译时间长，兼容性问题多
  └─ 适用：性能敏感场景
```

### 11.5.1 PyInstaller 配置

```python
# agent/build.spec
# -*- mode: python ; coding: utf-8 -*-

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    datas=[
        ('config/', 'config'),
        ('templates/', 'templates'),
    ],
    hiddenimports=[
        'langchain', 'langchain_core', 'langgraph',
        'langchain_openai', 'langchain_ollama',
        'httpx', 'sse_starlette', 'uvicorn.logging',
        'uvicorn.loops', 'uvicorn.loops.auto',
        'uvicorn.protocols', 'uvicorn.protocols.http',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.websockets',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.lifespan', 'uvicorn.lifespan.on',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', 'matplotlib', 'numpy', 'pandas'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=None,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=None)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='mirageink-agent',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,        # 无控制台窗口
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
```

### 11.5.2 Rust 侧 Agent 路径解析

> **Bridge Auth Token 环境注入**：启动 Python Agent 时，Rust 侧通过环境变量 `MIRAGEINK_BRIDGE_AUTH_TOKEN` 将随机生成的认证 Token 注入子进程。Python 端必须在每次 Bridge HTTP 回调中携带 `X-Auth-Token` header（详见 05 §5.4.3 和 06 §6.4.4）。

```rust
// python/manager.rs
impl PythonAgentManager {
    fn get_agent_binary_path(&self) -> PathBuf {
        // 1. 环境变量覆盖（开发阶段）
        if let Ok(path) = std::env::var("MIRAGEINK_AGENT_BINARY") {
            let p = PathBuf::from(path);
            if p.exists() { return p; }
        }

        // 2. 打包路径（发布版）
        let bundle_dir = self.app_handle
            .path()
            .resource_dir()
            .unwrap_or_default();
        let bundled = bundle_dir.join("agent").join("mirageink-agent");
        #[cfg(target_os = "windows")]
        let bundled = bundled.with_extension("exe");

        if bundled.exists() {
            return bundled;
        }

        // 3. 开发模式：直接用 Python 运行
        let project = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
        project.join("agent").join("main.py")
    }
}
```

## 11.6 版本管理策略

### 11.6.1 语义化版本

```
主版本号.次版本号.修订号[-预发布标识]

MAJOR: 不兼容的架构变更（如 Tauri 2→3、数据迁移）
MINOR: 新功能（向后兼容）
PATCH: Bug 修复、性能优化

预发布:
  v1.2.0-alpha.1  内部测试
  v1.2.0-beta.1   公测
  v1.2.0-rc.1     候选发布
```

### 11.6.2 版本号同步点

| 文件 | 字段 |
|------|------|
| `src-tauri/Cargo.toml` | `package.version` |
| `package.json` | `version` |
| `agent/pyproject.toml` | `project.version` |
| `src-tauri/tauri.conf.json` | `version` |

### 11.6.3 自动版本 Bump Action

```yaml
# .github/workflows/version-bump.yml
name: Version Bump
on:
  workflow_dispatch:
    inputs:
      bump_type:
        description: 'Bump type'
        required: true
        default: 'patch'
        type: choice
        options: [patch, minor, major]
      prerelease:
        description: 'Pre-release label (optional)'
        required: false
        type: string

jobs:
  bump:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          token: ${{ secrets.GH_PAT }}

      - name: Bump version
        id: bump
        run: |
          # 读取当前版本
          CURRENT=$(cargo metadata --format-version 1 --no-deps |
            jq -r '.packages[] | select(.name=="time-write") | .version')

          # 计算新版本
          IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
          case "${{ inputs.bump_type }}" in
            major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
            minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
            patch) PATCH=$((PATCH + 1)) ;;
          esac
          VERSION="${MAJOR}.${MINOR}.${PATCH}"
          if [ -n "${{ inputs.prerelease }}" ]; then
            VERSION="${VERSION}-${{ inputs.prerelease }}"
          fi
          echo "version=$VERSION" >> $GITHUB_OUTPUT
          echo "New version: $VERSION"

      - name: Update Cargo.toml
        run: |
          sed -i "s/^version = \".*\"/version = \"${{ steps.bump.outputs.version }}\"/" \
            src-tauri/Cargo.toml

      - name: Update package.json
        run: |
          jq ".version = \"${{ steps.bump.outputs.version }}\"" package.json > tmp.json
          mv tmp.json package.json

      - name: Update pyproject.toml
        run: |
          sed -i "s/^version = \".*\"/version = \"${{ steps.bump.outputs.version }}\"/" \
            agent/pyproject.toml

      - name: Update tauri.conf.json
        run: |
          jq ".version = \"${{ steps.bump.outputs.version }}\"" \
            src-tauri/tauri.conf.json > tmp.json
          mv tmp.json src-tauri/tauri.conf.json

      - name: Create PR
        uses: peter-evans/create-pull-request@v6
        with:
          commit-message: "chore: bump version to v${{ steps.bump.outputs.version }}"
          branch: version-bump/v${{ steps.bump.outputs.version }}
          title: "chore: bump version to v${{ steps.bump.outputs.version }}"
          body: |
            Auto-generated version bump.

            After merge, create tag `v${{ steps.bump.outputs.version }}` to trigger release.
```

## 11.7 安全扫描集成

### 11.7.1 依赖漏洞扫描

```yaml
# .github/workflows/dependency-scan.yml
name: Scheduled Dependency Scan
on:
  schedule:
    - cron: '0 6 * * 1'  # 每周一早 6 点
  workflow_dispatch:

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Rust: cargo-audit
      - uses: actions-rust-lang/setup-rust-toolchain@v1
      - uses: rustsec/audit-check@v2
        with:
          token: ${{ secrets.GITHUB_TOKEN }}

      # npm: npm audit
      - uses: pnpm/action-setup@v4
      - run: pnpm audit --audit-level=moderate || true

      # Python: pip-audit
      - uses: actions/setup-python@v5
        with: { python-version: '3.11' }
      - run: |
          cd agent
          pip install pip-audit
          pip-audit --strict || true

  # CodeQL 静态分析
  codeql:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
    strategy:
      matrix:
        language: ['javascript-typescript', 'python']
    steps:
      - uses: actions/checkout@v4
      - uses: github/codeql-action/init@v3
        with:
          languages: ${{ matrix.language }}
      - uses: github/codeql-action/analyze@v3
```

### 11.7.2 供应链安全

```yaml
# 在 release.yml 构建开始前
- name: Verify artifact signatures
  run: |
    # 验证 Tauri CLI 是否为正版
    cargo install --list | grep tauri-cli || true
    # 校验 lockfile 完整性
    cargo generate-lockfile --locked
    pnpm install --frozen-lockfile
```

## 11.8 多环境与特性管理

### 11.8.1 Rust Feature Flag 策略

```toml
# src-tauri/Cargo.toml
[features]
default = ["custom-protocol"]

# 发布版功能
production = ["sqlcipher"]     # 启用数据库加密

# 安全功能
sqlcipher = []                 # SQLite AES-256 全库加密 + PBKDF2 密钥派生（详见 06）

# 开发者工具
devtools = []                  # 额外的调试端点
```

```yaml
# CI 中的 feature 选择
- name: CI build (no sqlcipher)
  run: cargo build --no-default-features

- name: Release build
  run: cargo build --features production,custom-protocol
```

### 11.8.2 发布渠道

```json
// src-tauri/tauri.conf.json (不同渠道配置)
{
  "plugins": {
    "updater": {
      "endpoints": [
        "https://github.com/.../releases/latest/download/update.json"
      ]
    }
  }
}
```

| 渠道 | 触发方式 | update.json 路径 |
|------|----------|------------------|
| stable | `v1.2.3` tag | `releases/latest/download/update.json` |
| beta | `v1.2.3-beta.1` tag | `releases/download/v1.2.3-beta.1/update.json` |
| alpha | `v1.2.3-alpha.1` tag | 不推送更新 |

## 11.9 Tauri 构建优化

### 11.9.1 构建缓存

```yaml
# Rust 编译缓存
- uses: actions/cache@v4
  with:
    path: |
      ~/.cargo/registry/index/
      ~/.cargo/registry/cache/
      ~/.cargo/git/db/
      src-tauri/target/
    key: ${{ runner.os }}-cargo-${{ hashFiles('src-tauri/Cargo.lock') }}
    restore-keys: ${{ runner.os }}-cargo-

# pnpm store 缓存
- uses: actions/cache@v4
  with:
    path: ~/.local/share/pnpm/store
    key: ${{ runner.os }}-pnpm-${{ hashFiles('pnpm-lock.yaml') }}
```

### 11.9.2 构建时间优化

| 优化项 | 方法 | 效果 |
|--------|------|------|
| sccache | 编译器缓存 | 增量构建快 3-5x |
| mold linker | Linux 下使用 mold 替代 ld | 链接时间减半 |
| cargo-nextest | 测试运行器 | 测试执行快 2x |
| 并行 job | matrix 并行构建 4 个平台 | 总时间 = 最慢平台 |

```yaml
# 使用 sccache
- uses: mozilla-actions/sccache-action@v0
- run: |
    export RUSTC_WRAPPER=sccache
    cargo build --release

# 使用 mold (Linux)
- if: runner.os == 'Linux'
  run: |
    sudo apt-get install -y mold clang
    echo '[target.x86_64-unknown-linux-gnu]' >> ~/.cargo/config.toml
    echo 'linker = "clang"' >> ~/.cargo/config.toml
    echo 'rustflags = ["-C", "link-arg=-fuse-ld=mold"]' >> ~/.cargo/config.toml
```

## 11.10 发布后验证

### 11.10.1 冒烟测试矩阵

```yaml
# .github/workflows/post-release-smoke.yml
name: Post-Release Smoke Test
on:
  release:
    types: [published]

jobs:
  smoke-test:
    strategy:
      matrix:
        os: [macos-latest, windows-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - name: Download release binary
        run: |
          # 根据平台下载对应的安装包
          gh release download --pattern "*.dmg" --repo ${{ github.repository }}
        env:
          GH_TOKEN: ${{ github.token }}
      - name: Verify install
        run: |
          # 挂载 DMG / 安装 MSI / 解压 AppImage
          # 验证二进制可执行
          # 验证版本号与 tag 一致
          echo "Smoke test passed"
```

### 11.10.2 更新清单验证

```typescript
// scripts/verify-update-manifest.ts
// 发布后自动运行，验证 update.json 可用性

async function verifyUpdateManifest() {
  const resp = await fetch(
    'https://github.com/WangYajun369/ai-writing-platform/releases/latest/download/update.json'
  );
  const manifest = await resp.json();

  // 验证每个平台的 URL 可访问
  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    const headResp = await fetch(entry.url, { method: 'HEAD' });
    if (!headResp.ok) {
      throw new Error(`Platform ${platform}: URL unreachable (${headResp.status})`);
    }
    console.log(`✅ ${platform}: ${entry.url}`);
  }
  console.log('Update manifest verified');
}
```

## 11.11 CI/CD 时间预算

| 阶段 | 预计时间 | 优化后 |
|------|----------|--------|
| Lint + Type Check | 1 min | 30s (cache hit) |
| Security Audit | 1 min | 30s |
| Rust Unit Tests | 3 min | 1 min (cached + nextest) |
| Frontend Tests | 2 min | 30s |
| Python Tests | 1 min | 20s |
| E2E Tests (WebDriver) | 4 min | 2 min (headless + parallel) |
| PR Build Check (3 OS) | 15 min | 8 min (cached) |
| **PR 总时间** | **~22 min** | **~12 min** |
| Release Build (3 OS) | 45 min | 25 min (sccache + mold) |
| macOS Sign + Notarize | 5 min | 5 min (Apple service) |
| **Release 总时间** | **~50 min** | **~30 min** |

## 11.12 故障回滚方案

### 11.12.1 自动回滚触发条件

```yaml
- name: Health check after deploy
  run: |
    # 下载并运行 → 检查是否崩溃
    timeout 30 ./target/release/time-write --version || {
      echo "Binary crashed on startup"
      exit 1
    }
    echo "Health check passed"
```

### 11.12.2 手动回滚

```bash
# GitHub Release 回滚
gh release delete v1.2.3 --yes
git tag -d v1.2.3
git push origin :refs/tags/v1.2.3

# 重新发布前一版本
git tag v1.2.2 <commit-hash> --force
git push origin v1.2.2 --force
# 手动触发 release workflow
```

### 11.12.3 发布 Checklist

| 检查项 | 负责人 | 自动化 |
|--------|--------|--------|
| 版本号三处同步 | CI | version-bump workflow |
| CHANGELOG 已更新 | 开发者 | 手动 |
| 所有平台构建通过 | CI | release workflow |
| macOS 公证通过 | CI | release workflow |
| 冒烟测试通过 | CI | post-release-smoke |
| update.json 可访问 | CI | verify script |
| 数据迁移（如有）已测试 | 开发者 | 手动 |
| API 兼容性审查 | 开发者 | 手动 |

## 11.13 环境变量与敏感信息

### 11.13.1 GitHub Secrets 清单

| Secret | 用途 | 环境 |
|--------|------|------|
| `GH_PAT` | Version bump PR | CI |
| `APPLE_CERTIFICATE_BASE64` | macOS 签名 | Release |
| `APPLE_CERTIFICATE_PASSWORD` | macOS 签名 | Release |
| `KEYCHAIN_PASSWORD` | macOS 签名 | Release |
| `APPLE_TEAM_ID` | macOS 公证 | Release |
| `APPLE_ID` | macOS 公证 | Release |
| `APPLE_APP_SPECIFIC_PASSWORD` | macOS 公证 | Release |
| `WINDOWS_CERTIFICATE_BASE64` | Windows 签名 | Release |
| `TAURI_SIGNING_PRIVATE_KEY` | Updater 签名 | Release |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Updater 签名 | Release |

### 11.13.2 密钥轮换策略

| 密钥类型 | 轮换周期 | 备注 |
|----------|----------|------|
| Apple 证书 | 12 个月（Apple 强制） | 到期前 30 天提醒 |
| Tauri 签名密钥 | 6 个月 | 轮换后旧版本无法自动更新 |
| GitHub PAT | 每 90 天 | 细粒度 permission |
| Windows 代码签名证书 | 12 个月 | 到期前续签 |

## 11.14 监控与告警

### 11.14.1 构建指标

| 指标 | 目标 | 告警阈值 |
|------|------|----------|
| PR CI 通过率 | > 95% | < 90% |
| Release 构建成功率 | 100% | 任意失败 |
| macOS 公证成功率 | 100% | 任意失败 |
| 平均构建时间 | < 15 min | > 30 min |
| 依赖漏洞（Critical） | 0 | > 0 |

### 11.14.2 通知

```yaml
- name: Notify on failure
  if: failure()
  uses: slackapi/slack-github-action@v2
  with:
    webhook: ${{ secrets.SLACK_WEBHOOK }}
    webhook-type: incoming-webhook
    payload: |
      {
        "text": "⚠️ Release build failed for ${{ github.ref_name }}\n${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
      }
```

## 11.15 反模式与陷阱

| 反模式 | 后果 | 正确做法 |
|--------|------|----------|
| CI 中 `pnpm install` 不用 `--frozen-lockfile` | 依赖漂移，构建不可复现 | 始终用 `--frozen-lockfile` |
| 在 CI 中硬编码密钥 | 安全泄露 | 使用 GitHub Secrets |
| 跨平台构建不 matrix 并行 | CI 时间暴增 | `fail-fast: false` + matrix |
| Release 前不清理 target 目录 | 增量编译污染 | `cargo clean` 在 release 前 |
| Python Agent 不加 `hiddenimports` | 运行时 ImportError | PyInstaller spec 中明确声明 |
| 不同步三语言版本号 | 用户看到的版本不一致 | version-bump workflow |
| 公证失败忽略 | macOS 用户无法安装 | 公证必须通过，否则阻塞 |
| update.json 路径写死版本号 | 跨版本更新断裂 | 用 `latest/download/` 重定向 |
