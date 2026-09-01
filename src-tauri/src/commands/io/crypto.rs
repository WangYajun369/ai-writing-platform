//! AES-256-GCM 加密/解密 & .tw 文件格式
//!
//! 用于备份文件的加密存储。
//!
//! .tw 文件格式：
//!   [2 bytes: u16 BE = prefix_block 长度]
//!   [prefix_block: encrypt_bytes(MAGIC_PREFIX)]
//!   [data_block:   encrypt_bytes(JSON 载荷)]
//!
//! 密钥管理（v1.0.1 安全加固）：
//!   1. 环境变量 `TIMEWRITE_BACKUP_KEY` 优先（任意长度 → SHA-256 派生 32 字节）
//!   2. 持久化密钥文件 `<app_data_dir>/backup.key`（首次启动生成随机密钥，Unix 权限 0600）
//!
//! 密钥在应用启动时由 `init_backup_key` 初始化一次，加密/解密函数从全局缓存读取。

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use rand::Rng;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
use tauri::Manager;

/// AES-256-GCM 加密密钥（32 字节），应用启动时初始化
static BACKUP_KEY: OnceLock<[u8; 32]> = OnceLock::new();

/// 待加密的引导标识字符串
const MAGIC_PREFIX: &str = "TimeWrite";

/// 自定义备份密钥的环境变量名（可选，优先级最高）
const BACKUP_KEY_ENV: &str = "TIMEWRITE_BACKUP_KEY";

/// 初始化备份密钥（在 Tauri setup 中调用一次）。
///
/// 优先级：
/// 1. 环境变量 `TIMEWRITE_BACKUP_KEY`（非空 → SHA-256 派生）
/// 2. 已有密钥文件 `<app_data_dir>/backup.key`
/// 3. 生成随机密钥并写入密钥文件（Unix 权限 0600）
pub fn init_backup_key(app: &tauri::AppHandle) -> Result<(), String> {
    // 幂等：已初始化则直接返回
    if BACKUP_KEY.get().is_some() {
        return Ok(());
    }
    let key = resolve_backup_key(app)?;
    // 并发场景下若已被其他线程设置，保留首次设置的密钥
    let _ = BACKUP_KEY.set(key);
    Ok(())
}

/// 解析密钥来源：环境变量 > 持久化密钥文件 > 生成新密钥
fn resolve_backup_key(app: &tauri::AppHandle) -> Result<[u8; 32], String> {
    if let Ok(env_key) = std::env::var(BACKUP_KEY_ENV) {
        let trimmed = env_key.trim();
        if !trimmed.is_empty() {
            crate::app_log_console!(
                "[Crypto] 使用环境变量 {} 作为备份密钥",
                BACKUP_KEY_ENV
            );
            return Ok(derive_key(trimmed.as_bytes()));
        }
    }

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取数据目录: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    let key_path = dir.join("backup.key");

    if let Ok(existing) = std::fs::read(&key_path) {
        if existing.len() == 32 {
            let mut k = [0u8; 32];
            k.copy_from_slice(&existing);
            crate::app_log_console!("[Crypto] 已加载备份密钥文件 {}", key_path.display());
            return Ok(k);
        }
        crate::app_log_console!(
            "[Crypto] 密钥文件长度非法 ({} bytes)，重新生成",
            existing.len()
        );
    }

    let mut key = [0u8; 32];
    rand::thread_rng().fill(&mut key);
    write_key_file(&key_path, &key)?;
    crate::app_log_console!("[Crypto] 已生成新备份密钥: {}", key_path.display());
    Ok(key)
}

/// 写入密钥文件（Unix 权限 0600；Windows 无 POSIX 权限语义）
fn write_key_file(path: &std::path::Path, key: &[u8; 32]) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut opts = std::fs::OpenOptions::new();
        opts.create(true).write(true).truncate(true).mode(0o600);
        let mut f = opts
            .open(path)
            .map_err(|e| format!("写入密钥文件失败: {e}"))?;
        f.write_all(key)
            .map_err(|e| format!("写入密钥文件失败: {e}"))?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, key).map_err(|e| format!("写入密钥文件失败: {e}"))?;
    }
    Ok(())
}

/// 将任意字节派生为 32 字节密钥（SHA-256）
fn derive_key(bytes: &[u8]) -> [u8; 32] {
    let digest = Sha256::digest(bytes);
    let mut k = [0u8; 32];
    k.copy_from_slice(&digest);
    k
}

/// 获取当前密钥；未初始化时返回错误
fn current_key() -> Result<&'static [u8; 32], String> {
    BACKUP_KEY
        .get()
        .ok_or_else(|| "备份密钥未初始化：应用启动流程异常，请重启应用".to_string())
}

/// AES-256-GCM 加密：nonce[12] + ciphertext + tag[16]
pub fn encrypt_bytes(plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let key = Key::<Aes256Gcm>::from_slice(current_key()?);
    let cipher = Aes256Gcm::new(key);
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| format!("加密失败: {}", e))?;
    let mut result = Vec::with_capacity(12 + ciphertext.len());
    result.extend_from_slice(&nonce_bytes);
    result.extend_from_slice(&ciphertext);
    Ok(result)
}

/// AES-256-GCM 解密：输入为 nonce[12] + ciphertext + tag[16]
pub fn decrypt_bytes(data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 28 {
        return Err("数据块太短，无法解密".to_string());
    }
    let key = Key::<Aes256Gcm>::from_slice(current_key()?);
    let cipher = Aes256Gcm::new(key);
    let nonce = Nonce::from_slice(&data[..12]);
    let plaintext = cipher
        .decrypt(nonce, &data[12..])
        .map_err(|e| format!("解密失败，密文可能已损坏或密钥不匹配: {}", e))?;
    Ok(plaintext)
}

/// 构建加密的 .tw 文件
pub fn build_encrypted_file(json_payload: &[u8]) -> Result<Vec<u8>, String> {
    let prefix_block = encrypt_bytes(MAGIC_PREFIX.as_bytes())?;
    let data_block = encrypt_bytes(json_payload)?;

    let prefix_len = prefix_block.len() as u16;
    let mut file_bytes = Vec::with_capacity(2 + prefix_block.len() + data_block.len());
    file_bytes.extend_from_slice(&prefix_len.to_be_bytes());
    file_bytes.extend_from_slice(&prefix_block);
    file_bytes.extend_from_slice(&data_block);
    Ok(file_bytes)
}

/// 解析加密文件并校验引导标识，校验通过后返回解密的 JSON 载荷
pub fn parse_encrypted_file(file_bytes: &[u8]) -> Result<String, String> {
    if file_bytes.len() < 4 {
        return Err(
            "文件格式错误：文件内容太短，可能不是有效的 TimeWrite 备份文件。".to_string(),
        );
    }

    let prefix_len = u16::from_be_bytes([file_bytes[0], file_bytes[1]]) as usize;
    if prefix_len < 28 || file_bytes.len() < 2 + prefix_len + 28 {
        return Err("文件格式错误：前缀块长度异常，文件可能已损坏。".to_string());
    }

    let prefix_block = &file_bytes[2..2 + prefix_len];
    let prefix_plain =
        decrypt_bytes(prefix_block).map_err(|e| format!("引导标识解密失败：{}", e))?;
    let prefix_str =
        String::from_utf8(prefix_plain).map_err(|e| format!("引导标识编码异常: {}", e))?;

    if prefix_str != MAGIC_PREFIX {
        return Err(format!(
            "文件校验失败：引导标识不匹配，该文件不是有效的 TimeWrite 备份文件。\n期望: {}\n实际: {}",
            MAGIC_PREFIX, prefix_str
        ));
    }

    let data_block = &file_bytes[2 + prefix_len..];
    let data_plain =
        decrypt_bytes(data_block).map_err(|e| format!("数据解密失败：{}", e))?;

    let json_str = String::from_utf8(data_plain)
        .map_err(|e| format!("解密后的数据不是有效的 UTF-8 文本: {}", e))?;

    Ok(json_str)
}

/// 校验 JSON 载荷是否包含必需的字段结构
pub fn validate_payload_structure(json_str: &str) -> Result<(), String> {
    let val: serde_json::Value =
        serde_json::from_str(json_str).map_err(|e| format!("JSON 格式校验失败：{}", e))?;

    let obj = val
        .as_object()
        .ok_or("JSON 格式校验失败：根节点必须是对象")?;

    for field in &["version", "exportedAt", "backupType", "database", "cache"] {
        if !obj.contains_key(*field) {
            return Err(format!(
                "JSON 结构校验失败：缺少必需字段 \"{}\"",
                field
            ));
        }
    }

    let backup_type = obj
        .get("backupType")
        .and_then(|v| v.as_str())
        .ok_or("JSON 结构校验失败：backupType 字段格式错误")?;

    if backup_type != "full" && backup_type != "single" {
        return Err(format!(
            "JSON 结构校验失败：backupType 必须是 \"full\" 或 \"single\"，当前值: \"{}\"",
            backup_type
        ));
    }

    let db = obj
        .get("database")
        .and_then(|v| v.as_object())
        .ok_or("JSON 结构校验失败：database 字段缺失或格式错误")?;

    for table in &[
        "books",
        "volumes",
        "chapters",
        "snapshots",
        "worldCards",
        "embeddings",
    ] {
        if !db.contains_key(*table) {
            return Err(format!(
                "JSON 结构校验失败：database 缺少表 \"{}\"",
                table
            ));
        }
        if !db[*table].is_array() {
            return Err(format!(
                "JSON 结构校验失败：database.{} 必须是数组",
                table
            ));
        }
    }

    Ok(())
}
