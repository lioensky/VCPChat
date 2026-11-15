//! Dedicated storage process mode of the existing executable.
//! No automatic DB path: deployment must explicitly hand over ownership before launching.
use std::io;
use std::path::Path;
use serde_json::{json, Value};
use crate::{storage::Store, transport};

pub fn run(path: &Path, config_path: Option<&Path>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Validate host configuration before opening/migrating the database.
    let config=config_path.map(crate::service_config::Config::load).transpose()?;
    let runtime=if config.is_some() {
        Some(tokio::runtime::Builder::new_current_thread().enable_all().build()?)
    } else {None};
    let mut store = Store::open(path)?;
    let stdout = io::stdout();
    let mut output = stdout.lock();
    transport::write_frame(&mut output, &json!({
        "type":"ready","service":"projectforge-storage","protocolVersion":1,
        "maxFrameBytes":transport::MAX_FRAME_BYTES,
        "capabilities":if config.is_some() {
            vec!["businessQueries","atomicHistory","operationStatus","nativeEditV1"]
        } else {vec!["businessQueries","atomicHistory","operationStatus"]},
        "filesystemCommit":config.is_some()
    }))?;
    let stdin = io::stdin();
    let mut input = stdin.lock();
    while let Some(line) = transport::read_frame(&mut input, transport::MAX_FRAME_BYTES)? {
        if line.trim().is_empty() { continue; }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                transport::write_frame(&mut output, &json!({
                    "id":null,"ok":false,"error":{"code":"INVALID_JSON","message":error.to_string()}
                }))?;
                continue;
            }
        };
        let id = match request.get("id") {
            Some(Value::Number(n)) if n.as_u64().is_some() => Value::Number(n.clone()),
            Some(Value::String(s)) if !s.is_empty() && s.len()<=128 => Value::String(s.clone()),
            _ => {
                transport::write_frame(&mut output,&json!({
                    "id":null,"ok":false,"error":{"code":"INVALID_ID","message":"id must be a nonnegative integer or bounded string"}
                }))?;
                continue;
            }
        };
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        if method == "shutdown" {
            transport::write_frame(&mut output,&json!({"id":id,"ok":true,"result":{"bye":true}}))?;
            break;
        }
        let params = request.get("params").unwrap_or(&Value::Null);
        let result = match method {
            "ping" => Ok(json!({"pong":true})),
            "store.createProject" | "store.recordBatch" => store.mutate(method, params),
            "edit.execute" => match (&config,&runtime) {
                (Some(config),Some(runtime))=>runtime.block_on(crate::edit_service::execute(
                    &mut store,params,&config.allowed_roots,&config.validator)),
                _=>Err("native editing requires explicit trusted service configuration".into()),
            },
            _ => store.query(method, params),
        };
        let response = match result {
            Ok(result) => json!({"id":id,"ok":true,"result":result}),
            Err(error) => json!({"id":id,"ok":false,"error":{"code":"STORE_ERROR","message":error.to_string()}}),
        };
        transport::write_frame(&mut output,&response)?;
    }
    Ok(())
}