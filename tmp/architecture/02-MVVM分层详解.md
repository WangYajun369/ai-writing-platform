# 02 — MVVM 分层详解

## 2.1 总体映射

MirageInk 的 MVVM 不是传统的单进程 MVVM，而是**跨语言、跨进程的 MVVM 变体**：

```
┌─────────────────────────────────────────────────┐
│                    MVVM Layers                   │
│                                                 │
│  View ──────── React Components (views/)        │
│    │  bind                                       │
│  ViewModel ── RTK Slice + Selector + Hook       │
│    │  invoke / listen                            │
│  Model ─────── Rust Domain Structs               │
│    │                                             │
│  ───────────── 进程边界 ─────────────            │
│    │                                             │
│  DAL ───────── SQLite (rusqlite)                 │
└─────────────────────────────────────────────────┘
```

## 2.2 前端 MVVM 实现

### 2.2.1 View 层 (`views/`)

纯展示组件，不持有业务状态：

```typescript
// views/ArticleEditor.tsx
export const ArticleEditor: React.FC = () => {
  // 通过 ViewModel Hook 获取状态
  const { article, isDirty, updateContent, save } = useArticleEditorVM();

  return (
    <EditorPane
      content={article.content}
      isDirty={isDirty}
      onChange={updateContent}
      onSave={save}
    />
  );
};
```

### 2.2.2 ViewModel 层 (RTK Slice + Custom Hook)

```typescript
// view-models/articleEditorSlice.ts
import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { invoke } from '@tauri-apps/api/core';
import type { ArticleDTO } from '../domain';

interface ArticleEditorState {
  article: ArticleDTO | null;
  isDirty: boolean;
  saveStatus: 'idle' | 'saving' | 'succeeded' | 'failed';
  optimisticVersion: number;
}

const initialState: ArticleEditorState = {
  article: null,
  isDirty: false,
  saveStatus: 'idle',
  optimisticVersion: 0,
};

// Async Thunk: invoke Rust → dispatch action
export const saveArticle = createAsyncThunk(
  'articleEditor/save',
  async (article: ArticleDTO) => {
    return await invoke<ArticleDTO>('article:save', { article });
  }
);

const articleEditorSlice = createSlice({
  name: 'articleEditor',
  initialState,
  reducers: {
    updateContent(state, action: PayloadAction<string>) {
      if (state.article) {
        state.article.content = action.payload;
        state.isDirty = true;
        state.optimisticVersion++;
      }
    },
    markClean(state) {
      state.isDirty = false;
      state.saveStatus = 'succeeded';
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(saveArticle.pending, (state) => {
        state.saveStatus = 'saving';
      })
      .addCase(saveArticle.fulfilled, (state, action) => {
        state.article = action.payload;
        state.isDirty = false;
        state.saveStatus = 'succeeded';
      })
      .addCase(saveArticle.rejected, (state) => {
        state.saveStatus = 'failed';
        // optimisticVersion 用于触发 UI 恢复
      });
  },
});

export const { updateContent, markClean } = articleEditorSlice.actions;
```

### 2.2.3 Binder 层 (Selector + Custom Hook)

```typescript
// view-models/useArticleEditorVM.ts
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '@/stores';
import {
  updateContent,
  saveArticle,
  selectArticle,
  selectIsDirty,
} from './articleEditorSlice';

export function useArticleEditorVM() {
  const dispatch = useDispatch();
  const article = useSelector(selectArticle);
  const isDirty = useSelector(selectIsDirty);

  return {
    article,
    isDirty,
    updateContent: (content: string) => dispatch(updateContent(content)),
    save: () => article && dispatch(saveArticle(article)),
  };
}
```

### 2.2.4 Model 层 (TS DTO)

```typescript
// domain/ArticleDTO.ts
export interface ArticleDTO {
  id: string;
  project_id: string;
  title: string;
  content: string;
  status: 'draft' | 'published';
  // ⚠️ Rust 侧为 u64 (BIGINT)，JS number 安全整数上限为 2^53-1 (~9e15)
  // 按每秒更新 100 次计算，达到安全边界需 ~2.8 亿年，实际无风险
  version: number;
  updated_at: string;
  created_at: string;
}
```

## 2.3 后端 Clean Architecture

### 2.3.1 Domain 层

```rust
// domain/article.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Article {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub content: String,
    pub status: ArticleStatus,
    /// 乐观锁版本号，u64（数据库 BIGINT）
    /// 按每秒更新 100 次计算，约 58 亿年才会溢出
    pub version: u64,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ArticleStatus {
    Draft,
    Published,
}

impl Article {
    /// 领域规则：标题不能为空
    pub fn validate(&self) -> Result<(), ValidationError> {
        if self.title.trim().is_empty() {
            return Err(ValidationError::EmptyTitle);
        }
        if self.content.len() > 1_000_000 {
            return Err(ValidationError::ContentTooLarge);
        }
        Ok(())
    }

    /// 领域规则：只有草稿可以编辑内容
    pub fn can_edit_content(&self) -> bool {
        matches!(self.status, ArticleStatus::Draft)
    }
}
```

### 2.3.2 Application 层 (UseCase)

```rust
// application/article_usecase.rs
pub struct ArticleUseCase {
    repo: Arc<dyn ArticleRepository>,
    event_emitter: Arc<EventEmitter>,
    version_manager: Arc<VersionManager>,
}

impl ArticleUseCase {
    pub async fn update_article(
        &self,
        id: &str,
        content: &str,
        expected_version: u64,
    ) -> Result<Article, AppError> {
        // 1. 获取当前版本
        let current = self.repo.find_by_id(id)?;

        // 2. 乐观锁检查
        if current.version != expected_version {
            return Err(AppError::VersionConflict {
                current: current.version,
                expected: expected_version,
            });
        }

        // 3. 领域规则校验
        current.validate()?;
        if !current.can_edit_content() {
            return Err(AppError::NotDraft);
        }

        // 4. 事务写入（版本号 +1）
        let updated = self.repo.update_with_version(id, content, expected_version)?;

        // 5. 发射领域事件
        self.event_emitter.emit_entity_updated("article", &updated);

        Ok(updated)
    }
}
```

### 2.3.3 Controller 层 (Tauri Command Handler)

```rust
// commands/article_commands.rs
#[tauri::command]
async fn article_update(
    state: State<'_, AppState>,
    window: Window,
    id: String,
    content: String,
    expected_version: u64,
    // 1. 会话解析
    let session = state.session_manager
        .resolve(&window)
        .ok_or("UNAUTHORIZED")?;

    // 2. 权限校验
    state.auth.check_permission(&session, "article:write")
        .map_err(|e| e.to_string())?;

    // 3. 调用 UseCase
    let result = state.article_usecase
        .update_article(&id, &content, expected_version)
        .map_err(|e| e.to_string())?;

    Ok(result.into())
}
```

### 2.3.4 Infrastructure 层

```rust
// infrastructure/article_repository.rs
pub struct SqliteArticleRepository {
    pool: Pool<SqliteConnectionManager>,
}

impl ArticleRepository for SqliteArticleRepository {
    fn update_with_version(
        &self,
        id: &str,
        content: &str,
        expected_version: u64,
    ) -> Result<Article, AppError> {
        let conn = self.pool.get()?;
        conn.execute("BEGIN IMMEDIATE", [])?;

        // 防御性检查：版本号溢出（实际概率极低）
        let new_version = expected_version
            .checked_add(1)
            .ok_or(AppError::VersionOverflow)?;

        let rows = conn.execute(
            "UPDATE articles SET content = ?1, version = ?2,
             updated_at = datetime('now')
             WHERE id = ?3 AND version = ?4",
            params![content, new_version as i64, id, expected_version as i64],
        )?;

        if rows == 0 {
            conn.execute("ROLLBACK", [])?;
            return Err(AppError::VersionConflict {
                current: 0, // 查询获取实际版本
                expected: expected_version,
            });
        }

        conn.execute("COMMIT", [])?;
        self.find_by_id(id)
    }
}
```

## 2.4 分层间数据映射

```
Rust Domain Struct ──Serialize──► JSON ──Deserialize──► TS DTO
        ▲                                                    │
        │ invoke params                                       │ invoke result
        │                                                    ▼
   Command Handler ◄──────── JSON ──────── RTK Async Thunk
```

**映射规则**：
- Rust `String` ↔ TS `string`
- Rust `u64/i64` ↔ TS `number`（⚠️ 注意 JS `Number.MAX_SAFE_INTEGER = 2^53-1`，u64 超出此范围需用 `bigint` 或序列化为 `string`；version 字段实际值远小于安全边界无需特殊处理）
- Rust `i32/u32` ↔ TS `number`
- Rust `DateTime<Utc>` ↔ TS `string`（ISO 8601）
- Rust `Option<T>` ↔ TS `T | null`
- Rust `enum` ↔ TS `string union`

## 2.5 反模式与边界

| 做法                                  | 问题                                       |
| ------------------------------------- | ------------------------------------------ |
| View 组件直接调用 `invoke`            | 绕过 ViewModel，失去状态管理               |
| RTK Slice 包含领域校验逻辑            | 校验应全在 Rust Domain，前端仅做 UI 校验   |
| DTO 包含与 Rust 不一致的可选字段       | 序列化/反序列化失败                        |
| Command Handler 包含业务编排           | 应委托给 UseCase，Handler 仅做路由和权限    |
| UseCase 直接操作 UI 状态               | UseCase 不应知道 UI 存在                    |

## 2.6 React Error Boundary 策略

MVVM 架构中，组件错误若无边界隔离会白屏整个窗口。采用三级 Error Boundary 实现故障隔离。

### 分层边界

| 层级 | 位置 | 捕获范围 | 降级行为 |
|------|------|---------|---------|
| L1 组件级 | 各业务组件包裹 | 单个组件渲染错误 | 替换为内联错误提示卡片 |
| L2 区域级 | 面板/侧栏包裹 | 区域级渲染错误 | 显示"该区域加载失败，请刷新" |
| L3 窗口级 | App Root 包裹 | 窗口级崩溃 | 显示崩溃恢复 UI，提供"重新加载窗口"按钮 |

### 实现

```typescript
// components/ErrorBoundary.tsx
import React from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

interface ErrorBoundaryProps {
  level: 'component' | 'region' | 'window';
  fallback?: React.ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps, ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // 上报错误（日志 + 用户提示）
    // 错误会通过统一埋点体系自动上报（详见 12 §12.3.2）
    // 错误处理协议详见 13 §13.2 数据协议规范
    console.error(`[ErrorBoundary ${this.props.level}]`, error, errorInfo);
    this.props.onError?.(error, errorInfo);
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  private handleReloadWindow = async () => {
    const window = getCurrentWindow();
    // Tauri 2.x 方式：关闭并重新打开
    await window.close();
    // 由 Rust 侧管理重新打开逻辑
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    if (this.props.fallback) return this.props.fallback;

    switch (this.props.level) {
      case 'component':
        return (
          <div className="error-card">
            <p>⚠️ 组件加载失败</p>
            <button onClick={this.handleRetry}>重试</button>
          </div>
        );
      case 'region':
        return (
          <div className="error-region">
            <h3>该区域加载失败</h3>
            <p>{this.state.error?.message}</p>
            <button onClick={this.handleRetry}>刷新区域</button>
          </div>
        );
      case 'window':
        return (
          <div className="error-window">
            <h2>应用遇到意外错误</h2>
            <p>请尝试重新加载窗口。如问题持续，请重启应用。</p>
            <button onClick={this.handleReloadWindow}>
              重新加载窗口
            </button>
          </div>
        );
    }
  }
}
```

### 使用示例

```typescript
// main.editor.tsx — 窗口入口
import { Provider } from 'react-redux';
import { ErrorBoundary } from './components/ErrorBoundary';

root.render(
  <ErrorBoundary level="window">
    <Provider store={store}>
      <ErrorBoundary level="region">
        <EditorApp />
      </ErrorBoundary>
    </Provider>
  </ErrorBoundary>
);
```

## 2.7 IPC 故障降级与离线指示器

当 Tauri IPC 调用失败（网络断开、Rust 后端崩溃），前端应优雅降级而非白屏。

```typescript
// hooks/useIPCStatus.ts
import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';

type IPCStatus = 'online' | 'degraded' | 'offline';

export function useIPCStatus(pollInterval = 5000) {
  const [status, setStatus] = useState<IPCStatus>('online');
  const [lastError, setLastError] = useState<string | null>(null);

  const checkConnection = useCallback(async () => {
    try {
      await invoke('ping', {});
      setStatus('online');
      setLastError(null);
    } catch (e: any) {
      setLastError(String(e));
      // Rust 未响应 → 标记离线
      if (e?.includes?.('timeout') || e?.includes?.('refused')) {
        setStatus('offline');
      } else {
        setStatus('degraded');
      }
    }
  }, []);

  useEffect(() => {
    // 首次立即检查
    checkConnection();
    const timer = setInterval(checkConnection, pollInterval);
    return () => clearInterval(timer);
  }, [checkConnection, pollInterval]);

  return { status, lastError, retry: checkConnection };
}

// components/OfflineIndicator.tsx
export const OfflineIndicator: React.FC = () => {
  const { status, retry } = useIPCStatus();

  if (status === 'online') return null;

  return (
    <div className={`offline-banner ${status}`}>
      {status === 'offline'
        ? '🔴 连接断开，变更将保存在本地，恢复后自动同步'
        : '🟡 连接异常，部分功能可能受限'}
      <button onClick={retry}>重试连接</button>
    </div>
  );
};
```

## 2.8 统一错误处理模型

### 2.8.1 问题与目标

三层语言栈（Python → Rust → TypeScript）各有独立的错误模型，缺乏统一的错误传播协议：

```
Python:  HTTPException(500, "LLM timeout")
    → Rust 只拿到 HTTP status + 字符串 body，丢失结构化信息
        → TS catch(e) 拿到通用错误，无法做差异化处理
```

**目标**：定义跨语言边界的 **错误分层协议**，使每一层都能：
- 根据错误类型（`code`）做差异化处理
- 根据严重程度（`severity`）决定用户提示级别
- 根据可恢复性（`recoverable`）决定是否允许重试

### 2.8.2 错误码分类

| 类别 | 前缀 | 示例 | 严重级别 |
|------|------|------|---------|
| 认证/授权 | `AUTH_*` | `AUTH_SESSION_EXPIRED`, `AUTH_UNAUTHORIZED` | ERROR |
| 数据校验 | `VALIDATION_*` | `VALIDATION_EMPTY_TITLE`, `VALIDATION_CONTENT_TOO_LARGE` | WARN |
| 版本冲突 | `VERSION_*` | `VERSION_CONFLICT`, `VERSION_OVERFLOW` | WARN |
| 资源不存在 | `NOT_FOUND` | `NOT_FOUND` | INFO |
| IPC/通信 | `IPC_*` | `IPC_TIMEOUT`, `IPC_DISCONNECTED` | ERROR |
| 数据库 | `DB_*` | `DB_LOCKED`, `DB_CORRUPTION` | FATAL |
| AI 服务 | `AGENT_*` | `AGENT_UNAVAILABLE`, `AGENT_RATE_LIMITED`, `AGENT_TIMEOUT` | WARN |
| 安全违规 | `SECURITY_*` | `SECURITY_TAMPERING`, `SECURITY_INVALID_TOKEN` | FATAL |
| 通用内部 | `INTERNAL` | `INTERNAL` | FATAL |

### 2.8.3 Rust 侧：AppError（真理源）

```rust
// domain/error.rs
use serde::Serialize;
use std::fmt;

/// 错误严重级别
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorSeverity {
    Info,
    Warn,
    Error,
    Fatal,
}

/// 统一错误模型——跨语言边界的唯一错误表示
#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    /// 机器可读错误码 (e.g., "VERSION_CONFLICT")
    pub code: String,
    /// 用户可读消息
    pub message: String,
    /// 严重级别
    pub severity: ErrorSeverity,
    /// 前端是否可以尝试恢复（重试）
    pub recoverable: bool,
    /// 可选：额外上下文 (JSON 字符串)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}
```

**工厂方法**：

```rust
impl AppError {
    pub fn not_found(entity: &str, id: &str) -> Self {
        Self {
            code: "NOT_FOUND".into(),
            message: format!("{entity} not found: {id}"),
            severity: ErrorSeverity::Info,
            recoverable: false,
            detail: None,
        }
    }

    pub fn version_conflict(current: u64, expected: u64) -> Self {
        Self {
            code: "VERSION_CONFLICT".into(),
            message: format!(
                "数据已被其他窗口修改。当前版本: {current}，您的版本: {expected}。请刷新后重试。"
            ),
            severity: ErrorSeverity::Warn,
            recoverable: true,
            detail: Some(serde_json::json!({
                "current_version": current,
                "expected_version": expected,
            }).to_string()),
        }
    }

    pub fn validation(msg: impl Into<String>) -> Self {
        Self {
            code: "VALIDATION_ERROR".into(),
            message: msg.into(),
            severity: ErrorSeverity::Warn,
            recoverable: false,
            detail: None,
        }
    }

    pub fn unauthorized(msg: impl Into<String>) -> Self {
        Self {
            code: "AUTH_UNAUTHORIZED".into(),
            message: msg.into(),
            severity: ErrorSeverity::Error,
            recoverable: false,
            detail: None,
        }
    }

    pub fn session_expired() -> Self {
        Self {
            code: "AUTH_SESSION_EXPIRED".into(),
            message: "会话已过期，请重新登录".into(),
            severity: ErrorSeverity::Error,
            recoverable: true,
            detail: None,
        }
    }

    pub fn agent_unavailable(reason: impl Into<String>) -> Self {
        Self {
            code: "AGENT_UNAVAILABLE".into(),
            message: format!("AI 服务不可用: {}", reason.into()),
            severity: ErrorSeverity::Warn,
            recoverable: true,
            detail: None,
        }
    }

    pub fn agent_timeout(skill: &str) -> Self {
        Self {
            code: "AGENT_TIMEOUT".into(),
            message: format!("AI 技能「{skill}」执行超时，请稍后重试"),
            severity: ErrorSeverity::Warn,
            recoverable: true,
            detail: None,
        }
    }

    pub fn db_error(msg: impl Into<String>) -> Self {
        Self {
            code: "DB_ERROR".into(),
            message: msg.into(),
            severity: ErrorSeverity::Fatal,
            recoverable: false,
            detail: None,
        }
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        Self {
            code: "INTERNAL".into(),
            message: msg.into(),
            severity: ErrorSeverity::Fatal,
            recoverable: false,
            detail: None,
        }
    }

    /// 从 Python Agent 的 HTTP 错误响应解析
    pub fn from_agent_response(status: u16, body: &str) -> Self {
        // 尝试解析 Python 侧的 AgentError JSON
        if let Ok(agent_err) = serde_json::from_str::<serde_json::Value>(body) {
            let code = agent_err["code"].as_str().unwrap_or("AGENT_ERROR");
            let message = agent_err["message"].as_str().unwrap_or(body);
            return Self {
                code: format!("AGENT_{}", code),
                message: message.to_string(),
                severity: ErrorSeverity::Warn,
                recoverable: status != 500, // 5xx 不可重试
                detail: None,
            };
        }
        Self::agent_unavailable(format!("HTTP {}", status))
    }
}

// ─── 实现 From trait，兼容 ? 操作符 ───

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        match e {
            rusqlite::Error::SqliteFailure(err, _)
                if err.code == rusqlite::ErrorCode::DatabaseBusy =>
                Self::db_error("数据库繁忙，请稍后重试"),
            _ => Self::db_error(e.to_string()),
        }
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        Self::internal(format!("序列化错误: {e}"))
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}
```

**Command Handler 中的使用对比**：

```rust
// 旧方案 ❌ — 错误转为 String，丢失结构化信息
#[tauri::command]
async fn article_update_old(
    state: State<'_, AppState>,
    window: Window,
    id: String,
    content: String,
    expected_version: u64,
) -> Result<ArticleDTO, String> {
    let session = state.session_manager
        .resolve_from_window(window.label())
        .ok_or("UNAUTHORIZED".to_string())?;

    state.auth.check_permission(&session, Permission::ArticleWrite, Some(&article.user_id))
        .map_err(|e| e.to_string())?;

    state.article_usecase
        .update_article(&id, &content, expected_version)
        .map(|a| a.into())
        .map_err(|e| e.to_string())
}

// 新方案 ✅ — 直接返回 AppError，Tauri 自动序列化为 JSON
#[tauri::command]
async fn article_update(
    state: State<'_, AppState>,
    window: Window,
    id: String,
    content: String,
    expected_version: u64,
) -> Result<ArticleDTO, AppError> {
    let session = state.session_manager
        .resolve_from_window(window.label())
        .ok_or(AppError::session_expired())?;

    let article = state.article_repo.find_by_id(&id)?;
    state.auth.check_permission(&session, Permission::ArticleWrite, Some(&article.user_id))?;

    let updated = state.article_usecase
        .update_article(&id, &content, expected_version)?;

    Ok(updated.into())
}
```

> **⚠️ 关键变更**：Tauri 2.x 会将 `Result<T, AppError>` 的 `Err` 分支自动序列化为 JSON 传递给前端。之前使用 `Result<T, String>` 导致前端只能拿到无结构的字符串。

### 2.8.4 TypeScript 侧：ApiError

```typescript
// domain/ApiError.ts

/** 与 Rust ErrorSeverity 一一对应 */
export type ErrorSeverity = 'info' | 'warn' | 'error' | 'fatal';

/** 跨语言边界的统一错误结构 */
export interface ApiError {
  code: string;
  message: string;
  severity: ErrorSeverity;
  recoverable: boolean;
  detail?: string; // JSON string，仅部分错误会携带
}

/**
 * 解析 Tauri invoke 抛出的错误为结构化的 ApiError。
 * 
 * Tauri 2.x 的 invoke 在 Rust 侧返回 Err 时，
 * 会将 AppError JSON 作为字符串抛出。
 */
export function parseApiError(error: unknown): ApiError {
  // 场景 1：Tauri 序列化了 AppError JSON 为字符串
  if (typeof error === 'string') {
    try {
      const parsed = JSON.parse(error);
      if (parsed.code && parsed.message) {
        return parsed as ApiError;
      }
    } catch {
      // 不是合法 JSON，继续 fallback
    }
  }

  // 场景 2：标准 Error 对象
  if (error instanceof Error) {
    return {
      code: 'INTERNAL',
      message: error.message,
      severity: 'fatal',
      recoverable: false,
    };
  }

  // 场景 3：完全未知
  return {
    code: 'INTERNAL',
    message: String(error),
    severity: 'fatal',
    recoverable: false,
  };
}

/** 根据错误类型决定用户提示方式 */
export type ErrorAction = 'toast' | 'modal' | 'inline' | 'silent' | 'relogin';

export function getErrorAction(error: ApiError): ErrorAction {
  switch (error.code) {
    // 需重新登录
    case 'AUTH_SESSION_EXPIRED':
      return 'relogin';

    // 严重错误：模态框阻断
    case 'DB_CORRUPTION':
    case 'SECURITY_TAMPERING':
    case 'INTERNAL':
      return 'modal';

    // 可恢复：轻量 Toast
    case 'VERSION_CONFLICT':
    case 'AGENT_UNAVAILABLE':
    case 'AGENT_TIMEOUT':
    case 'AGENT_RATE_LIMITED':
      return 'toast';

    // 校验错误：表单项内联
    case 'VALIDATION_ERROR':
      return 'inline';

    // 资源不存在：静默处理（如详情页回到列表）
    case 'NOT_FOUND':
      return 'silent';

    default:
      return error.recoverable ? 'toast' : 'modal';
  }
}
```

**RTK Async Thunk 中的使用**：

```typescript
// view-models/articleEditorSlice.ts
export const saveArticle = createAsyncThunk(
  'articleEditor/save',
  async (article: ArticleDTO, { rejectWithValue }) => {
    try {
      return await invoke<ArticleDTO>('article:save', { article });
    } catch (e) {
      const apiError = parseApiError(e);

      // 版本冲突：保留本地编辑内容不丢弃，提示用户刷新
      if (apiError.code === 'VERSION_CONFLICT') {
        return rejectWithValue(apiError);
      }

      return rejectWithValue(apiError);
    }
  }
);
```

**组件层使用 ErrorAction 做 UI 分发**：

```typescript
// hooks/useErrorHandler.ts
import { useCallback } from 'react';
import { parseApiError, getErrorAction } from '@/domain/ApiError';
import { useToast } from '@/components/Toast';

export function useErrorHandler() {
  const toast = useToast();

  return useCallback((error: unknown, context?: string) => {
    const apiError = parseApiError(error);
    const action = getErrorAction(apiError);

    console.error(`[ErrorHandler${context ? `:${context}` : ''}]`, apiError);

    switch (action) {
      case 'toast':
        toast.show(apiError.message, { type: 'warning', duration: 5000 });
        break;
      case 'modal':
        // 触发全局错误模态框
        window.dispatchEvent(new CustomEvent('app:fatal-error', {
          detail: apiError,
        }));
        break;
      case 'inline':
        // 由各自的表单组件处理
        break;
      case 'relogin':
        toast.show(apiError.message, { type: 'error' });
        // 触发重新登录流程
        break;
      case 'silent':
        // 不打断用户
        break;
    }
  }, [toast]);
}
```

### 2.8.5 错误传播全链路

```
┌─────────────────────────────────────────────────────────────┐
│                    错误传播协议                              │
│                                                             │
│  Python AgentError (Pydantic)                               │
│    {code, message, severity, recoverable, detail?}          │
│         │                                                   │
│         ▼  FastAPI HTTP Response (JSON body)                │
│  ───────────────────────────────────────────                │
│  Rust AppError::from_agent_response(status, body)           │
│    {code: "AGENT_<original_code>", message, severity, ...}  │
│         │                                                   │
│         ▼  Tauri invoke Result<T, AppError> (自动序列化)     │
│  ───────────────────────────────────────────                │
│  TypeScript parseApiError(error)                            │
│    → getErrorAction() → toast / modal / inline / silent     │
└─────────────────────────────────────────────────────────────┘
```

> **Python 侧的 AgentError 模型定义**：详见 [05-Python-AI扩展架构.md](./05-Python-AI扩展架构.md) 第 5.9 节

### 2.8.6 向后兼容策略

对于历史 `Result<T, String>` 返回值的 Command，提供过渡期兼容宏。新 Command 直接使用 `Result<T, AppError>`。

```rust
/// 将 String 错误包装为 AppError（仅用于尚未迁移的旧 Command）
macro_rules! compat_string_error {
    ($result:expr) => {
        $result.map_err(|e: String| AppError {
            code: "INTERNAL".into(),
            message: e,
            severity: ErrorSeverity::Fatal,
            recoverable: false,
            detail: None,
        })
    };
}
```

**迁移路径**（按优先级）：
1. 所有新 Command 直接返回 `Result<T, AppError>`
2. 已有 Command 按文件逐步迁移：`Result<T, String>` → `Result<T, AppError>`
3. 前端统一使用 `parseApiError()` 替代裸 `catch (e)` 逻辑
4. 迁移完成后删除 `compat_string_error!` 宏
