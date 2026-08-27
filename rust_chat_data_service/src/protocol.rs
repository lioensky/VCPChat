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
    extract::{Request, State},
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
    domain::{
        AvatarKey, AvatarOwnerType, AvatarRecord, MemoryWindow, OwnerKey, OwnerType, SearchHit,
        TopicKey,
    },
    error::{ServiceError, ServiceResult},
    identity::{IdentityResolver, OwnerSelector, ResolvedOwner},
    ingest::{ReconcileStats, Reconciler},
    search::{MemorySearchRequest, MessageSearchRequest, SearchIndex},
    storage::now_ms,
    sync::{
        self, ManifestRequest, ManifestResponse, MessageDiffRequest, MessageDiffResponse,
        MessagesPullRequest, TopicDiffRequest, TopicDiffResponse,
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
#[serde(
    tag = "targetType",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum EntityDeleteRequest {
    Owner {
        owner_type: OwnerType,
        owner_id: String,
        deleted_at: i64,
    },
    Topic {
        owner_type: OwnerType,
        owner_id: String,
        topic_id: String,
        deleted_at: i64,
    },
    Avatar {
        owner_type: AvatarOwnerType,
        owner_id: String,
        deleted_at: i64,
    },
}

#[derive(Debug, Serialize)]
struct EntityDeleteResponse {
    ok: bool,
}

enum EntityDeleteTarget {
    Owner(OwnerType, String),
    Topic(TopicKey),
    Avatar(AvatarKey),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AvatarStateRequest {
    owner_type: AvatarOwnerType,
    owner_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReconcileOwnersRequest {
    owners: Vec<OwnerKey>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReconcileOwnersResponse {
    ok: bool,
    owners_reconciled: usize,
    indexed_topics: usize,
}

pub fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route("/v1/status", get(status))
        .route("/v1/reconcile", post(reconcile))
        .route("/v1/rebuild-search-index", post(rebuild_search))
        .route("/v1/ingest/history-path", post(ingest_history_path))
        .route("/v1/search/messages", post(search_messages))
        .route("/v1/search/memories", post(search_memories))
        .route("/v1/flush", post(flush))
        .route("/v1/shutdown", post(shutdown))
        .route_layer(middleware::from_fn_with_state(state.clone(), authenticate))
        .layer(RequestBodyLimitLayer::new(16 * 1024 * 1024));

    let sync_v3 = Router::new()
        .route("/v3/sync/manifest", post(sync_manifest))
        .route("/v3/sync/topic-diff", post(sync_topic_diff))
        .route("/v3/sync/message-diff", post(sync_message_diff))
        .route("/v3/sync/entities/pull", post(sync_entities_pull))
        .route("/v3/sync/entities/delete", post(sync_entity_delete))
        .route("/v3/sync/owners/reconcile", post(sync_reconcile_owners))
        .route("/v3/sync/avatars/state", post(sync_avatar_state))
        .route("/v3/sync/avatars/commit", post(sync_avatar_commit))
        .route("/v3/sync/messages/pull", post(sync_messages_pull_stream))
        .route("/v3/sync/messages/push", post(sync_messages_push))
        .route_layer(middleware::from_fn_with_state(state.clone(), authenticate))
        .layer(RequestBodyLimitLayer::new(34 * 1024 * 1024));

    Router::new()
        .route("/v1/health", get(health))
        .merge(protected)
        .merge(sync_v3)
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(270),
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
    if let Some(metrics) = &state.watcher_metrics {
        metrics.reconcile_required.swap(false, Ordering::AcqRel);
    }
    let result = async {
        let stats = state.reconciler.reconcile().await?;
        let indexed_topics = state
            .search
            .as_ref()
            .map(SearchIndex::reconcile_revisions)
            .transpose()?
            .unwrap_or(0);
        Ok::<_, anyhow::Error>((stats, indexed_topics))
    }
    .await;
    let (stats, indexed_topics) = match result {
        Ok(result) => result,
        Err(error) => {
            if let Some(metrics) = &state.watcher_metrics {
                metrics.reconcile_required.store(true, Ordering::Release);
            }
            return Err(ServiceError::internal(error));
        }
    };
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
    let _guard = state.reconcile_lock.lock().await;
    let commit = state
        .reconciler
        .ingest_path(&path, &request.origin)
        .await
        .map_err(ServiceError::internal)?;

    if let (Some(search), Some(commit)) = (&state.search, &commit) {
        search
            .apply_ingest_commit(commit)
            .map_err(ServiceError::internal)?;
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

async fn sync_topic_diff(
    State(state): State<AppState>,
    Json(request): Json<TopicDiffRequest>,
) -> ServiceResult<Json<TopicDiffResponse>> {
    sync::topic_diff(state.reconciler.database(), request)
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

async fn sync_entity_delete(
    State(state): State<AppState>,
    Json(request): Json<EntityDeleteRequest>,
) -> ServiceResult<Json<EntityDeleteResponse>> {
    let (target, deleted_at) = validate_entity_delete_request(request)?;
    let affects_search = matches!(
        &target,
        EntityDeleteTarget::Owner(_, _) | EntityDeleteTarget::Topic(_)
    );
    let _guard = state.reconcile_lock.lock().await;
    match target {
        EntityDeleteTarget::Owner(owner_type, owner_id) => state
            .reconciler
            .database()
            .apply_sync_owner_tombstone(owner_type, &owner_id, deleted_at),
        EntityDeleteTarget::Topic(key) => state
            .reconciler
            .database()
            .apply_sync_topic_tombstone(&key, deleted_at),
        EntityDeleteTarget::Avatar(key) => state
            .reconciler
            .database()
            .apply_sync_avatar_tombstone(&key, deleted_at),
    }
    .map_err(ServiceError::internal)?;
    if affects_search {
        if let Some(search) = &state.search {
            search
                .reconcile_revisions()
                .map_err(ServiceError::internal)?;
        }
    }

    Ok(Json(EntityDeleteResponse { ok: true }))
}

async fn sync_reconcile_owners(
    State(state): State<AppState>,
    Json(request): Json<ReconcileOwnersRequest>,
) -> ServiceResult<Json<ReconcileOwnersResponse>> {
    if request.owners.is_empty() || request.owners.len() > 1_000 {
        return Err(ServiceError::InvalidRequest(
            "sync owner reconcile requires 1 to 1000 owners".to_string(),
        ));
    }
    let mut seen = HashSet::with_capacity(request.owners.len());
    for owner in &request.owners {
        if owner.owner_id.is_empty()
            || !owner
                .owner_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            || !seen.insert((owner.owner_type, owner.owner_id.as_str()))
        {
            return Err(ServiceError::InvalidRequest(
                "sync owner reconcile requires unique valid owner identities".to_string(),
            ));
        }
    }

    let _guard = state.reconcile_lock.lock().await;
    let result = async {
        for owner in &request.owners {
            state.reconciler.reconcile_owner_key(owner).await?;
        }
        state
            .search
            .as_ref()
            .map(SearchIndex::reconcile_revisions)
            .transpose()
            .map(|count| count.unwrap_or(0))
    }
    .await;
    let indexed_topics = match result {
        Ok(indexed_topics) => indexed_topics,
        Err(error) => {
            if let Some(metrics) = &state.watcher_metrics {
                metrics.reconcile_required.store(true, Ordering::Release);
            }
            return Err(ServiceError::internal(error));
        }
    };
    Ok(Json(ReconcileOwnersResponse {
        ok: true,
        owners_reconciled: request.owners.len(),
        indexed_topics,
    }))
}

fn validate_entity_delete_request(
    request: EntityDeleteRequest,
) -> ServiceResult<(EntityDeleteTarget, i64)> {
    let safe_id = |id: &str| {
        !id.is_empty()
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    };
    let (target, deleted_at) = match request {
        EntityDeleteRequest::Owner {
            owner_type,
            owner_id,
            deleted_at,
        } if safe_id(&owner_id) => (EntityDeleteTarget::Owner(owner_type, owner_id), deleted_at),
        EntityDeleteRequest::Topic {
            owner_type,
            owner_id,
            topic_id,
            deleted_at,
        } if safe_id(&owner_id) && safe_id(&topic_id) => (
            EntityDeleteTarget::Topic(TopicKey {
                owner_type,
                owner_id,
                topic_id,
            }),
            deleted_at,
        ),
        EntityDeleteRequest::Avatar {
            owner_type,
            owner_id,
            deleted_at,
        } if safe_id(&owner_id) => (
            validate_avatar_key(AvatarKey {
                owner_type,
                owner_id,
            })
            .map(EntityDeleteTarget::Avatar)?,
            deleted_at,
        ),
        _ => {
            return Err(ServiceError::InvalidRequest(
                "sync entity delete requires a valid complete identity".to_string(),
            ));
        }
    };
    if !(0..=9_007_199_254_740_991).contains(&deleted_at) {
        return Err(ServiceError::InvalidRequest(
            "sync entity delete deletedAt must be a non-negative safe integer".to_string(),
        ));
    }
    Ok((target, deleted_at))
}

async fn sync_avatar_state(
    State(state): State<AppState>,
    Json(request): Json<AvatarStateRequest>,
) -> ServiceResult<Json<AvatarRecord>> {
    let key = validate_avatar_key(AvatarKey {
        owner_type: request.owner_type,
        owner_id: request.owner_id,
    })?;
    state
        .reconciler
        .database()
        .avatar_state(&key)
        .map_err(ServiceError::internal)?
        .map(Json)
        .ok_or_else(|| ServiceError::NotFound(format!("avatar {}", key.wire_id())))
}

async fn sync_avatar_commit(
    State(state): State<AppState>,
    Json(request): Json<AvatarStateRequest>,
) -> ServiceResult<Json<AvatarRecord>> {
    let key = validate_avatar_key(AvatarKey {
        owner_type: request.owner_type,
        owner_id: request.owner_id,
    })?;
    let _guard = state.reconcile_lock.lock().await;
    state
        .reconciler
        .commit_avatar(&key)
        .map(Json)
        .map_err(ServiceError::internal)
}

fn validate_avatar_key(key: AvatarKey) -> ServiceResult<AvatarKey> {
    let wire_id = key.wire_id();
    AvatarKey::from_wire_id(&wire_id)
}

async fn sync_entities_pull(
    State(state): State<AppState>,
    Json(request): Json<sync::EntitiesPullRequest>,
) -> ServiceResult<Json<sync::EntitiesPullResponse>> {
    validate_entities_pull_request(&request)?;
    Ok(Json(sync::pull_entities(
        state.reconciler.database(),
        request,
    )))
}

fn validate_entities_pull_request(request: &sync::EntitiesPullRequest) -> ServiceResult<()> {
    if request.items.len() > 1_000 {
        return Err(ServiceError::InvalidRequest(
            "sync entity pull accepts at most 1000 items".to_string(),
        ));
    }
    let is_safe_id = |id: &str| {
        !id.is_empty()
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    };
    let mut identities = HashSet::new();
    for item in &request.items {
        let identity = match item {
            sync::EntityPullItem::Owner {
                owner_type,
                owner_id,
            } if is_safe_id(owner_id) => {
                format!("owner\0{}\0{owner_id}", owner_type.as_str())
            }
            sync::EntityPullItem::Topic {
                owner_type,
                owner_id,
                topic_id,
            } if is_safe_id(owner_id) && is_safe_id(topic_id) => {
                format!("topic\0{}\0{owner_id}\0{topic_id}", owner_type.as_str())
            }
            _ => {
                return Err(ServiceError::InvalidRequest(
                    "sync entity pull identities must use only ASCII letters, digits, '_' or '-'"
                        .to_string(),
                ));
            }
        };
        if !identities.insert(identity) {
            return Err(ServiceError::InvalidRequest(
                "sync entity pull contains a duplicate identity".to_string(),
            ));
        }
    }
    Ok(())
}

// 消息拉取只保留流式端点，以 kind=topic、ok=false 隔离单 Topic 失败。
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
    let topics = request.topics.into_iter();
    let stream = futures::stream::unfold(
        (topics, database, 0_usize),
        |(mut topics, database, total_bytes)| async move {
            let topic = topics.next()?;
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
                    &owner_id,
                    "MESSAGE_READ_FAILED",
                    &format!("CDS pull worker failed: {error}"),
                    false,
                ),
            };
            if bytes.len() > MAX_SYNC_FRAME_BYTES {
                bytes = encode_pull_error_frame(
                    &topic_id,
                    owner_type,
                    &owner_id,
                    "BUDGET_EXCEEDED",
                    "CDS pull frame exceeds 32 MiB budget",
                    false,
                );
            }
            let next_total = total_bytes.checked_add(bytes.len());
            if next_total.is_none_or(|total| total > MAX_SYNC_TOTAL_BYTES) {
                bytes = encode_pull_error_frame(
                    &topic_id,
                    owner_type,
                    &owner_id,
                    "BUDGET_EXCEEDED",
                    "CDS pull response exceeds 256 MiB total budget",
                    false,
                );
                topics = Vec::new().into_iter();
                if total_bytes.saturating_add(bytes.len()) > MAX_SYNC_TOTAL_BYTES {
                    return None;
                }
            }
            let next_total = total_bytes.saturating_add(bytes.len());
            Some((
                Ok::<Bytes, Infallible>(Bytes::from(bytes)),
                (topics, database, next_total),
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
            "kind": "topic",
            "topicId": topic_id,
            "ownerType": owner_type,
            "ownerId": owner_id,
            "ok": false,
            "error": {
                "code": "MESSAGE_READ_FAILED",
                "message": format!("{error:#}"),
                "retryable": false,
            },
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
            &owner_id,
            "STREAM_FAILED",
            &format!("failed to encode CDS pull frame: {error}"),
            false,
        ),
    }
}

fn encode_pull_error_frame(
    topic_id: &str,
    owner_type: crate::domain::OwnerType,
    owner_id: &str,
    code: &str,
    message: &str,
    retryable: bool,
) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(&serde_json::json!({
        "kind": "topic",
        "topicId": topic_id,
        "ownerType": owner_type,
        "ownerId": owner_id,
        "ok": false,
        "error": {
            "code": code,
            "message": message,
            "retryable": retryable,
        },
    }))
    .unwrap_or_else(|_| {
        br#"{"kind":"streamError","error":{"code":"STREAM_FAILED","message":"failed to encode CDS error frame","retryable":false}}"#
            .to_vec()
    });
    bytes.push(b'\n');
    bytes
}

fn validate_pull_request(request: &MessagesPullRequest) -> ServiceResult<()> {
    if request.topics.is_empty() || request.topics.len() > MAX_SYNC_TOPICS {
        return Err(ServiceError::InvalidRequest(format!(
            "sync pull requires between 1 and {MAX_SYNC_TOPICS} topics"
        )));
    }
    let mut identities = HashSet::new();
    let mut message_count = 0_usize;
    for topic in &request.topics {
        if topic.topic_id.is_empty() {
            return Err(ServiceError::InvalidRequest(
                "sync pull topicId must be non-empty".to_string(),
            ));
        }
        if topic.owner_id.is_empty() {
            return Err(ServiceError::InvalidRequest(
                "sync pull ownerId must be non-empty".to_string(),
            ));
        }
        let identity = (
            topic.owner_type.as_str(),
            topic.owner_id.as_str(),
            topic.topic_id.as_str(),
        );
        if !identities.insert(identity) {
            return Err(ServiceError::InvalidRequest(
                "sync pull contains a duplicate topic identity".to_string(),
            ));
        }
        if topic.message_ids.len() > 10_000 {
            return Err(ServiceError::InvalidRequest(
                "sync pull topic exceeds 10000 message ids".to_string(),
            ));
        }
        let unique_ids = topic.message_ids.iter().collect::<HashSet<_>>();
        if unique_ids.len() != topic.message_ids.len() || unique_ids.iter().any(|id| id.is_empty())
        {
            return Err(ServiceError::InvalidRequest(
                "sync pull message ids must be non-empty and unique".to_string(),
            ));
        }
        message_count = message_count
            .checked_add(topic.message_ids.len())
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
    Json(topic): Json<sync::MessagesPushTopic>,
) -> ServiceResult<Json<sync::MessagesPushResult>> {
    if topic.topic_id.is_empty()
        || topic.messages.len() > 10_000
        || topic.deleted_messages.len() > 10_000
        || topic
            .messages
            .len()
            .saturating_add(topic.deleted_messages.len())
            > 10_000
    {
        return Err(ServiceError::InvalidRequest(
            "sync push topicId is required and messages are limited to 10000".to_string(),
        ));
    }
    let _guard = state.reconcile_lock.lock().await;
    let result = sync::push_topic_messages(&state.reconciler, topic).await;
    if let (Some(search), Some(commit)) = (&state.search, &result.ingest_commit) {
        search
            .apply_ingest_commit(commit)
            .map_err(ServiceError::internal)?;
    }
    Ok(Json(result))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn owner_request(
        owner_type: OwnerType,
        owner_id: &str,
        deleted_at: i64,
    ) -> EntityDeleteRequest {
        EntityDeleteRequest::Owner {
            owner_type,
            owner_id: owner_id.to_string(),
            deleted_at,
        }
    }

    #[test]
    fn entity_delete_validation_requires_exact_topic_owner() {
        assert!(
            serde_json::from_value::<EntityDeleteRequest>(serde_json::json!({
                "targetType":"topic", "topicId":"default", "deletedAt":1
            }))
            .is_err()
        );

        let (target, deleted_at) = validate_entity_delete_request(EntityDeleteRequest::Topic {
            owner_type: OwnerType::Agent,
            owner_id: "agent-a".to_string(),
            topic_id: "default".to_string(),
            deleted_at: 1,
        })
        .expect("validate exact topic owner");
        assert_eq!(deleted_at, 1);
        assert!(matches!(
            target,
            EntityDeleteTarget::Topic(TopicKey {
                owner_type: OwnerType::Agent,
                owner_id,
                topic_id,
            }) if owner_id == "agent-a" && topic_id == "default"
        ));
    }

    #[test]
    fn entity_delete_validation_rejects_unsafe_ids_and_timestamp_bounds() {
        for invalid in [
            owner_request(OwnerType::Agent, "../agent", 1),
            owner_request(OwnerType::Group, "group/a", 1),
            owner_request(OwnerType::Agent, "agent-a", -1),
            owner_request(OwnerType::Agent, "agent-a", 9_007_199_254_740_992),
        ] {
            assert!(matches!(
                validate_entity_delete_request(invalid),
                Err(ServiceError::InvalidRequest(_))
            ));
        }
    }

    #[test]
    fn entity_delete_validation_accepts_both_owner_namespaces() {
        for expected_type in [OwnerType::Agent, OwnerType::Group] {
            let (target, deleted_at) = validate_entity_delete_request(owner_request(
                expected_type,
                "owner-a",
                9_007_199_254_740_991,
            ))
            .expect("validate owner deletion");
            assert_eq!(deleted_at, 9_007_199_254_740_991);
            assert!(matches!(
                target,
                EntityDeleteTarget::Owner(owner_type, owner_id)
                    if owner_type == expected_type && owner_id == "owner-a"
            ));
        }
    }
}
