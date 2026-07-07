//! AI Assist IPC commands — thin wrappers over `naiteh_core::services::ai`.
//! See that module for the transport, prompt, and error mapping.

use crate::domain::AppError;
use crate::services::{ai, config};

fn load_ai_config() -> Result<crate::services::config::AiConfig, AppError> {
    let dir = config::default_app_config_dir()?;
    crate::services::fs::ensure_dir(&dir)?;
    Ok(config::load(&dir)?.ai)
}

#[tauri::command]
pub async fn ai_improve(text: String, instruction: String) -> Result<String, AppError> {
    let cfg = load_ai_config()?;
    ai::improve(&cfg, &text, &instruction).await
}

#[tauri::command]
pub async fn ai_list_models() -> Result<Vec<String>, AppError> {
    let cfg = load_ai_config()?;
    ai::list_models(&cfg).await
}
