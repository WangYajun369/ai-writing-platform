# 快速开始

## 环境要求

| 依赖 | 版本要求 |
|------|---------|
| Node.js | ≥ 20 |
| pnpm | ≥ 9 |
| Rust | 最新稳定版（Tauri 编译需要） |

## 安装与启动

```bash
# 克隆仓库
git clone git@github.com:WangYajun369/ai-writing-platform.git
cd ai-writing-platform

# 安装依赖
pnpm install

# 启动开发模式（首次会编译 Rust，需要数分钟）
pnpm tauri dev

# 仅启动前端 Vite 预览
pnpm dev
```

## 构建发布包

```bash
pnpm tauri build
```

打包目标：
- **macOS**：DMG 安装包（Apple Silicon）
- **Windows**：NSIS 安装包

## 界面概览

TimeWrite 采用三页面架构：

| 页面 | 路由 | 功能 |
|------|------|------|
| **书库** | `/` | 管理所有作品、搜索排序、创建新作品 |
| **编辑器** | `/editor/:bookId` | 三栏布局（目录树/编辑器/右侧面板） |
| **设置** | `/settings` | AI 配置、外观、编辑、存储设置 |

编辑器采用三栏布局：
- **左侧**：卷-章节目录树
- **中间**：TipTap 富文本编辑器
- **右侧**：AI 助手 / 版本历史 / 世界观面板（可切换）

## 基本写作流程

1. 在**书库**页面点击「新建作品」，填写书名和作者
2. 进入**编辑器**，在目录树中创建卷和章节
3. 使用 TipTap 富文本编辑器撰写内容
4. 随时使用 **AI 助手**获取创作建议
5. 利用**专注模式**沉浸式写作
6. 自动保存保障数据安全（300ms 防抖 + 3 分钟定时）

## 运行检测

```bash
pnpm check
```

该命令运行完整性检测脚本，确保项目文件结构完整。
