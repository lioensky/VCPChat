use serde::{Deserialize, Serialize};
use log::info;
use std::collections::VecDeque;
use std::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LatencySample {
    pub timestamp: u64,
    pub latency_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerformanceMetrics {
    pub selection_count: u64,
    pub avg_latency_ms: f64,
    pub p50_latency_ms: u64,
    pub p99_latency_ms: u64,
    pub error_count: u64,
    pub errors: Vec<ErrorRecord>,
    pub cpu_avg_percent: f32,
    pub memory_avg_mb: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorRecord {
    pub error_code: String,
    pub message: String,
    pub timestamp: u64,
    pub count: u64,
}

pub struct MetricsCollector {
    latency_samples: VecDeque<LatencySample>,
    selection_count: u64,
    error_counts: std::collections::HashMap<String, ErrorRecord>,
    start_time: u64,
    max_samples: usize,
}

impl MetricsCollector {
    /// 创建新的指标收集器
    pub fn new() -> Self {
        use std::time::{SystemTime, UNIX_EPOCH};
        
        let start_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        Self {
            latency_samples: VecDeque::with_capacity(1000),
            selection_count: 0,
            error_counts: std::collections::HashMap::new(),
            start_time,
            max_samples: 1000,
        }
    }

    /// 记录一个选择事件的延迟
    pub fn record_latency(&mut self, latency_ms: u64) {
        use std::time::{SystemTime, UNIX_EPOCH};
        
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        self.latency_samples.push_back(LatencySample {
            timestamp,
            latency_ms,
        });

        self.selection_count += 1;

        // 维护最大样本数
        while self.latency_samples.len() > self.max_samples {
            self.latency_samples.pop_front();
        }

        if self.selection_count % 50 == 0 {
            info!(
                "[MetricsCollector] Recorded latency: {}ms (total selections: {})",
                latency_ms, self.selection_count
            );
        }
    }

    /// 记录一个错误事件
    pub fn record_error(&mut self, error_code: &str, message: &str) {
        use std::time::{SystemTime, UNIX_EPOCH};
        
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        self.error_counts
            .entry(error_code.to_string())
            .and_modify(|record| {
                record.count += 1;
                record.message = message.to_string();
            })
            .or_insert_with(|| ErrorRecord {
                error_code: error_code.to_string(),
                message: message.to_string(),
                timestamp,
                count: 1,
            });

        info!("[MetricsCollector] Error recorded: {} - {}", error_code, message);
    }

    /// 计算百分位数
    fn calculate_percentile(&self, percentile: f32) -> u64 {
        if self.latency_samples.is_empty() {
            return 0;
        }

        let mut sorted: Vec<u64> = self.latency_samples
            .iter()
            .map(|s| s.latency_ms)
            .collect();
        sorted.sort_unstable();

        let index = ((percentile / 100.0) * sorted.len() as f32) as usize;
        let index = index.min(sorted.len() - 1);
        sorted[index]
    }

    /// 获取平均延迟
    fn calculate_average(&self) -> f64 {
        if self.latency_samples.is_empty() {
            return 0.0;
        }

        let sum: u64 = self.latency_samples.iter().map(|s| s.latency_ms).sum();
        sum as f64 / self.latency_samples.len() as f64
    }

    /// 导出性能报告
    pub fn export_report(&self) -> PerformanceMetrics {
        let errors: Vec<ErrorRecord> = self.error_counts
            .values()
            .cloned()
            .collect();
        
        let error_count: u64 = errors.iter().map(|e| e.count).sum();

        PerformanceMetrics {
            selection_count: self.selection_count,
            avg_latency_ms: self.calculate_average(),
            p50_latency_ms: self.calculate_percentile(50.0),
            p99_latency_ms: self.calculate_percentile(99.0),
            error_count,
            errors,
            cpu_avg_percent: 0.0,  // TODO: 集成系统 CPU 监控
            memory_avg_mb: 0.0,    // TODO: 集成系统内存监控
        }
    }

    /// 导出为JSON字符串
    pub fn export_json(&self) -> Result<String, String> {
        let report = self.export_report();
        serde_json::to_string_pretty(&report)
            .map_err(|e| format!("JSON serialization failed: {}", e))
    }

    /// 清空所有指标
    pub fn reset(&mut self) {
        self.latency_samples.clear();
        self.selection_count = 0;
        self.error_counts.clear();
        
        use std::time::{SystemTime, UNIX_EPOCH};
        self.start_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        
        info!("[MetricsCollector] Metrics reset");
    }

    /// 获取运行时间（毫秒）
    pub fn uptime_ms(&self) -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        
        now.saturating_sub(self.start_time)
    }

    /// 获取事件吞吐量（每小时事件数）
    pub fn events_per_hour(&self) -> f64 {
        let uptime_hours = self.uptime_ms() as f64 / 3_600_000.0;
        if uptime_hours < 0.001 {
            0.0
        } else {
            self.selection_count as f64 / uptime_hours
        }
    }

    /// 样本数
    pub fn sample_count(&self) -> usize {
        self.latency_samples.len()
    }
}

impl Default for MetricsCollector {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_metrics_creation() {
        let metrics = MetricsCollector::new();
        assert_eq!(metrics.selection_count, 0);
        assert_eq!(metrics.sample_count(), 0);
    }

    #[test]
    fn test_record_latency() {
        let mut metrics = MetricsCollector::new();
        
        metrics.record_latency(100);
        metrics.record_latency(200);
        metrics.record_latency(300);

        assert_eq!(metrics.selection_count, 3);
        assert_eq!(metrics.sample_count(), 3);

        let report = metrics.export_report();
        assert_eq!(report.selection_count, 3);
        assert!(report.avg_latency_ms > 100.0 && report.avg_latency_ms < 300.0);
    }

    #[test]
    fn test_percentile_calculation() {
        let mut metrics = MetricsCollector::new();
        
        for i in 1..=100 {
            metrics.record_latency(i);
        }

        let p50 = metrics.calculate_percentile(50.0);
        let p99 = metrics.calculate_percentile(99.0);

        assert!(p50 > 0 && p50 <= 100);
        assert!(p99 > p50 && p99 <= 100);
    }

    #[test]
    fn test_error_recording() {
        let mut metrics = MetricsCollector::new();
        
        metrics.record_error("clipboard_error", "Failed to read clipboard");
        metrics.record_error("clipboard_error", "Failed to read clipboard");
        metrics.record_error("window_error", "Could not get active window");

        let report = metrics.export_report();
        assert_eq!(report.error_count, 3);
        assert!(report.errors.len() >= 2);
    }

    #[test]
    fn test_export_json() {
        let mut metrics = MetricsCollector::new();
        
        metrics.record_latency(150);
        metrics.record_error("test_error", "Test error message");

        let json = metrics.export_json().unwrap();
        assert!(json.contains("selection_count"));
        assert!(json.contains("test_error"));
    }

    #[test]
    fn test_reset() {
        let mut metrics = MetricsCollector::new();
        
        metrics.record_latency(100);
        metrics.record_error("error", "message");

        assert!(metrics.selection_count > 0);

        metrics.reset();
        assert_eq!(metrics.selection_count, 0);
        assert_eq!(metrics.sample_count(), 0);
    }

    #[test]
    fn test_throughput_calculation() {
        let metrics = MetricsCollector::new();
        let throughput = metrics.events_per_hour();
        assert!(throughput >= 0.0);
    }
}
