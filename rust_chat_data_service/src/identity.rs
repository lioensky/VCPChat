use serde::{Deserialize, Serialize};

use crate::{
    domain::OwnerType,
    error::{ServiceError, ServiceResult},
    storage::Database,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerSelector {
    #[serde(default = "default_agent_owner_type")]
    pub owner_type: OwnerType,
    #[serde(default)]
    pub owner_id: Option<String>,
    #[serde(default)]
    pub owner_name: Option<String>,
    /// Legacy DeepMemo parameter. For example `Nova` may uniquely match
    /// the configured display name `vcp小助手Nova`.
    #[serde(default)]
    pub maid: Option<String>,
}

fn default_agent_owner_type() -> OwnerType {
    OwnerType::Agent
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedOwner {
    pub owner_type: OwnerType,
    pub owner_id: String,
    pub display_name: String,
    pub resolution: OwnerResolution,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OwnerResolution {
    ExactId,
    ExactName,
    UniqueContains,
}

#[derive(Clone)]
pub struct IdentityResolver {
    database: Database,
}

impl IdentityResolver {
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    pub fn resolve(&self, selector: &OwnerSelector) -> ServiceResult<ResolvedOwner> {
        if let Some(owner_id) = selector.owner_id.as_deref().and_then(normalize_non_empty) {
            return self.resolve_exact_id(selector.owner_type, owner_id);
        }

        let requested_name = selector
            .owner_name
            .as_deref()
            .and_then(normalize_non_empty)
            .or_else(|| selector.maid.as_deref().and_then(normalize_non_empty))
            .ok_or_else(|| {
                ServiceError::InvalidRequest(
                    "ownerId, ownerName, or legacy maid is required".to_string(),
                )
            })?;

        let candidates = self
            .database
            .resolve_owner_ids_by_name(selector.owner_type, requested_name)
            .map_err(ServiceError::internal)?;

        match candidates.as_slice() {
            [] => Err(ServiceError::NotFound(format!(
                "{} owner matching name '{}' was not found",
                selector.owner_type, requested_name
            ))),
            [(owner_id, display_name)] => {
                let resolution = if display_name == requested_name {
                    OwnerResolution::ExactName
                } else {
                    OwnerResolution::UniqueContains
                };
                Ok(ResolvedOwner {
                    owner_type: selector.owner_type,
                    owner_id: owner_id.clone(),
                    display_name: display_name.clone(),
                    resolution,
                })
            }
            many => {
                let candidate_summary = many
                    .iter()
                    .map(|(owner_id, display_name)| format!("{display_name} ({owner_id})"))
                    .collect::<Vec<_>>()
                    .join(", ");
                Err(ServiceError::Ambiguous(format!(
                    "legacy name '{}' matched multiple {} owners: {}",
                    requested_name, selector.owner_type, candidate_summary
                )))
            }
        }
    }

    fn resolve_exact_id(
        &self,
        owner_type: OwnerType,
        owner_id: &str,
    ) -> ServiceResult<ResolvedOwner> {
        let candidate = self
            .database
            .owner_by_id(owner_type, owner_id)
            .map_err(ServiceError::internal)?
            .ok_or_else(|| {
                ServiceError::NotFound(format!("{owner_type} owner '{owner_id}' was not found"))
            })?;

        Ok(ResolvedOwner {
            owner_type,
            owner_id: candidate.0,
            display_name: candidate.1,
            resolution: OwnerResolution::ExactId,
        })
    }
}

fn normalize_non_empty(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}
