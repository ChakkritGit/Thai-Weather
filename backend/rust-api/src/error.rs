use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

pub struct ApiError(pub StatusCode, pub Value);

impl ApiError {
    pub fn detail(status: StatusCode, detail: impl Into<String>) -> Self {
        Self(status, json!({"detail": detail.into()}))
    }

    pub fn invalid(name: &str, message: &str) -> Self {
        Self(
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({"detail": [{
                "type": "value_error", "loc": ["query", name], "msg": message
            }]}),
        )
    }

    pub fn unavailable() -> Self {
        Self::detail(
            StatusCode::SERVICE_UNAVAILABLE,
            "numerical service unavailable",
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(self.1)).into_response()
    }
}

pub type ApiResult = Result<Response, ApiError>;
