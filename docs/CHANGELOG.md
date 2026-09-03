# 更新日志

## v1.5.0 (2026-09-03)

### 新增
- **任务卡 · 项目管理模块**：书库首页右上角新增「任务卡」入口（home-header 插件扩展点，图标高亮 + 今日应办数角标），点击开/关 `TasksWindow` 独立窗口；支持从全局命令面板（Ctrl/⌘+Shift+P）打开窗口 / 直达今日 / 直达全部任务
  - **项目（Project）**：以项目为单位管理任务，可设名称 / emoji 图标 / 颜色 / 描述 / 计划起止日期，支持置顶、完成、归档、软删除（回收站）；项目卡片实时统计（总数 / 待办 / 进行中 / 已完成 / 逾期）
  - **项目详情看板/列表双视图**：三列（待办 / 进行中 / 完成）+ 跨列拖拽改状态（@dnd-kit）、同列手动排序；列表视图聚焦批量勾选；关键词 / 优先级 / 标签 / 截止（今天·本周·已逾期）筛选；逾期任务红色角标强调
  - **任务（Task）**：标题 + 富文本描述（HTML）、优先级、计划开始 / 截止时间、计划今日、标签多选、子任务清单（勾选联动进度）、附件（本地文件，可打开）、个人备注（纯文本 / 富文本）、重复规则（每天 / 每周指定日 / 每月 / 每 N 间隔 + 结束日期，P2）、任务级提醒（截止前一天 / 当天 / 逾期 / 自定义时间）、完成总结（TipTap 富文本，可跳过，重新打开保留）
  - **今日视图**：按「逾期（红）/ 进行中 / 今日截止 / 计划今日 / 今日已完成（折叠）」分区，顶部今日完成率进度条 + 快速添加；卡片可「顺延到明天」（保留原时刻）；「计划今日」跨自然日自动滚动清理（`task_roll_planned_today`）
  - **全部任务视图**：全局搜索（标题 / 备注 / 描述 / 标签 / 项目名命中高亮）+ 状态 / 标签 / 优先级 / 截止范围筛选 + 多策略排序
  - **标签管理**：新增 / 改名 / 换色 / 启停 / 删除（解除关联）；任务可多标签
  - **任务模板**：预设标题 / 描述 / 优先级 / 备注 / 标签 / 子任务清单 / 截止日偏移，一键套用建任务（P2）
  - **操作日志与周报**：任务 / 项目操作（创建 / 完成 / 重新打开 / 更新 / 删除 / 恢复 / 子任务 / 附件等）写入 `task_activity_logs`，任务详情内时间线展示（P2）；项目周报基于日志生成近 8 周「新增 / 完成」双柱图与动态
  - **提醒中心**：系统通知（`tauri-plugin-notification`）+ 窗口内铃铛中心（未读角标、可直达任务）；提醒偏好可配截止前一天 / 当天 / 逾期每日 09:00 与每日待办提醒
  - **日程迁移**：任务卡窗口「设置 → 日程迁移」把旧「个人日程」（`schedules` 表）一键迁移为项目「日程迁移」下的任务（幂等，`migrate_schedules` 命令）
- **「看日记」独立窗口化**：由书库首页内的书页弹窗升级为 `DiaryBookPage` 独立窗口（diary-book），按月分章、左右对页翻书、顶栏年月直达，与主窗口并行使用不被遮挡
- **第二个内置插件**：`plugins/bootstrap.ts` 新增注册「任务卡」插件（`plugins/taskCards/`），与「英语字典」并列，插件系统落地两个 home-header 入口

### 优化
- **日记面板数据源切换**：首页右侧由「日记 + 个人日程」改为「日记 + 当日任务」，日历状态点与当日任务列表改为任务卡数据驱动（逾期红 / 今日绿 / 未来蓝 / 已完成灰），跨窗口数据变更经 `tasks-data-updated` 事件实时同步
- **ScheduleManager 退役**：旧「个人日程」UI（添加 / 勾选 / 双击编辑）移除，由任务卡的「当日任务」区替代（轻量勾选完成 + 跳转任务卡窗口做完整操作）

### 工程
- Rust：新增 `commands/{project,task,tag,task_meta,subtask,attachment,activity,template,reminder,migrate}.rs` 10 个命令文件共 55 条命令，`repository/` 与 `service/` 对应新增 8 / 11 个文件（含 `reminder_service.rs` 到期扫描与 `project_stats_service.rs` 周报统计）；`window/manager.rs` 新增任务卡窗口（open/close/is）与看日记窗口（open/close）5 条命令
- IPC：总命令数 109 → **169**；`tauri-bridge` 新增 `taskCardApi`（共 17 个 API 对象）
- 数据表：新增 `projects`、`tasks`、`tags`、`task_tags`、`task_meta`、`task_subtasks`、`attachments`、`task_activity_logs`、`task_templates`、`project_milestones` 10 张表（`schedules` 表保留用于历史数据迁移）
- 前端：新增 `stores/taskCardsStore.ts`（Zustand，窗口内使用 + 变更广播）、`lib/taskCardsTime.ts` / `taskCardsMeta.ts` / `recurrence.ts` / `subtaskGuard.ts` 工具、`components/taskCards/` 19 个组件文件、`components/diary/DayTasksPanel.tsx`；`windowDetection.ts` 新增 `taskswin` / `diarybookwin` 路由

## v1.4.0 (2026-09-03)

### 新增
- **英语字典·生词本模块**：书库首页右上角新增「英语字典」入口（玫红主题，基于首页头部插件扩展点 `HomeHeaderPlugins`）；`VocabularyWindow` 独立悬浮窗口内置「生词本 / 复习 / 统计」页签，支持添加生词（在线释义查询）、单词详情（音标/例句/读音）、间隔重复式分组复习与掌握度统计；后端新增 `vocab.rs`、`vocab_dict.rs` 命令与 `vocab_repo.rs` / `vocab_service.rs`（词库、生词簿 CRUD、复习计划与统计聚合）
- **TTS 朗读**：新增 `tts-player.ts`（Web Speech 封装）与后端 `tts.rs` 命令，生词与复习场景一键朗读，语速/语音可配置（`ttsConfig` store 持久化）
- **首页插件宿主**：新增 `PluginHost` 与 `plugins/bootstrap.ts` 插件注册引导（含 vite 配置扩展、插件类型声明），首个内置插件为英语字典，独立窗口状态经 Jotai 跨窗口同步

### 优化
- **「看日记」留白页改版**：月份开篇/收尾的空白对开页改为素雅「纸张扉页」——纸张质感明暗渐变、内框细线、圆环羽毛笔装饰，居中显示中文年月大字；左侧空白页语「新 的 一 月」、右侧「本 月 终 章」
- **顶栏按钮提示清理**：移除「AI 工具箱」（书库首页）与「AI 助手」（编辑器顶栏）按钮右上角的呼吸小圆点，`GradientButton` 新增 `showDot` 开关按需控制

### 工程
- Rust：新增 `commands/tts.rs`、`commands/vocab.rs`、`commands/vocab_dict.rs` 与 `repository/vocab_repo.rs`、`service/vocab_service.rs`，`models/mod.rs` 与 `db/mod.rs` 注册生词相关数据表，`window/manager.rs` / `lib.rs` / `commands/mod.rs` 完成窗口与命令接线
- IPC：`tauri-bridge` 新增 `vocabApi` / `ttsApi` 等桥接；前端新增 `vocabStore` / `ttsConfig` store、`components/vocabulary/` 组件目录与生词数据工具

## v1.3.0 (2026-09-02)

### 新增
- **日记与个人日程模块**：书库首页右侧新增「日记」面板 —— 按月日历 + 当日日记卡片 + 当日个人日程联动；日历上日期上方圆点标示已写日记、下方圆点按颜色区分日程状态（逾期红 / 今天绿 / 未来蓝 / 已完成灰）；新增 `DiaryDialog`（TipTap 富文本：标题、颜色、表格、图片、代码块、任务清单，实时字数 + 高频关键字自动提取）、`ScheduleManager`（添加 / 勾选完成 / 双击编辑 / 删除 / 完成进度）
- **日记自动保存**：300ms 防抖落盘，Esc / Ctrl+S 立即保存，关闭前兜底落盘；内容清空自动删除该日记录，删除需二次确认（误触自动复原）
- **「看日记」书页式浏览**：右上角入口由「今日日记」改为「看日记」（铅笔图标保留写今日快捷）；`DiaryBookDialog` 书页式弹窗一次展开左右两页（左旧右新），只有写过日记的日子占页、自动跳过无日记日期，打开即定位最近日记，支持左右箭头与 ← → 方向键整组翻页，仅展示只读；跨月浏览基于新增 `list_all_diaries` 命令 + 相邻页预取

### 工程
- 数据表：新增 `diaries`（每天至多一篇，`diary_date` 唯一）、`schedules`（某天多条）
- IPC：新增 `commands/diary.rs`（5 个）与 `commands/schedule.rs`（4 个）共 9 条命令，总命令数 81 → 90；前端新增 `diaryApi` / `scheduleApi` 桥接模块（tauri-bridge 共 13 个 API 对象）

## v1.2.0 (2026-09-02)

### 优化
- **Agent 引擎全面迁移为 Rust 原生实现**：移除 Python FastAPI 子进程服务（`agent/` 服务端 24 个文件）与 Rust HTTP Bridge（`tiny_http`，端口 9876/9877 双进程架构），新增 `engine.rs`（SSE 流式 ReAct 工具循环 + 任务取消）、`prompts.rs`（4 大技能 Prompt 内置 Rust）、`tools.rs`（6 个数据库工具）；应用启动不再依赖外部 Python 环境，免除 uvicorn/解释器自检与端口看门狗
- **记忆库并入主数据库**：新增 `memories` 表（支持书级/技能级记忆的增删改查、关键词提取、语义召回），旧 `agent_memory.db` 存量记忆在应用启动时自动幂等迁移至 `time_write.db`
- **前端 Agent 交互精简**：移除 `AgentPanel` 启停面板与 `EmbeddingStatus` 索引状态组件，Agent 恒为就绪（无外部进程启停按钮），设置页 RAG 配置/系统检查同步为内置引擎检测
- **工程与文档同步**：删除 `setup-agent` / `check-python-versions` 等 Python 运维脚本与 `pyrightconfig.json`，`check.mjs` 新增 Rust Agent 模块检查与 Python 迁移防回归断言及 `--fast` 模式；docs / release.yml / README 全量更新为 Rust 原生架构说明

## v1.1.0 (2026-09-02)

### 优化
- **Agent Python 后端类型标注全面强化**：新增 `pyrightconfig.json` strict 检查配置（venv 指向 `agent/.venv`），`.vscode/settings.json` 解释器由 conda 切换为项目 venv
- **API 与生命周期现代化**：`main.py` 由废弃的 `on_event(shutdown)` 重构为 FastAPI lifespan 上下文管理器；`server/routes.py` 请求/响应模型补全泛型标注，嵌套路由函数加 pyright ignore 说明
- **类型安全修复**：`tracer.py` 修复 `@trace` 无括号用法与 `functools.wraps` 绑定，async 包装 cast 收窄为 Callable 契约；`memory/store.py` 提取 `_row_to_memory` 收窄 `sqlite3.Row` 索引类型并补 `ClassVar`/lastrowid 空值防护；`summarizer.py` 改用 isinstance 收窄类型判断
- **LangChain 新 API 迁移**：`skills/engine.py` 的 `create_react_agent` 切换为 langchain `create_agent` 新 API，当前时间改为 timezone 感知；`tools/db_tools.py` 用 pydantic v2 `model_validate` 替换解包构造
- **导出规范化**：`agent/__init__.py` 及各子包新增 `__all__` 与模块 docstring，统一包级导出

## v1.0.2 (2026-09-01)

### 修复
- 修复编辑器销毁后应用崩溃：TipTap `destroy()` 将 `commandManager` 置为 null，StrictMode 下残留实例调用 `can()` 抛异常；新增 `src/lib/editor-guard.ts`（`isEditorUsable`）统一校验，`EditorToolbar` / `RichTextEditor` / `TablePopover` / `MessageBubble` 全部调用点改为安全引用，图片插入/裁剪等异步回调在 await 后重新校验编辑器可用性

### 优化
- `clean` 脚本新增清理 Python 缓存（`__pycache__` / `.pyc` / `.mypy_cache`），`Cargo.lock` 版本同步至 1.0.2

## v1.0.1 (2026-09-01)

### 新增
- **表格合并/拆分单元格**：新增 `table-utils.ts`（`canMergeCells` / `hasSplittableCell` 检测）与 `TablePopover` 合并/拆分操作区，按选区可用性自动禁用按钮
- **标题按钮合并为下拉菜单**：新增 `HeadingSelect` 组件，一级~四级标题统一为下拉选择，菜单项以字号体现层级，Portal 渲染避免被裁剪

### 修复
- 修复窗口缩窄时头部布局变形：顶栏设置最小宽度 `min-w-240`，各按钮与文字 `shrink-0`，窗口最小宽度 800 → 960
- 修复表格列宽调整把手不可用：`th/td` 增加 `position: relative`，修复 `column-resize-handle` 定位错乱，优化拖拽反馈
- 修复工具栏弹窗与提示被 overflow 容器裁剪遮挡：新增 `useAnchorPosition` 锚点定位 hook，Tooltip / 表格 / 颜色 / 代码语言弹窗统一 Portal 化

### 优化
- 首页移除列表视图，仅保留网格模式（`LibraryPage` / `BookCard` 删除 viewMode 分支）
- 适配 Tailwind CSS v4 类名规范：`bg-gradient-to-*` → `bg-linear-to-*`、`flex-shrink-0` → `shrink-0`、`z-[60]` → `z-60`，base.css 增加 `@reference` 声明
- 删除 `tmp/` 历史架构草案文档（RTK/MVVM 旧设想已被 `docs/` 权威文档取代）
- 宣传页同步 v1.0.0 并新增 Agent 智能体展示

## v1.0.0 (2026-08-31)

> 里程碑版本：引入 Python Agent 自动化写作子系统，架构升级为三进程模型；同步完成首轮安全加固（关闭 5 项 P0/P1 安全问题，详见 [优化报告](meta/optimization-report) 问题 7-11）。

### 新增 — Python Agent 子系统
- **Python Agent 服务**：FastAPI + LangGraph ReAct，端口 9877，由 Rust `python/manager.rs` 全生命周期管理
- **4 大写作技能（Skill）**：写作辅助 `writing` / 内容分析 `analysis` / 研究辅助 `research` / 润色优化 `polish`
- **6 个数据库工具链**：`read_chapter`、`read_chapter_summary`、`read_chapter_chunk`、`list_book_chapters`、`search_world_cards`、`get_book_context`
- **Rust 数据桥接（Bridge）**：`python/bridge.rs` 启动 tiny_http 服务（端口 9876），Agent 反向回调读取 SQLite，确保写操作唯一入口仍在 Rust
- **Agent 记忆体系统**：三层记忆（偏好 `preference` / 决策 `decision` / 经验 `lesson`），SQLite 持久化（`data/agent_memory.db`），关键词匹配 + 类型加权 + 时间衰减检索，Token 预算 600
- **双模型路由**：本地 Ollama（`qwen2.5:7b`，处理润色）+ 云端 DeepSeek（处理写作/分析/研究），按任务复杂度自动分配
- **对话历史压缩**：超过 6 轮自动触发本地模型压缩，保留最近 4 轮完整对话
- **前端 Agent 面板**：`components/agent/`（AgentPanel / AgentMessageBubble / AgentMemoryPanel / useAgent），Skill 选择器 + 流式输出 + 记忆管理
- **Agent IPC 命令 9 个**：`get_agent_status`、`start_agent`、`stop_agent`、`execute_agent_skill`、`cancel_agent_skill`、`list_agent_memories`、`update_agent_memory`、`delete_agent_memory`、`clear_agent_memories`

### 新增 — 基础设施
- `commands/system_check.rs` + `system_check` 命令：运行环境自检
- `src-tauri/src/logging.rs`：独立日志模块
- `service/`（6 个业务服务）与 `repository/`（6 个数据仓库）严格分层，事务边界与 SQL 审计日志 `emit_sql_log`
- FTS5 虚拟表 `world_cards_fts`，INSERT/UPDATE/DELETE 三触发器自动同步
- `AppError` 统一错误枚举（10 种变体），实现 `Serialize` 可直接作为 Tauri 命令 Err 返回

### 优化
- `commands/ai.rs` 拆分为 `ai/{chat,embedding,summarize,test}.rs` 四个子模块
- `commands/io`、`commands/window`、`commands/agent` 同步子模块化
- 前端 store 由单一 `appStore` 重构为 slice 模式：`booksSlice` / `aiSlice` / `preferencesSlice` / `pluginStore`

### 安全
- **Updater 签名**：生成 minisign 签名密钥对，`tauri.conf.json` 配置真实 `pubkey`（私钥 `~/.tauri/timewrite.key`；发布 CI 需配置 `TAURI_PRIVATE_KEY` / `TAURI_PRIVATE_KEY_PASSWORD` 两个 Secret）
- **CSP 收紧**：`img-src` 移除 `https:` 通配；`connect-src` 按实际需要仅放行 `https://api.github.com`；新增 `base-uri 'self'` / `form-action 'self'` / `frame-ancestors 'self'`
- **fs 权限作用域**：`capabilities/default.json` 的 12 项 fs 权限限定 `$APPDATA/**`、`$RESOURCE/**`；`assetProtocol.scope` 同步收窄；移除前端未使用的过宽 `http:allow-fetch`（`https://**`）
- **`withGlobalTauri`** 设为 `false`（前端零使用 `window.__TAURI__`）
- **备份加密密钥去硬编码**：环境变量 `TIMEWRITE_BACKUP_KEY` 优先（SHA-256 派生），否则使用 `<app_data_dir>/backup.key` 随机密钥（Unix 权限 0600）

### 已知问题（延续）
- Bridge Server（9876）无鉴权（问题 27）
- `/skills/cancel` 为占位实现，无法真正中断任务（问题 28）

### 已修复的已知问题
> 以下问题已在本版本安全加固中修复。
- updater `pubkey` 占位符 → 已配置真实签名公钥，更新签名校验启用
- `withGlobalTauri: true` → 已设为 `false`
- 加密备份硬编码密钥 → 已替换为 `TIMEWRITE_BACKUP_KEY` / `backup.key` 动态密钥

## v0.9.4 (2026-06-11)

### 新增
- 新增 ImageCropperDialog 图片裁剪对话框，支持拖拽选区精确裁剪并替换编辑器图片
- 新增 ImageViewerDialog 图片查看器对话框，支持放大/缩小/拖拽查看高清原图
- 新增 image-utils.ts 图片处理工具模块，封装裁剪、压缩与 Base64 编码能力
- 后端新增 process_image_cropped 命令，支持前端传入裁剪参数直接处理图片
- 后端新增 set_book_cover_data 命令，支持前端直传 Base64 data URL 作为封面，略过后端重复解码

### 优化
- 后端 process_image 重构，拆分为 validate_source + encode_image 独立函数，新增 crop_and_encode 裁剪编码函数
- EditorToolbar 新增图片查看和裁剪快捷按钮入口
- ImageResizeNodeView 图片节点增强交互体验
- BookCard/CoverPicker/EditBookDialog/NewBookDialog 全面适配封面直传功能
- tauri-bridge.ts 新增 setBookCoverData 和 processImageCropped API 函数

## v0.9.3 (2026-06-11)

### 优化
- 统一使用 TooltipWrap 组件替代原生 title 属性，提升提示交互一致性和可定制性
- LibraryPage 新增 AI 工具箱快捷入口，方便快速访问 AI 辅助写作功能

## v0.9.2 (2026-06-11)

### 修复
- StatusBar 全书字数改用 Zustand book store 作为主数据源，确保删除/恢复章节时立即更新，Jotai atom 作为打字实时估算回退

## v0.9.1 (2026-06-11)

### 优化
- 大纲面板(OutlinePanel)模块化拆分：抽取 DraggableChapter/DraggableVolume/OutlineDialogs/OutlineDragDrop/OutlineRecycleBin 子组件及 types/utils 工具模块
- 后端 delete_chapter/hard_delete_chapter 增强返回全书字数，RestoreChapterResult 增加 bookWordCount 字段
- 数据库连接健壮性增强：每个连接启用 PRAGMA foreign_keys=ON 和 journal_mode=WAL
- 章节删除/恢复 API 前端适配（tauri-bridge 返回类型更新，BookCard/TrashModal 适配）
- 新增 clean.ts 清理脚本，check.mjs 检测脚本优化

## v0.9.0 (2026-06-11)

### 新增
- 新增调试面板(DebugPanel)及调试控制台，增强窗口管理命令（debug/dump/validate）

### 优化
- 架构重构：引入 Repository/Service 分层，拆分单例模块（ai/io/window 拆为子模块）
- 移除 TrailingNodeExtension，优化编辑器和大纲/世界观面板

## v0.8.3 (2026-06-10)

### 新增
- 新增图片处理模块（Rust 侧 process_image 命令），支持格式校验、等比缩放、JPEG 编码和 Base64 输出
- 新增前端 image-utils.ts，封装编辑器图片（1200px/80%）和封面图片（800px/85%）的压缩处理
- 编辑器图片和封面图片统一采用 data: URL 内嵌方案，确保导出/导入完全自包含

## v0.8.2 (2026-06-10)

### 优化
- 封面图片从 Blob URL 切换为 data URL（base64），与编辑器内嵌图片方案保持一致，避免跨平台协议兼容性问题
- 移除 BookCard 和 TrashModal 中手动释放 Blob URL 的逻辑，简化内存管理

## v0.8.1 (2026-06-10)

### 新增
- 书籍封面支持移除：set_book_cover 传入空路径时清除封面
- 回收站支持封面图片预览显示，使用 Blob URL 渲染并自动回收

### 优化
- 图片编码方式重构：从逐字符 base64 拼接改为 Blob + FileReader 方案，避免大文件 O(n²) 性能问题
- CSP 安全策略 img-src 新增 blob: 来源，适应 Blob URL 图片渲染

## v0.8.0 (2026-06-10)

### 新增
- 数据备份导入导出功能：支持作品数据完整备份与恢复
- AI侧面板支持点击检测连接状态，提升连接诊断体验
- 左侧目录/大纲面板支持拖拽调整面板宽度
- Markdown 转 HTML 工具函数及消息插入编辑器防重复逻辑
- AI 对话前置校验 + 章节总结缓存 + 世界观面板总结管理
- AI 对话滑动窗口上下文管理，优化长对话性能
- 作品大纲与章节大纲功能
- AI Embedding 截断保护 + 错误提示优化 + 网络重试支持
- Node.js 版本管理工具，升级核心依赖至最新版本

### 优化
- 流式响应增加 RAF 节流，优化自动滚动和组件渲染性能
- AI面板拖拽重构为比例模式，支持窗口自适应缩放
- 独立窗口开关状态从 useState 提升为 Jotai 共享原子

## v0.7.1 (2026-06-10)

### 修复
- SnapshotPanel: 移除未使用变量 `currentBookId` 和 `result`，修复 TypeScript 编译错误（TS6133）

## v0.7.0 (2026-06-10)

### 新增
- 通用 ContextMenu 组件：新增右键菜单系统，支持全局上下文操作
- AI 请求详情面板：新增 RequestDetailModal 组件，支持查看 AI 请求详情与消息删除
- AI 工具箱面板：新增 AiToolboxPanel，集成章末总结/续写/扩写等 AI 写作辅助工具
- 章节摘要头部：新增 ChapterSummaryHeader 组件，展示章节摘要信息
- AI 对话增强：新增 MessageBubble、useAiChat hook，重构 AiSidePanel 对话流程
- 回收站管理：新增 TrashModal 组件，支持软删除数据的恢复与永久删除
- 设置页面全面重构：新增独立配置组件（外观/编辑器/存储/AI/RAG/聊天/工具箱/版本），实现模块化设置管理
- 版本信息展示：新增 VersionSection，运行时动态展示应用版本与更新信息
- AI 服务商预设：新增 ChatConfigSection 和 RAGConfigSection，预设常用模型配置

### 优化
- 拆分 SettingsPage 为独立配置组件，提取 useResizeHandle 通用 hook
- 重构快照面板布局与窗口管理，优化编辑器工具栏交互
- 书籍管理增强：BookCard 右键菜单支持编辑/删除，EditBookDialog 和 NewBookDialog 功能完善
- AI 后端命令增强：ai.rs 扩展多项 IPC 命令，支持工具箱 API 调用
- Tauri 窗口管理扩展：window.rs 新增辅助窗口创建与管理能力
- 状态管理扩展：appStore 新增回收站、AI 配置、章节摘要等状态字段

## v0.6.0 (2026-06-09)

### 新增
- ErrorBoundary 组件：新增全局错误边界，捕获渲染异常并展示友好提示，提升应用稳定性

### 优化
- 升级 Tiptap 编辑器至 v3：RichTextEditor、EditorToolbar 适配新 API，编辑器性能更优
- 迁移 Tailwind CSS v3 到 v4：移除 tailwind.config.ts，采用 CSS-first 配置，优化构建性能
- 重构存储层：appStore 状态管理全面重构，优化渲染性能，涉及 App.tsx、EditorPage、LibraryPage、AiSidePanel 等多处适配
- 核心依赖版本大升级：更新 Rust/Node 依赖至最新版本，移除废弃依赖
- 样式增强：globals.css 扩展动画与基础样式，提升 UI 细节

## v0.5.0 (2026-06-09)

### 新增
- 编辑器工具栏大幅增强：新增字体颜色选择、标题层级、列表、代码块、任务列表等格式化按钮
- TrailingNodeExtension：新增尾部节点扩展，确保编辑器末尾始终可编辑
- 大纲面板全面重构：支持卷/章节拖拽排序、软删除、插入指示器动画，交互体验大幅提升
- 编辑位置记忆与恢复：滚动位置和光标位置自动保存，切换章节后恢复上次编辑位置
- 版本检查工具：新增 Rust 依赖版本检测（check-rust-versions.ts）和项目完整性检测（check-versions.ts）脚本

### 修复
- 修复卷/章节排序逻辑在拖拽场景下的边界问题
- 修复章节移动到不同卷时的状态同步问题

### 优化
- 文档全面更新：所有用户指南和架构文档同步至 v0.4.0 代码现状
- 章节命令模块重构：新增 chapter.rs 独立命令文件，支持章节排序和卷迁移
- 卷操作支持软删除（deletedAt 字段），保留历史数据可恢复
- 全局样式增强：新增 pop-in、pulse-indicator 动画，编辑器 UI 细节打磨
- 编辑器状态管理扩展：saveEditorState 方法支持滚动/光标位置持久化

## v0.4.0 (2026-06-08)

### 新增
- DeepSeek 对话支持：新增 DeepSeek 服务商选项，支持思考模式（thinking），对话 API Key 按服务商独立管理
- AI 配置解耦：对话（AiChatConfig）与 RAG/Embedding（RagConfig）配置完全分离，各自独立管理 API Key 和模型
- 编辑器字体颜色选择：工具栏新增字体颜色按钮，支持预设色板和自定义颜色
- 作品信息编辑：新增 EditBookDialog 组件，支持编辑书名、封面、简介等作品元信息
- 产品宣传页：新增 product/ 目录宣传页面，含微信分享合规信息，支持 GitHub Pages 自动部署
- README 重构为 Wiki 导航，新增赞助与联系方式

### 修复
- 修复外观设置持久化缺失：gridSize/editorWidth 分别独立保存，避免覆盖丢失
- 修复 DeepSeek API 路径拼接：自动补全 /chat/completions 后缀
- 修复 GitHub Wiki 子目录展平问题，增强部署流程稳健性

### 优化
- SettingsPage 重构：新增 RAG 独立配置区，支持连通性测试（test_rag_connection 命令）
- AI 架构重构：新增 RagConfig/AiChatConfig 分离类型，getChatApiKey/getRagApiKey 工具函数
- 文档结构重组为 GitHub Wiki，配置 CI 自动部署
- 添加 GitHub Issue 模板（Bug 报告 & 功能请求）及集成总览文档
- Vite 构建优化：dependabot 依赖分组，chunk 名称更新（react-markdown/remark-gfm）

## v0.3.0 (2026-06-08)

### 新增
- 图片插入：通过 Tauri 原生文件对话框选择本地图片直接插入编辑器
- 图片缩放：新增 ResizableImage 扩展，支持拖拽控制点和工具栏调整图片尺寸
- 任务列表：新增 TaskList/TaskItem 扩展，支持复选框任务清单
- 编辑器工具栏增强：新增标题、无序列表、有序列表、任务列表、代码块等格式化按钮

### 优化
- 编辑器实例通过 Jotai atom 共享至工具栏，实现跨组件联动
- 代码块样式重构：自定义字体、圆角、暗色模式适配
- 新增 MIT License 开源许可证

## v0.2.5 (2026-06-08)

### 优化
- 优化 macOS 构建签名流程：增加 keychain 签名身份验证步骤

## v0.2.4 (2026-06-07)

### 优化
- 修复 GitHub Actions 条件引用方式
- 优化 Apple 代码签名流程
- 修复 macOS 公证步骤

## v0.2.3 (2026-06-07)

### 优化
- 精简 AI 服务商为智谱 BigModel + 自定义
- SSE 流处理代码重构
- 应用版本号改为运行时动态获取
- 默认 AI 配置改为智谱 BigModel

## v0.2.2 (2026-06-07)

### 优化
- 项目全面重命名：MirageInk → TimeWrite（智写时光）
- 图标资源重新生成

## v0.2.1 (2026-06-07)

### 优化
- 更新 version-release 技能配置
- 同步 Cargo.lock 依赖版本号

## v0.2.0 (2026-06-07)

### 新增
- RAG 语义检索
- AI 侧边栏重构
- 网格尺寸设置（small/medium/large）
- 编辑器宽度设置（mobile/standard/wide）
- 全局 CSS 样式系统

### 优化
- 移除打字机模式
- 更新依赖至最新版本

## v0.1.0 (2026-06-03)

### 新增
- 工程骨架搭建：Tauri v2 + React 18 + TypeScript + Vite 8 + TailwindCSS
- 书库管理：多作品网格/列表视图、虚拟化滚动
- TipTap 富文本编辑器：完整格式化支持
- 卷-章节两级目录树
- SQLite 数据持久化：6 张表、WAL 模式
- IPC 命令封装：7 个 API 模块
- 双层状态管理：Zustand + Jotai
- 双保险自动保存
- 专注模式
- 世界观资料库：6 种卡片类型
- AI 助手：流式对话 + RAG 检索
- 版本快照
- 导入导出：TXT/MD/HTML
- 主题系统：4 套主题
- 全局字体切换 + 字号自定义
- 插件系统框架
- 完整性检测脚本
