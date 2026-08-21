use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ServiceError {
    #[error("invalid request: {0}")]
    InvalidRequest(String),

    #[error("authentication failed")]
    Unauthorized,

    #[error("entity not found: {0}")]
    NotFound(String),

    #[error("ambiguous identity: {0}")]
    Ambiguous(String),

    #[error("search is unavailable: {0}")]
    SearchUnavailable(String),

    #[error("service is busy")]
    Busy,

    #[error("internal service error")]
    Internal(#[source] anyhow::Error),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    error: ErrorDetail,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorDetail {
    code: &'static str,
    message: String,
    retryable: bool,
}

impl ServiceError {
    pub fn internal(error: impl Into<anyhow::Error>) -> Self {
        Self::Internal(error.into())
    }

    fn response_parts(&self) -> (StatusCode, &'static str, bool, String) {
        match self {
            Self::InvalidRequest(message) => (
                StatusCode::BAD_REQUEST,
                "INVALID_REQUEST",
                false,
                message.clone(),
            ),
            Self::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "UNAUTHORIZED",
                false,
                "authentication failed".to_string(),
            ),
            Self::NotFound(message) => (StatusCode::NOT_FOUND, "NOT_FOUND", false, message.clone()),
            Self::Ambiguous(message) => (
                StatusCode::CONFLICT,
                "AMBIGUOUS_IDENTITY",
                false,
                message.clone(),
            ),
            Self::SearchUnavailable(message) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "SEARCH_UNAVAILABLE",
                true,
                message.clone(),
            ),
            Self::Busy => (
                StatusCode::TOO_MANY_REQUESTS,
                "SERVICE_BUSY",
                true,
                "service is busy".to_string(),
            ),
            Self::Internal(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL_ERROR",
                true,
                "internal service error".to_string(),
            ),
        }
    }
}

impl IntoResponse for ServiceError {
    fn into_response(self) -> Response {
        if let Self::Internal(error) = &self {
            tracing::error!(error = ?error, "request failed with internal error");
        }

        let (status, code, retryable, message) = self.response_parts();
        (
            status,
            Json(ErrorBody {
                error: ErrorDetail {
                    code,
                    message,
                    retryable,
                },
            }),
        )
            .into_response()
    }
}

impl From<anyhow::Error> for ServiceError {
    fn from(value: anyhow::Error) -> Self {
        Self::Internal(value)
    }
}

impl From<rusqlite::Error> for ServiceError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Internal(value.into())
    }
}

impl From<tantivy::TantivyError> for ServiceError {
    fn from(value: tantivy::TantivyError) -> Self {
        Self::Internal(value.into())
    }
}

pub type ServiceResult<T> = Result<T, ServiceError>;
