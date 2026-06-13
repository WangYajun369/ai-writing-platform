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
    pub version: u32,
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
        expected_version: u32,
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
    expected_version: u32,
) -> Result<ArticleDTO, String> {
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
        expected_version: u32,
    ) -> Result<Article, AppError> {
        let conn = self.pool.get()?;
        conn.execute("BEGIN IMMEDIATE", [])?;

        let new_version = expected_version + 1;
        let rows = conn.execute(
            "UPDATE articles SET content = ?1, version = ?2,
             updated_at = datetime('now')
             WHERE id = ?3 AND version = ?4",
            params![content, new_version, id, expected_version],
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
