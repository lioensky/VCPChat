//! VCP Hi-Fi Audio Engine - WebDAV Client Module
//!
//! Provides WebDAV directory browsing (PROPFIND) and credential management.
//! Audio playback of WebDAV files is handled by the decoder with Basic Auth.

use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum WebDavError {
    #[error("HTTP error: {0}")]
    Http(String),
    #[error("XML parse error: {0}")]
    Xml(String),
    #[error("Invalid base URL")]
    InvalidBaseUrl,
}

/// WebDAV server configuration
///
/// FIX for Defect 10: Custom Debug impl to mask password in log output.
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct WebDavConfig {
    /// Base URL, e.g. "https://nas.local/music" (no trailing slash)
    pub base_url: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

impl std::fmt::Debug for WebDavConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebDavConfig")
            .field("base_url", &self.base_url)
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "********"))
            .finish()
    }
}

/// A single entry returned by PROPFIND
#[derive(Debug, Clone, Serialize)]
pub struct DavEntry {
    /// Full href as returned by server
    pub href: String,
    pub display_name: String,
    pub is_dir: bool,
    pub content_length: Option<u64>,
    pub content_type: Option<String>,
    /// Full playable URL (base_url + href, deduplicated)
    pub url: String,
}

impl WebDavConfig {
    /// Returns true if a base_url has been set
    pub fn is_configured(&self) -> bool {
        !self.base_url.is_empty()
    }

    /// Get a normalized base_url with scheme prefix.
    /// If base_url doesn't start with http:// or https://, prepends http://
    fn normalized_base_url(&self) -> String {
        let base = self.base_url.trim_end_matches('/');
        if base.starts_with("http://") || base.starts_with("https://") {
            base.to_string()
        } else {
            format!("http://{}", base)
        }
    }

    /// Build a full URL from a path.
    /// Handles two formats:
    /// 1. Server-root-relative path (e.g. "/dav/music/") - uses origin + path
    /// 2. Base-relative path (e.g. "/music/") - uses base_url + path
    ///
    /// Special case: path "/" means "browse base_url itself", returns base_url.
    pub fn resolve_url(&self, path: &str) -> String {
        if path.starts_with("http://") || path.starts_with("https://") {
            return path.to_string();
        }

        let base = self.normalized_base_url();

        // Special case: "/" means browse the base_url directory itself
        if path == "/" || path.is_empty() {
            return base;
        }

        // Ensure path starts with /
        let path = if path.starts_with('/') { path.to_string() } else { format!("/{}", path) };

        // Extract origin and base_path from base_url
        // "http://ip.local:5244/dav" -> origin="http://ip.local:5244", base_path="/dav"
        let origin = extract_origin(&base).unwrap_or_else(|| base.clone());
        let base_path = extract_path_from_url(&base);

        // Check if path already starts with base_path AT A PATH SEGMENT BOUNDARY
        // FIX for Defect 45: Must verify path segment boundary to prevent
        // "/dav" from incorrectly matching "/davmusic/file.flac"
        let base_path_trimmed = base_path.trim_end_matches('/');
        let matches_at_boundary = if base_path_trimmed.is_empty() || base_path == "/" {
            false
        } else if path.starts_with(base_path_trimmed) {
            let remaining = &path[base_path_trimmed.len()..];
            // Path segment boundary: remaining is empty or starts with '/'
            remaining.is_empty() || remaining.starts_with('/')
        } else {
            false
        };

        if matches_at_boundary {
            // Server-root-relative path: use origin + path
            format!("{}{}", origin, path)
        } else {
            // Base-relative path: use base_url + path
            format!("{}{}", base.trim_end_matches('/'), path)
        }
    }

    /// Issue a PROPFIND Depth:1 on `path` and return the directory listing.
    /// `path` is relative to the server root (e.g. "/music/jazz").
    pub fn list(&self, path: &str) -> Result<Vec<DavEntry>, WebDavError> {
        if !self.is_configured() {
            return Err(WebDavError::InvalidBaseUrl);
        }

        let normalized_base = self.normalized_base_url();
        let url = self.resolve_url(path);
        log::info!("WebDAV PROPFIND: {} (base={}, path={})", url, normalized_base, path);

        // FIX for Defect 28: Add timeout to prevent indefinite blocking
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| WebDavError::Http(format!("Failed to create HTTP client: {}", e)))?;
        let mut req = client
            .request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), &url)
            .header("Depth", "1")
            .header("Content-Type", "application/xml")
            .body(
                r#"<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <d:getcontentlength/>
    <d:getcontenttype/>
  </d:prop>
</d:propfind>"#,
            );

        if let (Some(u), Some(p)) = (&self.username, &self.password) {
            req = req.basic_auth(u, Some(p));
        }

        let response = req.send().map_err(|e| WebDavError::Http(e.to_string()))?;
        let status = response.status();
        if !status.is_success() && status.as_u16() != 207 {
            return Err(WebDavError::Http(format!("Server returned {}", status)));
        }

        let body = response.text().map_err(|e| WebDavError::Http(e.to_string()))?;
        parse_propfind_response(&body, &normalized_base)
    }

    /// Convert to decoder credentials
    pub fn http_credentials(&self) -> Option<crate::decoder::HttpCredentials> {
        match (&self.username, &self.password) {
            (Some(u), Some(p)) => Some(crate::decoder::HttpCredentials {
                username: u.clone(),
                password: p.clone(),
            }),
            _ => None,
        }
    }
}

/// Parse a WebDAV multi-status XML response into DavEntry list.
fn parse_propfind_response(xml: &str, base_url: &str) -> Result<Vec<DavEntry>, WebDavError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    // Extract the path portion of base_url for relative href conversion
    // e.g. base_url = "https://nas.local/music" -> base_path = "/music"
    let base_path = extract_path_from_url(base_url);

    let mut entries: Vec<DavEntry> = Vec::new();

    // Per-response state
    let mut in_response = false;
    let mut current_href = String::new();
    let mut current_name = String::new();
    let mut is_collection = false;
    let mut content_length: Option<u64> = None;
    let mut content_type: Option<String> = None;

    // Tag tracking
    let mut current_tag = String::new();

    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let local = local_name(e.name().as_ref());
                current_tag = local.clone();
                match local.as_str() {
                    "response" => {
                        in_response = true;
                        current_href.clear();
                        current_name.clear();
                        is_collection = false;
                        content_length = None;
                        content_type = None;
                    }
                    "collection" if in_response => {
                        is_collection = true;
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(ref e)) => {
                let local = local_name(e.name().as_ref());
                if local == "collection" && in_response {
                    is_collection = true;
                }
            }
            Ok(Event::Text(ref e)) => {
                if !in_response {
                    buf.clear();
                    continue;
                }
                let text = e.unescape().unwrap_or_default().to_string();
                match current_tag.as_str() {
                    "href" => current_href = text,
                    "displayname" => current_name = text,
                    "getcontentlength" => {
                        content_length = text.trim().parse().ok();
                    }
                    "getcontenttype" => {
                        content_type = Some(text);
                    }
                    _ => {}
                }
            }
            Ok(Event::End(ref e)) => {
                let local = local_name(e.name().as_ref());
                if local == "response" && in_response {
                    let display_name = if current_name.is_empty() {
                        // Fall back to last path segment
                        current_href
                            .trim_end_matches('/')
                            .rsplit('/')
                            .next()
                            .unwrap_or(&current_href)
                            .to_string()
                    } else {
                        current_name.clone()
                    };

                    // Build the playable URL (absolute)
                    let url = build_full_url(base_url, &current_href);

                    // Convert server-absolute href to base_url-relative href
                    // e.g. server returns "/music/jazz/", base_path="/music" -> href="/jazz/"
                    let relative_href = strip_base_path(&current_href, &base_path);

                    log::debug!(
                        "WebDAV entry: server_href={}, base_path={}, relative_href={}, url={}",
                        current_href, base_path, relative_href, url
                    );

                    entries.push(DavEntry {
                        href: relative_href,
                        display_name,
                        is_dir: is_collection,
                        content_length,
                        content_type: content_type.clone(),
                        url,
                    });
                    in_response = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(WebDavError::Xml(e.to_string())),
            _ => {}
        }
        buf.clear();
    }

    Ok(entries)
}

/// Strip XML namespace prefix and return the local name
fn local_name(name: &[u8]) -> String {
    let s = std::str::from_utf8(name).unwrap_or("");
    s.rsplit(':').next().unwrap_or(s).to_lowercase()
}

/// Extract origin (scheme://host) from a URL.
/// Returns None if the URL is invalid.
fn extract_origin(url: &str) -> Option<String> {
    // Find scheme://host boundary
    let scheme_end = url.find("://")?;
    let after_scheme = &url[scheme_end + 3..];
    // Find first slash after host (or end of string)
    let host_end = after_scheme.find('/').unwrap_or(after_scheme.len());
    Some(url[..scheme_end + 3 + host_end].to_string())
}

/// Extract the path portion from a URL.
/// e.g. "https://nas.local/music/jazz" -> "/music/jazz"
/// Also handles URLs without scheme: "nas.local/music" -> "/music"
/// Returns "/" if no path component exists.
fn extract_path_from_url(url: &str) -> String {
    // Find the start of the path
    let after_host = if let Some(scheme_end) = url.find("://") {
        // URL has scheme like "https://..."
        &url[scheme_end + 3..]
    } else {
        // No scheme, treat entire URL as host/path
        url
    };

    // Find first slash after host (skip host:port part)
    if let Some(slash_pos) = after_host.find('/') {
        return after_host[slash_pos..].to_string();
    }
    // No path component
    "/".to_string()
}

/// Strip the base_path prefix from a server-absolute href.
/// e.g. href="/music/jazz/", base_path="/music" -> "/jazz/"
/// If href doesn't start with base_path, returns href unchanged.
///
/// FIX for Defect 45: Ensure matching only occurs at path segment boundaries.
/// This prevents "/dav" from incorrectly matching "/davmusic/file.flac".
fn strip_base_path(href: &str, base_path: &str) -> String {
    // Normalize: ensure base_path doesn't end with /
    let base_path = base_path.trim_end_matches('/');
    if base_path.is_empty() {
        return href.to_string();
    }

    // Check if href starts with base_path AT A PATH SEGMENT BOUNDARY
    // Defect 45 fix: Must verify that either:
    // 1. href exactly equals base_path, OR
    // 2. href[base_path.len()] is '/' (path segment boundary)
    if href.starts_with(base_path) {
        let remaining = &href[base_path.len()..];
        // Only match at path segment boundary: remaining must be empty or start with '/'
        if remaining.is_empty() {
            "/".to_string()
        } else if remaining.starts_with('/') {
            remaining.to_string()
        } else {
            // Not a path segment boundary - no match, return original
            href.to_string()
        }
    } else {
        href.to_string()
    }
}

/// Combine base_url + href, avoiding double slashes or duplicated host
fn build_full_url(base_url: &str, href: &str) -> String {
    // If href is already absolute, use it directly
    if href.starts_with("http://") || href.starts_with("https://") {
        return href.to_string();
    }
    // href is a root-relative path like "/music/jazz/track.flac"
    // Extract origin (scheme://host) from base_url
    if let Some(origin) = extract_origin(base_url) {
        let href = if href.starts_with('/') { href.to_string() } else { format!("/{}", href) };
        return format!("{}{}", origin, href);
    }
    // Fallback: just append to base_url
    let base = base_url.trim_end_matches('/');
    let href = if href.starts_with('/') { href.to_string() } else { format!("/{}", href) };
    format!("{}{}", base, href)
}
