use std::{
    collections::HashSet,
    convert::Infallible,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use axum::{
    body::{Body, Bytes},
    extract::{Query, Request, State},
    http::{
        header::{AUTHORIZATION, CONTENT_TYPE},
        HeaderValue, StatusCode,
    },
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use tower_http::{limit::RequestBodyLimitLayer, timeout::TimeoutLayer, trace::TraceLayer};
use uuid::Uuid;

use crate::{
    config::{PROTOCOL_VERSION, SCHEMA_VERSION},
    domain::{MemoryWindow, SearchHit},
    error::{ServiceError, ServiceResult},
    identity::{IdentityResolver, OwnerSelector, ResolvedOwner},
    ingest::{ReconcileStats, Reconciler},
    search::{MemorySearchRequest, MessageSearchRequest, SearchIndex},
    storage::now_ms,
    sync::{
        self, ChangeFeedResponse, ManifestRequest, ManifestResponse, MessageDiffRequest,
        MessageDiffResponse, MessageManifestResponse, MessagesPullFrame, MessagesPullRequest,
        MessagesPushRequest, MessagesPushResponse, TopicHashDiffRequest, TopicHashDiffResponse,
        TopicSelector,
    },
    watcher::WatcherMetrics,
};

#[derive(Clone)]
pub struct AppState {
    pub instance_id: Uuid,
    pub auth_token: Arc<str>,
    pub started_at: i64,
    pub reconciler: Reconciler,
    pub search: Option<SearchIndex>,
    pub identity: IdentityResolver,
    pub cancellation: CancellationToken,
    pub watcher_metrics: Option<Arc<WatcherMetrics>>,
    pub reconcile_lock: Arc<Mutex<()>>,
    pub pending_index: Arc<AtomicU64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyHandshake {
    #[serde(rename = "type")]
    pub message_type: &'static str,
    pub protocol_version: u32,
    pub schema_version: u32,
    pub port: u16,
    pub instance_id: Uuid,
    pub auth_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
    protocol_version: u32,
    schema_version: u32,
    instance_id: Uuid,
    uptime_ms: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusResponse {
    status: &'static str,
    protocol_version: u32,
    schema_version: u32,
    instance_id: Uuid,
    content_revision: i64,
    indexed_revision: i64,
    owners: i64,
    topics: i64,
    messages: i64,
    pending_ingest: u64,
    pending_index: u64,
    reconcile_required: bool,
    search_available: bool,
    search_rebuilding: bool,
    last_reconcile_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IngestPathRequest {
    path: String,
    #[serde(default = "default_api_origin")]
    origin: String,
}

fn default_api_origin() -> String {
    "api".to_string()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IngestResponse {
    accepted: bool,
    changed: bool,
    revision: Option<i64>,
    message_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReconcileResponse {
    stats: ReconcileStats,
    indexed_topics: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageSearchResponse {
    hits: Vec<SearchHit>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryApiRequest {
    #[serde(flatten)]
    owner: OwnerSelector,
    #[serde(default)]
    query: String,
    #[serde(default)]
    current_topic_id: Option<String>,
    #[serde(default = "default_true")]
    exclude_current_topic: bool,
    #[serde(default = "default_window")]
    window_before: i64,
    #[serde(default = "default_window")]
    window_after: i64,
    #[serde(default = "default_candidate_limit")]
    candidate_limit: usize,
    #[serde(default = "default_result_limit")]
    result_limit: usize,
    #[serde(default = "default_max_chars")]
    max_chars: usize,
    /// Legacy DeepMemo alias for both before and after windows.
    #[serde(default)]
    window_size: Option<i64>,
    /// Legacy DeepMemo query alias.
    #[serde(default)]
    keyword: Option<String>,
}

fn default_true() -> bool {
    true
}
fn default_window() -> i64 {
    6
}
fn default_candidate_limit() -> usize {
    50
}
fn default_result_limit() -> usize {
    8
}
fn default_max_chars() -> usize {
    60_000
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemorySearchResponse {
    owner: ResolvedOwner,
    windows: Vec<MemoryWindow>,
    formatted_result: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationResponse {
    success: bool,
    affected: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangesQuery {
    #[serde(default)]
    after: i64,
    #[serde(default = "default_change_limit")]
    limit: usize,
}

fn default_change_limit() -> usize {
    200
}

pub fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route("/v1/status", get(status))
        .route("/v1/reconcile", post(reconcile))
        .route("/v1/rebuild-search-index", post(rebuild_search))
        .route("/v1/ingest/history-path", post(ingest_history_path))
        .route("/v1/search/messages", post(search_messages))
        .route("/v1/search/memories", post(search_memories))
        .route("/v1/sync/manifest", post(sync_manifest))
        .route("/v1/sync/message-manifest", post(sync_message_manifest))
        .route("/v1/sync/topic-diff", post(sync_topic_diff))
        .route("/v1/sync/message-diff", post(sync_message_diff))
        .route("/v1/sync/messages/pull", post(sync_messages_pull))
        .route("/v1/sync/messages/push", post(sync_messages_push))
        .route("/v1/changes", get(change_feed))
        .route("/v1/flush", post(flush))
        .route("/v1/shutdown", post(shutdown))
        .route_layer(middleware::from_fn_with_state(state.clone(), authenticate))
        .layer(RequestBodyLimitLayer::new(16 * 1024 * 1024));

    let sync_v2 = Router::new()
        .route("/v2/sync/messages/pull", post(sync_messages_pull_stream))
        .route(
            "/v2/sync/messages/push-topic",
            post(sync_messages_push_topic),
        )
        .route("/v2/sync/topic-identity", post(sync_topic_identity))
        .route_layer(middleware::from_fn_with_state(state.clone(), authenticate))
        .layer(RequestBodyLimitLayer::new(34 * 1024 * 1024));

    Router::new()
        .route("/v1/health", get(health))
        .merge(protected)
        .merge(sync_v2)
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(120),
        ))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn authenticate(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Result<Response, ServiceError> {
    let expected = format!("Bearer {}", state.auth_token);
    let supplied = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();

    let valid = supplied.len() == expected.len()
        && bool::from(supplied.as_bytes().ct_eq(expected.as_bytes()));
    if !valid {
        return Err(ServiceError::Unauthorized);
    }
    Ok(next.run(request).await)
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ready",
        protocol_version: PROTOCOL_VERSION,
        schema_version: SCHEMA_VERSION,
        instance_id: state.instance_id,
        uptime_ms: now_ms() - state.started_at,
    })
}

async fn status(State(state): State<AppState>) -> ServiceResult<Json<StatusResponse>> {
    let stats = state
        .reconciler
        .database()
        .stats()
        .map_err(ServiceError::internal)?;
    let (pending_ingest, reconcile_required) = state
        .watcher_metrics
        .as_ref()
        .map(|metrics| {
            (
                metrics.pending_paths.load(Ordering::Relaxed),
                metrics.reconcile_required.load(Ordering::Relaxed),
            )
        })
        .unwrap_or((0, false));
    let (search_available, search_rebuilding) = state
        .search
        .as_ref()
        .map(|search| {
            let status = search.status();
            (status.available, status.rebuilding)
        })
        .unwrap_or((false, false));

    Ok(Json(StatusResponse {
        status: "ready",
        protocol_version: PROTOCOL_VERSION,
        schema_version: SCHEMA_VERSION,
        instance_id: state.instance_id,
        content_revision: stats.content_revision,
        indexed_revision: stats.indexed_revision,
        owners: stats.owners,
        topics: stats.topics,
        messages: stats.messages,
        pending_ingest,
        pending_index: state.pending_index.load(Ordering::Relaxed),
        reconcile_required,
        search_available,
        search_rebuilding,
        last_reconcile_at: stats.last_reconcile_at,
    }))
}

async fn reconcile(State(state): State<AppState>) -> ServiceResult<Json<ReconcileResponse>> {
    let _guard = state
        .reconcile_lock
        .try_lock()
        .map_err(|_| ServiceError::Busy)?;
    let stats = state
        .reconciler
        .reconcile()
        .await
        .map_err(ServiceError::internal)?;
    let indexed_topics = state
        .search
        .as_ref()
        .map(SearchIndex::reconcile_revisions)
        .transpose()
        .map_err(ServiceError::internal)?
        .unwrap_or(0);
    Ok(Json(ReconcileResponse {
        stats,
        indexed_topics,
    }))
}

async fn ingest_history_path(
    State(state): State<AppState>,
    Json(request): Json<IngestPathRequest>,
) -> ServiceResult<Json<IngestResponse>> {
    let raw_path = std::path::PathBuf::from(request.path);
    let path = state
        .reconciler
        .config()
        .validate_source_path(&raw_path)
        .map_err(|error| ServiceError::InvalidRequest(error.to_string()))?;
    let commit = state
        .reconciler
        .ingest_path(&path, &request.origin)
        .await
        .map_err(ServiceError::internal)?;

    if let (Some(search), Some(commit)) = (&state.search, &commit) {
        if commit.changed {
            search
                .update_topic(&commit.topic, commit.revision)
                .map_err(ServiceError::internal)?;
        }
    }

    Ok(Json(match commit {
        Some(commit) => IngestResponse {
            accepted: true,
            changed: commit.changed,
            revision: Some(commit.revision),
            message_count: commit.message_count,
        },
        None => IngestResponse {
            accepted: false,
            changed: false,
            revision: None,
            message_count: 0,
        },
    }))
}

async fn search_messages(
    State(state): State<AppState>,
    Json(request): Json<MessageSearchRequest>,
) -> ServiceResult<Json<MessageSearchResponse>> {
    let search = state
        .search
        .as_ref()
        .ok_or_else(|| ServiceError::SearchUnavailable("Tantivy is disabled".to_string()))?;
    let hits = search
        .search_messages(&request)
        .map_err(ServiceError::internal)?;
    Ok(Json(MessageSearchResponse { hits }))
}

async fn search_memories(
    State(state): State<AppState>,
    Json(mut request): Json<MemoryApiRequest>,
) -> ServiceResult<Json<MemorySearchResponse>> {
    let search = state
        .search
        .as_ref()
        .ok_or_else(|| ServiceError::SearchUnavailable("Tantivy is disabled".to_string()))?;
    let owner = state.identity.resolve(&request.owner)?;

    if request.query.trim().is_empty() {
        if let Some(keyword) = request.keyword.take() {
            request.query = keyword;
        }
    }
    if request.query.trim().is_empty() {
        return Err(ServiceError::InvalidRequest(
            "query or legacy keyword is required".to_string(),
        ));
    }

    let (window_before, window_after) = request
        .window_size
        .map(|window| (window, window))
        .unwrap_or((request.window_before, request.window_after));
    let windows = search
        .search_memories(&MemorySearchRequest {
            query: request.query,
            owner_type: owner.owner_type,
            owner_id: owner.owner_id.clone(),
            current_topic_id: request.current_topic_id,
            exclude_current_topic: request.exclude_current_topic,
            window_before,
            window_after,
            candidate_limit: request.candidate_limit,
            result_limit: request.result_limit,
            max_chars: request.max_chars,
        })
        .map_err(ServiceError::internal)?;
    let formatted_result = format_memory_windows(&windows);

    Ok(Json(MemorySearchResponse {
        owner,
        windows,
        formatted_result,
    }))
}

async fn sync_manifest(
    State(state): State<AppState>,
    Json(request): Json<ManifestRequest>,
) -> ServiceResult<Json<ManifestResponse>> {
    sync::manifest(state.reconciler.database(), request)
        .map(Json)
        .map_err(ServiceError::internal)
}

async fn sync_message_manifest(
    State(state): State<AppState>,
    Json(request): Json<TopicSelector>,
) -> ServiceResult<Json<MessageManifestResponse>> {
    sync::message_manifest(state.reconciler.database(), &request)
        .map(Json)
        .map_err(ServiceError::internal)
}

async fn sync_topic_diff(
    State(state): State<AppState>,
    Json(request): Json<TopicHashDiffRequest>,
) -> ServiceResult<Json<TopicHashDiffResponse>> {
    sync::topic_hash_diff(state.reconciler.database(), request)
        .map(Json)
        .map_err(ServiceError::internal)
}

async fn sync_message_diff(
    State(state): State<AppState>,
    Json(request): Json<MessageDiffRequest>,
) -> ServiceResult<Json<MessageDiffResponse>> {
    sync::message_diff(state.reconciler.database(), request)
        .map(Json)
        .map_err(ServiceError::internal)
}

async fn sync_topic_identity(
    State(state): State<AppState>,
    Json(selector): Json<TopicSelector>,
) -> ServiceResult<Json<sync::TopicIdentityResponse>> {
    if selector.topic_id.is_empty() {
        return Err(ServiceError::InvalidRequest(
            "sync topic identity requires a non-empty topicId".to_string(),
        ));
    }
    sync::topic_identity(state.reconciler.database(), &selector)
        .map(Json)
        .map_err(ServiceError::internal)
}

async fn sync_messages_pull(
    State(state): State<AppState>,
    Json(request): Json<MessagesPullRequest>,
) -> ServiceResult<Json<Vec<MessagesPullFrame>>> {
    sync::pull_messages(state.reconciler.database(), request)
        .map(Json)
        .map_err(ServiceError::internal)
}

const MAX_SYNC_TOPICS: usize = 10_000;
const MAX_SYNC_MESSAGES: usize = 100_000;
const MAX_SYNC_FRAME_BYTES: usize = 32 * 1024 * 1024;
const MAX_SYNC_TOTAL_BYTES: usize = 256 * 1024 * 1024;

async fn sync_messages_pull_stream(
    State(state): State<AppState>,
    Json(request): Json<MessagesPullRequest>,
) -> ServiceResult<Response> {
    validate_pull_request(&request)?;
    let database = state.reconciler.database().clone();
    let requests = request.requests.into_iter();
    let stream = futures::stream::unfold(
        (requests, database, 0_usize),
        |(mut requests, database, total_bytes)| async move {
            let topic = requests.next()?;
            let topic_id = topic.topic_id.clone();
            let owner_type = topic.owner_type;
            let owner_id = topic.owner_id.clone();
            let worker_database = database.clone();
            let mut bytes = match tokio::task::spawn_blocking(move || {
                encode_pull_topic_frame(&worker_database, topic)
            })
            .await
            {
                Ok(bytes) => bytes,
                Err(error) => encode_pull_error_frame(
                    &topic_id,
                    owner_type,
                    owner_id.as_deref(),
                    &format!("CDS pull worker failed: {error}"),
                ),
            };
            if bytes.len() > MAX_SYNC_FRAME_BYTES {
                bytes = encode_pull_error_frame(
                    &topic_id,
                    owner_type,
                    owner_id.as_deref(),
                    "CDS pull frame exceeds 32 MiB budget",
                );
            }
            let next_total = total_bytes.checked_add(bytes.len());
            if next_total.is_none_or(|total| total > MAX_SYNC_TOTAL_BYTES) {
                bytes = encode_pull_error_frame(
                    &topic_id,
                    owner_type,
                    owner_id.as_deref(),
                    "CDS pull response exceeds 256 MiB total budget",
                );
                requests = Vec::new().into_iter();
                if total_bytes.saturating_add(bytes.len()) > MAX_SYNC_TOTAL_BYTES {
                    return None;
                }
            }
            let next_total = total_bytes.saturating_add(bytes.len());
            Some((
                Ok::<Bytes, Infallible>(Bytes::from(bytes)),
                (requests, database, next_total),
            ))
        },
    );
    let mut response = Response::new(Body::from_stream(stream));
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/x-ndjson; charset=utf-8"),
    );
    Ok(response)
}

fn encode_pull_topic_frame(
    database: &crate::storage::Database,
    topic: sync::MessagesPullTopic,
) -> Vec<u8> {
    let topic_id = topic.topic_id.clone();
    let owner_type = topic.owner_type;
    let owner_id = topic.owner_id.clone();
    let frame = match sync::pull_topic_messages(database, topic) {
        Ok(frame) => serde_json::to_value(frame),
        Err(error) => Ok(serde_json::json!({
            "topicId": topic_id,
            "ownerType": owner_type,
            "ownerId": owner_id,
            "messages": [],
            "_error": format!("{error:#}"),
        })),
    };
    match frame.and_then(|frame| serde_json::to_vec(&frame)) {
        Ok(mut bytes) => {
            bytes.push(b'\n');
            bytes
        }
        Err(error) => encode_pull_error_frame(
            &topic_id,
            owner_type,
            owner_id.as_deref(),
            &format!("failed to encode CDS pull frame: {error}"),
        ),
    }
}

fn encode_pull_error_frame(
    topic_id: &str,
    owner_type: Option<crate::domain::OwnerType>,
    owner_id: Option<&str>,
    error: &str,
) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(&serde_json::json!({
        "topicId": topic_id,
        "ownerType": owner_type,
        "ownerId": owner_id,
        "messages": [],
        "_error": error,
    }))
    .unwrap_or_else(|_| b"{\"_stream_error\":\"failed to encode CDS error frame\"}".to_vec());
    bytes.push(b'\n');
    bytes
}

fn validate_pull_request(request: &MessagesPullRequest) -> ServiceResult<()> {
    if request.requests.is_empty() || request.requests.len() > MAX_SYNC_TOPICS {
        return Err(ServiceError::InvalidRequest(format!(
            "sync pull requires between 1 and {MAX_SYNC_TOPICS} topics"
        )));
    }
    let mut identities = HashSet::new();
    let mut message_count = 0_usize;
    for topic in &request.requests {
        if topic.topic_id.is_empty() {
            return Err(ServiceError::InvalidRequest(
                "sync pull topicId must be non-empty".to_string(),
            ));
        }
        if topic.owner_type.is_some() != topic.owner_id.is_some() {
            return Err(ServiceError::InvalidRequest(
                "sync pull ownerType and ownerId must be supplied together".to_string(),
            ));
        }
        if topic.owner_id.as_deref().is_some_and(str::is_empty) {
            return Err(ServiceError::InvalidRequest(
                "sync pull ownerId must be non-empty".to_string(),
            ));
        }
        let identity = (
            topic.owner_type.map(|owner| owner.as_str()),
            topic.owner_id.as_deref(),
            topic.topic_id.as_str(),
        );
        if !identities.insert(identity) {
            return Err(ServiceError::InvalidRequest(
                "sync pull contains a duplicate topic identity".to_string(),
            ));
        }
        if topic.msg_ids.len() > 10_000 {
            return Err(ServiceError::InvalidRequest(
                "sync pull topic exceeds 10000 message ids".to_string(),
            ));
        }
        let unique_ids = topic.msg_ids.iter().collect::<HashSet<_>>();
        if unique_ids.len() != topic.msg_ids.len() || unique_ids.iter().any(|id| id.is_empty()) {
            return Err(ServiceError::InvalidRequest(
                "sync pull message ids must be non-empty and unique".to_string(),
            ));
        }
        message_count = message_count
            .checked_add(topic.msg_ids.len())
            .ok_or_else(|| ServiceError::InvalidRequest("sync pull count overflow".to_string()))?;
        if message_count > MAX_SYNC_MESSAGES {
            return Err(ServiceError::InvalidRequest(
                "sync pull exceeds 100000 requested messages".to_string(),
            ));
        }
    }
    Ok(())
}

async fn sync_messages_push(
    State(state): State<AppState>,
    Json(request): Json<MessagesPushRequest>,
) -> ServiceResult<Json<MessagesPushResponse>> {
    let response = sync::push_messages(&state.reconciler, request).await;
    if let Some(search) = &state.search {
        for result in &response.results {
            if result.success && result.changed {
                search
                    .reconcile_revisions()
                    .map_err(ServiceError::internal)?;
                break;
            }
        }
    }
    Ok(Json(response))
}

async fn sync_messages_push_topic(
    State(state): State<AppState>,
    Json(topic): Json<sync::MessagesPushTopic>,
) -> ServiceResult<Json<sync::MessagesPushResult>> {
    if topic.topic_id.is_empty()
        || topic.messages.len() > 10_000
        || topic.deleted_message_ids.len() > 10_000
        || topic.deleted_message_tombstones.len() > 10_000
        || topic
            .messages
            .len()
            .saturating_add(topic.deleted_message_ids.len())
            .saturating_add(topic.deleted_message_tombstones.len())
            > 10_000
    {
        return Err(ServiceError::InvalidRequest(
            "sync push topicId is required and messages are limited to 10000".to_string(),
        ));
    }
    let response = sync::push_messages(
        &state.reconciler,
        MessagesPushRequest {
            topics: vec![topic],
        },
    )
    .await;
    let result =
        response.results.into_iter().next().ok_or_else(|| {
            ServiceError::internal(anyhow::anyhow!("sync push omitted topic result"))
        })?;
    if result.success && result.changed {
        if let Some(search) = &state.search {
            search
                .reconcile_revisions()
                .map_err(ServiceError::internal)?;
        }
    }
    Ok(Json(result))
}

async fn change_feed(
    State(state): State<AppState>,
    Query(query): Query<ChangesQuery>,
) -> ServiceResult<Json<ChangeFeedResponse>> {
    sync::changes(state.reconciler.database(), query.after, query.limit)
        .map(Json)
        .map_err(ServiceError::internal)
}

async fn rebuild_search(
    State(state): State<AppState>,
) -> ServiceResult<(StatusCode, Json<OperationResponse>)> {
    let search = state
        .search
        .as_ref()
        .ok_or_else(|| ServiceError::SearchUnavailable("Tantivy is disabled".to_string()))?;
    let affected = search.rebuild().map_err(ServiceError::internal)?;
    Ok((
        StatusCode::OK,
        Json(OperationResponse {
            success: true,
            affected,
        }),
    ))
}

async fn flush(State(state): State<AppState>) -> ServiceResult<Json<OperationResponse>> {
    state
        .reconciler
        .database()
        .checkpoint()
        .map_err(ServiceError::internal)?;
    Ok(Json(OperationResponse {
        success: true,
        affected: 0,
    }))
}

async fn shutdown(State(state): State<AppState>) -> Json<OperationResponse> {
    state.cancellation.cancel();
    Json(OperationResponse {
        success: true,
        affected: 0,
    })
}

fn format_memory_windows(windows: &[MemoryWindow]) -> String {
    windows
        .iter()
        .enumerate()
        .map(|(index, window)| {
            let messages =
                window
                    .messages
                    .iter()
                    .filter_map(|message| {
                        if message.content_text.is_empty() {
                            return None;
                        }
                        let name = message.speaker_name.as_deref().unwrap_or(
                            match message.role.as_str() {
                                "user" => "用户",
                                "assistant" => "Assistant",
                                _ => message.role.as_str(),
                            },
                        );
                        Some(format!("{name}: {}", message.content_text))
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
            format!("[回忆片段{}]:\n{}", index + 1, messages)
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}
