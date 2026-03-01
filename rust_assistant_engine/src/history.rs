use std::collections::VecDeque;
use serde::{Deserialize, Serialize};
use log::info;
use crate::capture::SelectionRecord;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectionContext {
    pub recent_selections: Vec<SelectionRecord>,
    pub window_history: Vec<String>,
    pub context_size: usize,
    pub retention_ms: u64,
}

pub struct SelectionHistory {
    records: VecDeque<SelectionRecord>,
    max_records: usize,
    window_history: VecDeque<String>,
    max_windows: usize,
}

impl SelectionHistory {
    /// 创建新的历史记录管理器
    /// max_records: 最多保留的记录数（默认 100）
    pub fn new(max_records: usize) -> Self {
        Self {
            records: VecDeque::with_capacity(max_records),
            max_records,
            window_history: VecDeque::with_capacity(20),
            max_windows: 20,
        }
    }

    /// 添加新的选择记录
    pub fn push(&mut self, record: SelectionRecord) {
        // 防止重复：检查最后一条记录是否相同
        if let Some(last) = self.records.back() {
            if last.text == record.text && last.window_title == record.window_title {
                // 时间间隔太短，跳过
                let time_diff = record.timestamp.saturating_sub(last.timestamp);
                if time_diff < 500 {
                    return;
                }
            }
        }

        self.records.push_back(record.clone());

        // 维护最大容量
        while self.records.len() > self.max_records {
            self.records.pop_front();
        }

        // 更新窗口历史
        let window = record.window_title.clone();
        if !self.window_history.contains(&window) {
            self.window_history.push_back(window);
            while self.window_history.len() > self.max_windows {
                self.window_history.pop_front();
            }
        }

        info!("[SelectionHistory] Added record, total: {}", self.records.len());
    }

    /// 获取最近 N 条记录
    pub fn get_recent(&self, count: usize) -> Vec<SelectionRecord> {
        self.records
            .iter()
            .rev()
            .take(count)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    }

    /// 获取时间范围内的记录
    pub fn get_in_time_range(&self, start_ms: u64, end_ms: u64) -> Vec<SelectionRecord> {
        self.records
            .iter()
            .filter(|r| r.timestamp >= start_ms && r.timestamp <= end_ms)
            .cloned()
            .collect()
    }

    /// 获取特定窗口的选择历史
    pub fn get_by_window(&self, window_title: &str) -> Vec<SelectionRecord> {
        self.records
            .iter()
            .filter(|r| r.window_title == window_title)
            .cloned()
            .collect()
    }

    /// 搜索包含关键词的记录
    pub fn search(&self, keyword: &str) -> Vec<SelectionRecord> {
        let keyword_lower = keyword.to_lowercase();
        self.records
            .iter()
            .filter(|r| r.text.to_lowercase().contains(&keyword_lower))
            .cloned()
            .collect()
    }

    /// 导出整个历史为 JSON 字符串
    pub fn export_json(&self) -> Result<String, String> {
        let records: Vec<_> = self.records.iter().cloned().collect();
        serde_json::to_string(&records)
            .map_err(|e| format!("JSON serialization failed: {}", e))
    }

    /// 导出为CSV格式
    pub fn export_csv(&self) -> String {
        let mut csv = String::from("timestamp,window_title,text,mouse_x,mouse_y\n");
        
        for record in self.records.iter() {
            let text = record.text.replace("\"", "\"\"");
            let text_escaped = format!("\"{}\"", text);
            
            csv.push_str(&format!(
                "{},{},{},{},{}\n",
                record.timestamp,
                record.window_title,
                text_escaped,
                record.mouse_x,
                record.mouse_y
            ));
        }

        csv
    }

    /// 清空历史记录
    pub fn clear(&mut self) {
        self.records.clear();
        self.window_history.clear();
        info!("[SelectionHistory] History cleared");
    }

    /// 获取历史统计信息
    pub fn get_stats(&self) -> SelectionContext {
        let mut unique_windows = Vec::new();
        for record in self.records.iter() {
            if !unique_windows.contains(&record.window_title) {
                unique_windows.push(record.window_title.clone());
            }
        }

        SelectionContext {
            recent_selections: self.get_recent(10),
            window_history: unique_windows,
            context_size: self.records.len(),
            retention_ms: 30_000, // 30 秒滑动窗口
        }
    }

    /// 获取最活跃的窗口
    pub fn get_most_active_window(&self) -> Option<String> {
        let mut window_counts: std::collections::HashMap<String, usize> = 
            std::collections::HashMap::new();

        for record in self.records.iter() {
            *window_counts.entry(record.window_title.clone()).or_insert(0) += 1;
        }

        window_counts
            .into_iter()
            .max_by_key(|entry| entry.1)
            .map(|entry| entry.0)
    }

    /// 获取当前大小
    pub fn len(&self) -> usize {
        self.records.len()
    }

    /// 是否为空
    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_history_creation() {
        let history = SelectionHistory::new(50);
        assert_eq!(history.len(), 0);
        assert!(history.is_empty());
    }

    #[test]
    fn test_push_and_retrieve() {
        let mut history = SelectionHistory::new(50);
        
        let record = SelectionRecord {
            text: "Hello, Rust!".to_string(),
            window_title: "Test Window".to_string(),
            timestamp: 1000,
            mouse_x: 100,
            mouse_y: 200,
        };

        history.push(record);
        assert_eq!(history.len(), 1);

        let recent = history.get_recent(1);
        assert_eq!(recent[0].text, "Hello, Rust!");
    }

    #[test]
    fn test_search() {
        let mut history = SelectionHistory::new(50);
        
        history.push(SelectionRecord {
            text: "Rust is great".to_string(),
            window_title: "Window1".to_string(),
            timestamp: 1000,
            mouse_x: 0,
            mouse_y: 0,
        });

        history.push(SelectionRecord {
            text: "Python is nice".to_string(),
            window_title: "Window2".to_string(),
            timestamp: 2000,
            mouse_x: 0,
            mouse_y: 0,
        });

        let results = history.search("Rust");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].text, "Rust is great");
    }

    #[test]
    fn test_get_by_window() {
        let mut history = SelectionHistory::new(50);
        
        history.push(SelectionRecord {
            text: "Text1".to_string(),
            window_title: "Chrome".to_string(),
            timestamp: 1000,
            mouse_x: 0,
            mouse_y: 0,
        });

        history.push(SelectionRecord {
            text: "Text2".to_string(),
            window_title: "VSCode".to_string(),
            timestamp: 2000,
            mouse_x: 0,
            mouse_y: 0,
        });

        let chrome_records = history.get_by_window("Chrome");
        assert_eq!(chrome_records.len(), 1);
        assert_eq!(chrome_records[0].text, "Text1");
    }

    #[test]
    fn test_capacity_limit() {
        let mut history = SelectionHistory::new(5);
        
        for i in 0..10 {
            history.push(SelectionRecord {
                text: format!("Text{}", i),
                window_title: "Window".to_string(),
                timestamp: 1000 + i as u64,
                mouse_x: 0,
                mouse_y: 0,
            });
        }

        assert_eq!(history.len(), 5);
        
        // 检查是否保留的是最后的 5 条
        let recent = history.get_recent(1);
        assert_eq!(recent[0].text, "Text9");
    }

    #[test]
    fn test_export_json() {
        let mut history = SelectionHistory::new(50);
        
        history.push(SelectionRecord {
            text: "Test".to_string(),
            window_title: "Window".to_string(),
            timestamp: 1000,
            mouse_x: 100,
            mouse_y: 200,
        });

        let json = history.export_json().unwrap();
        assert!(json.contains("Test"));
        assert!(json.contains("Window"));
    }
}
