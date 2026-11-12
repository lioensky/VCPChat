use std::io::Write;

/// Explicit child-process opt-in; legacy launchers still receive only ready.
pub fn progress(stage: &str) {
    tracing::info!(stage, "VCP-CDS startup stage");
    if std::env::var("VCP_CDS_STARTUP_PROGRESS").as_deref() != Ok("1") {
        return;
    }
    let mut stdout = std::io::stdout().lock();
    let frame = serde_json::json!({
        "type": "startup_progress",
        "protocolVersion": crate::config::PROTOCOL_VERSION,
        "stage": stage
    });
    if let Err(error) = writeln!(stdout, "{frame}").and_then(|_| stdout.flush()) {
        tracing::warn!(%error, "failed to publish startup progress");
    }
}