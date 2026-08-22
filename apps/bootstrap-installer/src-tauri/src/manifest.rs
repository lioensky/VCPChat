use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallerManifest {
    pub schema_version: u32,
    pub product: String,
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub payload_url: String,
    pub payload_sha256: String,
    pub payload_size: u64,
}

impl InstallerManifest {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err(format!(
                "unsupported manifest schema: {}",
                self.schema_version
            ));
        }
        if self.product != "VCPChat" {
            return Err("manifest product is not VCPChat".into());
        }
        if self.version.trim().is_empty() {
            return Err("manifest version is empty".into());
        }
        if !(self.payload_url.starts_with("https://") || self.payload_url.starts_with("file://")) {
            return Err("payload URL must use HTTPS or file:// in development".into());
        }
        if self.payload_sha256.len() != 64
            || !self.payload_sha256.chars().all(|c| c.is_ascii_hexdigit())
        {
            return Err("payload SHA-256 must contain 64 hexadecimal characters".into());
        }
        if self.payload_size == 0 {
            return Err("payload size must be greater than zero".into());
        }
        Ok(())
    }
}

pub fn development_manifest() -> InstallerManifest {
    InstallerManifest {
        schema_version: 1,
        product: "VCPChat".into(),
        version: "0.1.0-dev".into(),
        platform: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        payload_url: "file://vcpchat-development-payload".into(),
        payload_sha256: "0000000000000000000000000000000000000000000000000000000000000000".into(),
        payload_size: 1,
    }
}

pub fn load_manifest() -> Result<(InstallerManifest, bool), String> {
    match std::env::var("VCPCHAT_INSTALLER_MANIFEST_JSON") {
        Ok(raw) => {
            let manifest: InstallerManifest = serde_json::from_str(&raw)
                .map_err(|error| format!("invalid VCPChat installer manifest: {error}"))?;
            manifest.validate()?;
            Ok((manifest, true))
        }
        Err(_) => {
            let manifest = development_manifest();
            manifest.validate()?;
            Ok((manifest, false))
        }
    }
}

fn file_path(manifest: &InstallerManifest) -> Result<PathBuf, String> {
    let raw = manifest
        .payload_url
        .strip_prefix("file://")
        .ok_or_else(|| "payload download is not available in the M3 local verifier".to_string())?;
    if raw.is_empty() {
        return Err("payload file path is empty".into());
    }
    Ok(PathBuf::from(raw))
}

pub fn verify_local_payload(manifest: &InstallerManifest) -> Result<(), String> {
    let path = file_path(manifest)?;
    let metadata = std::fs::metadata(&path)
        .map_err(|error| format!("cannot read payload {}: {error}", path.display()))?;
    if metadata.len() != manifest.payload_size {
        return Err(format!(
            "payload size mismatch: expected {}, got {}",
            manifest.payload_size,
            metadata.len()
        ));
    }
    let bytes = std::fs::read(&path)
        .map_err(|error| format!("cannot read payload {}: {error}", path.display()))?;
    let digest = format!("{:x}", Sha256::digest(bytes));
    if digest != manifest.payload_sha256.to_ascii_lowercase() {
        return Err(format!(
            "payload SHA-256 mismatch: expected {}, got {}",
            manifest.payload_sha256, digest
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_manifest_is_valid() {
        assert!(development_manifest().validate().is_ok());
    }

    #[test]
    fn rejects_unsigned_or_non_https_payloads() {
        let mut manifest = development_manifest();
        manifest.payload_url = "http://example.invalid/payload".into();
        assert!(manifest.validate().is_err());
        manifest.payload_url = "https://example.invalid/payload".into();
        manifest.payload_sha256 = "bad".into();
        assert!(manifest.validate().is_err());
    }

    #[test]
    fn verifies_local_payload_size_and_sha256() {
        let path = std::env::temp_dir().join(format!("vcpchat-payload-{}", std::process::id()));
        std::fs::write(&path, b"payload").expect("write fixture");
        let mut manifest = development_manifest();
        manifest.payload_url = format!("file://{}", path.display());
        manifest.payload_size = 7;
        manifest.payload_sha256 = format!("{:x}", Sha256::digest(b"payload"));
        assert!(verify_local_payload(&manifest).is_ok());
        manifest.payload_size = 8;
        assert!(verify_local_payload(&manifest).is_err());
        let _ = std::fs::remove_file(path);
    }
}
