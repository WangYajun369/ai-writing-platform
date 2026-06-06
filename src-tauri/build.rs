//! Tauri 构建脚本
//!
//! 在编译 Rust 后端之前触发，由 `tauri_build::build()` 自动处理
//! 资源打包、图标生成等编译期任务。

fn main() {
    tauri_build::build()
}
