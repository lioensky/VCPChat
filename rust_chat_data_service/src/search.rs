use std::{collections::HashMap, fs, path::Path, sync::Arc};

use anyhow::{Context, Result};
use jieba_rs::Jieba;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tantivy::{
    collector::TopDocs,
    doc,
    query::{BooleanQuery, Occur, Query, QueryParser, TermQuery},
    schema::{
        Field, IndexRecordOption, NumericOptions, Schema, TextFieldIndexing, TextOptions, Value,
        FAST, INDEXED, STORED, STRING,
    },
    tokenizer::{LowerCaser, RemoveLongFilter, TextAnalyzer, Token, TokenStream, Tokenizer},
    Index, IndexReader, IndexWriter, ReloadPolicy, TantivyDocument, Term,
};

use crate::{
    domain::{MemoryWindow, MessageView, OwnerType, SearchHit, TopicKey},
    storage::Database,
};

const JIEBA_TOKENIZER: &str = "vcp_jieba";

#[derive(Clone)]
struct JiebaTokenizer {
    jieba: Arc<Jieba>,
}

struct JiebaTokenStream {
    tokens: Vec<Token>,
    cursor: usize,
}

impl Tokenizer for JiebaTokenizer {
    type TokenStream<'a> = JiebaTokenStream;

    fn token_stream<'a>(&mut self, text: &'a str) -> Self::TokenStream<'a> {
        let mut tokens = Vec::new();
        let mut search_from = 0;
        for word in self.jieba.cut(text, false) {
            if word.trim().is_empty() {
                continue;
            }
            let relative = text[search_from..].find(word).unwrap_or(0);
            let start = search_from + relative;
            let end = start + word.len();
            tokens.push(Token {
                offset_from: start,
                offset_to: end,
                position: tokens.len(),
                text: word.to_lowercase(),
                position_length: 1,
            });
            search_from = end.min(text.len());
        }
        JiebaTokenStream { tokens, cursor: 0 }
    }
}

impl TokenStream for JiebaTokenStream {
    fn advance(&mut self) -> bool {
        if self.cursor >= self.tokens.len() {
            return false;
        }
        self.cursor += 1;
        true
    }

    fn token(&self) -> &Token {
        &self.tokens[self.cursor - 1]
    }

    fn token_mut(&mut self) -> &mut Token {
        &mut self.tokens[self.cursor - 1]
    }
}

#[derive(Debug, Clone)]
struct SearchFields {
    row_id: Field,
    owner_type: Field,
    owner_id: Field,
    topic_id: Field,
    msg_id: Field,
    ordinal: Field,
    timestamp: Field,
    role: Field,
    speaker_name: Field,
    content: Field,
    message_hash: Field,
}

impl SearchFields {
    fn from_schema(schema: &Schema) -> Result<Self> {
        let field = |name| {
            schema
                .get_field(name)
                .with_context(|| format!("search schema is missing field {name}"))
        };
        Ok(Self {
            row_id: field("row_id")?,
            owner_type: field("owner_type")?,
            owner_id: field("owner_id")?,
            topic_id: field("topic_id")?,
            msg_id: field("msg_id")?,
            ordinal: field("ordinal")?,
            timestamp: field("timestamp")?,
            role: field("role")?,
            speaker_name: field("speaker_name")?,
            content: field("content")?,
            message_hash: field("message_hash")?,
        })
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSearchRequest {
    pub query: String,
    pub owner_type: OwnerType,
    pub owner_id: String,
    #[serde(default)]
    pub topic_id: Option<String>,
    #[serde(default)]
    pub exclude_topic_id: Option<String>,
    #[serde(default = "default_candidate_limit")]
    pub limit: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchRequest {
    pub query: String,
    pub owner_type: OwnerType,
    pub owner_id: String,
    #[serde(default)]
    pub current_topic_id: Option<String>,
    #[serde(default)]
    pub exclude_current_topic: bool,
    #[serde(default = "default_window")]
    pub window_before: i64,
    #[serde(default = "default_window")]
    pub window_after: i64,
    #[serde(default = "default_candidate_limit")]
    pub candidate_limit: usize,
    #[serde(default = "default_result_limit")]
    pub result_limit: usize,
    #[serde(default = "default_max_chars")]
    pub max_chars: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchStatus {
    pub available: bool,
    pub rebuilding: bool,
}

fn default_candidate_limit() -> usize {
    50
}

fn default_result_limit() -> usize {
    8
}

fn default_window() -> i64 {
    6
}

fn default_max_chars() -> usize {
    60_000
}

#[derive(Clone)]
pub struct SearchIndex {
    index: Index,
    reader: IndexReader,
    writer: Arc<Mutex<IndexWriter>>,
    fields: SearchFields,
    database: Database,
    rebuilding: Arc<std::sync::atomic::AtomicBool>,
    needs_full_rebuild: Arc<std::sync::atomic::AtomicBool>,
}

impl SearchIndex {
    pub fn open(directory: &Path, database: Database) -> Result<Self> {
        fs::create_dir_all(directory)
            .with_context(|| format!("failed to create index directory {}", directory.display()))?;

        let schema = build_schema();
        let index_existed = directory.join("meta.json").exists();
        let index = if index_existed {
            Index::open_in_dir(directory)
                .with_context(|| format!("failed to open index {}", directory.display()))?
        } else {
            Index::create_in_dir(directory, schema.clone())
                .with_context(|| format!("failed to create index {}", directory.display()))?
        };

        let tokenizer = TextAnalyzer::builder(JiebaTokenizer {
            jieba: Arc::new(Jieba::new()),
        })
        .filter(RemoveLongFilter::limit(256))
        .filter(LowerCaser)
        .build();
        index.tokenizers().register(JIEBA_TOKENIZER, tokenizer);

        let fields = SearchFields::from_schema(&index.schema())?;
        let writer = index.writer(50_000_000)?;
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()?;

        Ok(Self {
            index,
            reader,
            writer: Arc::new(Mutex::new(writer)),
            fields,
            database,
            rebuilding: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            needs_full_rebuild: Arc::new(std::sync::atomic::AtomicBool::new(!index_existed)),
        })
    }

    pub fn status(&self) -> SearchStatus {
        SearchStatus {
            available: true,
            rebuilding: self.rebuilding.load(std::sync::atomic::Ordering::Relaxed),
        }
    }

    pub fn update_topic(&self, key: &TopicKey, revision: i64) -> Result<()> {
        let messages = self.database.active_messages_for_topic(key)?;
        let mut writer = self.writer.lock();
        let topic_term = composite_topic_term(&self.fields, key);
        writer.delete_term(topic_term);

        for message in messages {
            writer.add_document(self.message_document(&message))?;
        }
        writer.commit()?;
        drop(writer);
        self.reader.reload()?;
        self.database.mark_topic_indexed(key, revision)?;
        Ok(())
    }

    pub fn reconcile_revisions(&self) -> Result<usize> {
        let full_rebuild = self
            .needs_full_rebuild
            .swap(false, std::sync::atomic::Ordering::AcqRel);
        let pending = if full_rebuild {
            self.database.all_active_topic_revisions()?
        } else {
            self.database.topics_needing_index()?
        };
        let count = pending.len();
        for (key, revision) in pending {
            if let Err(error) = self.update_topic(&key, revision) {
                if full_rebuild {
                    self.needs_full_rebuild
                        .store(true, std::sync::atomic::Ordering::Release);
                }
                return Err(error);
            }
        }
        Ok(count)
    }

    pub fn rebuild(&self) -> Result<usize> {
        if self
            .rebuilding
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            anyhow::bail!("search index rebuild is already running");
        }

        let result = (|| {
            let mut writer = self.writer.lock();
            writer.delete_all_documents()?;
            writer.commit()?;
            drop(writer);

            let topics = self.database.all_active_topic_revisions()?;
            let mut rebuilt = 0;
            for (key, revision) in topics {
                self.update_topic(&key, revision)?;
                rebuilt += 1;
            }
            self.needs_full_rebuild
                .store(false, std::sync::atomic::Ordering::Release);
            Ok(rebuilt)
        })();

        self.rebuilding
            .store(false, std::sync::atomic::Ordering::SeqCst);
        result
    }

    pub fn search_messages(&self, request: &MessageSearchRequest) -> Result<Vec<SearchHit>> {
        let limit = request.limit.clamp(1, 500);
        let searcher = self.reader.searcher();
        let query = self.build_scoped_query(
            &request.query,
            request.owner_type,
            &request.owner_id,
            request.topic_id.as_deref(),
            request.exclude_topic_id.as_deref(),
        )?;

        let docs = searcher.search(&query, &TopDocs::with_limit(limit))?;
        let mut scores = HashMap::new();
        let mut row_ids = Vec::with_capacity(docs.len());
        for (score, address) in docs {
            let document: TantivyDocument = searcher.doc(address)?;
            if let Some(row_id) = document
                .get_first(self.fields.row_id)
                .and_then(|value| value.as_u64())
            {
                let row_id = row_id as i64;
                scores.insert(row_id, score);
                row_ids.push(row_id);
            }
        }

        let messages = self.database.messages_by_row_ids(&row_ids)?;
        Ok(row_ids
            .into_iter()
            .filter_map(|row_id| {
                Some(SearchHit {
                    message: messages.get(&row_id)?.clone(),
                    score: *scores.get(&row_id)?,
                })
            })
            .collect())
    }

    pub fn search_memories(&self, request: &MemorySearchRequest) -> Result<Vec<MemoryWindow>> {
        let message_request = MessageSearchRequest {
            query: request.query.clone(),
            owner_type: request.owner_type,
            owner_id: request.owner_id.clone(),
            topic_id: None,
            exclude_topic_id: if request.exclude_current_topic {
                request.current_topic_id.clone()
            } else {
                None
            },
            limit: request.candidate_limit.clamp(1, 500),
        };
        let hits = self.search_messages(&message_request)?;
        let before = request.window_before.clamp(0, 100);
        let after = request.window_after.clamp(0, 100);

        #[derive(Clone)]
        struct Range {
            start: i64,
            end: i64,
            score: f32,
        }

        let mut grouped: HashMap<TopicKey, Vec<Range>> = HashMap::new();
        for hit in hits {
            let key = TopicKey {
                owner_type: hit.message.owner_type,
                owner_id: hit.message.owner_id.clone(),
                topic_id: hit.message.topic_id.clone(),
            };
            grouped.entry(key).or_default().push(Range {
                start: (hit.message.ordinal - before).max(0),
                end: hit.message.ordinal + after,
                score: hit.score,
            });
        }

        let mut windows = Vec::new();
        for (key, mut ranges) in grouped {
            ranges.sort_by_key(|range| range.start);
            let mut merged: Vec<Range> = Vec::new();
            for range in ranges {
                if let Some(last) = merged.last_mut() {
                    if range.start <= last.end + 1 {
                        last.end = last.end.max(range.end);
                        last.score = last.score.max(range.score);
                        continue;
                    }
                }
                merged.push(range);
            }

            let topic_name = self.database.topic_name(&key)?;
            for range in merged {
                let messages = self
                    .database
                    .context_messages(&key, range.start, range.end)?;
                if messages.is_empty() {
                    continue;
                }
                windows.push(MemoryWindow {
                    owner_type: key.owner_type,
                    owner_id: key.owner_id.clone(),
                    topic_id: key.topic_id.clone(),
                    topic_name: topic_name.clone(),
                    start_ordinal: range.start,
                    end_ordinal: range.end,
                    score: range.score,
                    messages,
                });
            }
        }

        windows.sort_by(|left, right| {
            right
                .score
                .partial_cmp(&left.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        let mut total_chars = 0;
        let mut selected = Vec::new();
        for window in windows.into_iter().take(request.result_limit.clamp(1, 100)) {
            let chars: usize = window
                .messages
                .iter()
                .map(|message| message.content_text.chars().count())
                .sum();
            if !selected.is_empty() && total_chars + chars > request.max_chars {
                break;
            }
            total_chars += chars;
            selected.push(window);
        }
        Ok(selected)
    }

    fn message_document(&self, message: &MessageView) -> TantivyDocument {
        let mut document = doc!(
            self.fields.row_id => message.row_id as u64,
            self.fields.owner_type => message.owner_type.as_str(),
            self.fields.owner_id => message.owner_id.clone(),
            self.fields.topic_id => message.topic_id.clone(),
            self.fields.msg_id => message.msg_id.clone(),
            self.fields.ordinal => message.ordinal as u64,
            self.fields.role => message.role.clone(),
            self.fields.content => message.content_text.clone(),
        );
        if let Some(timestamp) = message.timestamp {
            document.add_i64(self.fields.timestamp, timestamp);
        }
        if let Some(speaker_name) = &message.speaker_name {
            document.add_text(self.fields.speaker_name, speaker_name);
        }
        let hash = blake3::hash(message.content_raw.as_bytes())
            .to_hex()
            .to_string();
        document.add_text(self.fields.message_hash, hash);
        document.add_text(
            self.fields.message_hash,
            composite_topic_value(message.owner_type, &message.owner_id, &message.topic_id),
        );
        document
    }

    fn build_scoped_query(
        &self,
        query_text: &str,
        owner_type: OwnerType,
        owner_id: &str,
        topic_id: Option<&str>,
        exclude_topic_id: Option<&str>,
    ) -> Result<Box<dyn Query>> {
        if query_text.trim().is_empty() {
            anyhow::bail!("search query cannot be empty");
        }
        let parser = QueryParser::for_index(
            &self.index,
            vec![self.fields.content, self.fields.speaker_name],
        );
        let content_query = parser
            .parse_query(&normalize_query_syntax(query_text))
            .context("invalid search query")?;

        let mut clauses: Vec<(Occur, Box<dyn Query>)> = vec![
            (Occur::Must, content_query),
            (
                Occur::Must,
                exact_term_query(self.fields.owner_type, owner_type.as_str()),
            ),
            (
                Occur::Must,
                exact_term_query(self.fields.owner_id, owner_id),
            ),
        ];
        if let Some(topic_id) = topic_id {
            clauses.push((
                Occur::Must,
                exact_term_query(self.fields.topic_id, topic_id),
            ));
        }
        if let Some(topic_id) = exclude_topic_id {
            clauses.push((
                Occur::MustNot,
                exact_term_query(self.fields.topic_id, topic_id),
            ));
        }
        Ok(Box::new(BooleanQuery::new(clauses)))
    }
}

fn build_schema() -> Schema {
    let mut builder = Schema::builder();
    let string = STRING | STORED;
    let numeric = NumericOptions::default()
        .set_indexed()
        .set_stored()
        .set_fast();
    let text_indexing = TextFieldIndexing::default()
        .set_tokenizer(JIEBA_TOKENIZER)
        .set_index_option(IndexRecordOption::WithFreqsAndPositions);
    let text = TextOptions::default()
        .set_indexing_options(text_indexing)
        .set_stored();

    builder.add_u64_field("row_id", numeric.clone());
    builder.add_text_field("owner_type", string.clone());
    builder.add_text_field("owner_id", string.clone());
    builder.add_text_field("topic_id", string.clone());
    builder.add_text_field("msg_id", string.clone());
    builder.add_u64_field("ordinal", STORED | INDEXED);
    builder.add_i64_field("timestamp", FAST | INDEXED);
    builder.add_text_field("role", string.clone());
    builder.add_text_field("speaker_name", text.clone());
    builder.add_text_field("content", text);
    builder.add_text_field("message_hash", STRING);
    builder.build()
}

fn exact_term_query(field: Field, value: &str) -> Box<dyn Query> {
    Box::new(TermQuery::new(
        Term::from_field_text(field, value),
        IndexRecordOption::Basic,
    ))
}

fn composite_topic_term(fields: &SearchFields, key: &TopicKey) -> Term {
    Term::from_field_text(
        fields.message_hash,
        &composite_topic_value(key.owner_type, &key.owner_id, &key.topic_id),
    )
}

fn composite_topic_value(owner_type: OwnerType, owner_id: &str, topic_id: &str) -> String {
    format!(
        "__topic__\u{1f}{}\u{1f}{}\u{1f}{}",
        owner_type.as_str(),
        owner_id,
        topic_id
    )
}

fn normalize_query_syntax(query: &str) -> String {
    query
        .split([',', '，'])
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| {
            if let Some(inner) = part.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
                let term = inner.split(':').next().unwrap_or_default().trim();
                return format!("-{term}");
            }
            if let Some(inner) = part.strip_prefix('{').and_then(|v| v.strip_suffix('}')) {
                let (terms, weight) = match inner.rsplit_once(':') {
                    Some((terms, weight)) if weight.trim().parse::<f32>().is_ok() => {
                        (terms, Some(weight.trim()))
                    }
                    _ => (inner, None),
                };
                let group = format!(
                    "({})",
                    terms
                        .split('|')
                        .map(str::trim)
                        .filter(|term| !term.is_empty())
                        .collect::<Vec<_>>()
                        .join(" OR ")
                );
                return weight
                    .map(|weight| format!("{group}^{weight}"))
                    .unwrap_or(group);
            }
            if let Some(inner) = part.strip_prefix('(').and_then(|v| v.strip_suffix(')')) {
                if let Some((term, weight)) = inner.rsplit_once(':') {
                    if weight.trim().parse::<f32>().is_ok() {
                        return format!("{}^{}", term.trim(), weight.trim());
                    }
                }
            }
            part.to_string()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::normalize_query_syntax;

    #[test]
    fn converts_legacy_deepmemo_query_syntax() {
        assert_eq!(
            normalize_query_syntax("VCP,[闲聊],{bug|修复:1.3},(代码:1.1)"),
            "VCP -闲聊 (bug OR 修复)^1.3 代码^1.1"
        );
    }
}
