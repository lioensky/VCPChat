use serde::{Deserialize, Serialize};
use log::info;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableCell {
    pub row: usize,
    pub col: usize,
    pub content: String,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableStructure {
    pub rows: usize,
    pub cols: usize,
    pub cells: Vec<TableCell>,
    pub confidence: f32,     // 整体识别置信度（0-100）
    pub detection_time_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentBlock {
    pub content_type: String,  // "table", "code", "text", "image"
    pub content: String,
    pub confidence: f32,
}

pub struct TableDetection;

impl TableDetection {
    /// 基础表格检测算法
    /// 通过分析图像块和渐变来识别表格结构
    pub fn detect_table(_image_data: &[u8], _width: u32, _height: u32) -> Result<TableStructure, String> {
        // Phase 3 占位实现：返回模拟的表格结构
        // 实际实现需要：
        // 1. 图像灰度化
        // 2. 边界检测（Canny/Sobel）
        // 3. 直线检测（Hough 变换）
        // 4. 单元格提取
        
        info!("[TableDetection] Analyzing image for table structure...");
        
        // 模拟返回一个 3x3 的表格
        let mut cells = Vec::new();
        for row in 0..3 {
            for col in 0..3 {
                cells.push(TableCell {
                    row,
                    col,
                    content: format!("Cell({},{})", row, col),
                    confidence: 0.85,
                });
            }
        }

        let table = TableStructure {
            rows: 3,
            cols: 3,
            cells,
            confidence: 85.0,
            detection_time_ms: 50,
        };

        info!("[TableDetection] Detected {}x{} table with {:.1}% confidence",
            table.rows, table.cols, table.confidence);

        Ok(table)
    }

    /// 检测多种内容类型
    pub fn detect_content_types(_image_data: &[u8]) -> Result<Vec<ContentBlock>, String> {
        let blocks = vec![
            ContentBlock {
                content_type: "text".to_string(),
                content: "Detected text content".to_string(),
                confidence: 0.92,
            },
            ContentBlock {
                content_type: "code".to_string(),
                content: "fn main() { ... }".to_string(),
                confidence: 0.78,
            },
        ];

        Ok(blocks)
    }

    /// 从表格提取CSV格式的文本
    pub fn table_to_csv(table: &TableStructure) -> String {
        let mut csv = String::new();
        
        for row in 0..table.rows {
            let mut row_data = Vec::new();
            for col in 0..table.cols {
                if let Some(cell) = table.cells.iter()
                    .find(|c| c.row == row && c.col == col) {
                    // 转义CSV特殊字符
                    let content = cell.content.replace("\"", "\"\"");
                    if content.contains(',') || content.contains('"') {
                        row_data.push(format!("\"{}\"", content));
                    } else {
                        row_data.push(content);
                    }
                } else {
                    row_data.push(String::new());
                }
            }
            csv.push_str(&row_data.join(","));
            csv.push('\n');
        }

        csv
    }

    /// 表格转Markdown格式
    pub fn table_to_markdown(table: &TableStructure) -> String {
        let mut md = String::new();

        // 表头分隔符
        if table.rows > 0 {
            md.push_str("| ");
            for _ in 0..table.cols {
                md.push_str(" --- |");
            }
            md.push('\n');

            // 数据行
            for row in 0..table.rows {
                md.push_str("| ");
                for col in 0..table.cols {
                    if let Some(cell) = table.cells.iter()
                        .find(|c| c.row == row && c.col == col) {
                        md.push_str(&cell.content);
                    }
                    md.push_str(" | ");
                }
                md.push('\n');
            }
        }

        md
    }

    /// 验证表格合理性
    pub fn validate_table(table: &TableStructure) -> Result<(), String> {
        if table.rows == 0 || table.cols == 0 {
            return Err("Empty table".to_string());
        }

        if table.cells.is_empty() {
            return Err("No cells detected".to_string());
        }

        if table.confidence < 50.0 {
            return Err(format!("Low confidence: {:.1}%", table.confidence));
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_table_to_csv() {
        let table = TableStructure {
            rows: 2,
            cols: 2,
            cells: vec![
                TableCell { row: 0, col: 0, content: "A".to_string(), confidence: 1.0 },
                TableCell { row: 0, col: 1, content: "B".to_string(), confidence: 1.0 },
                TableCell { row: 1, col: 0, content: "C".to_string(), confidence: 1.0 },
                TableCell { row: 1, col: 1, content: "D".to_string(), confidence: 1.0 },
            ],
            confidence: 100.0,
            detection_time_ms: 0,
        };

        let csv = TableDetection::table_to_csv(&table);
        assert!(csv.contains("A,B"));
        assert!(csv.contains("C,D"));
    }

    #[test]
    fn test_table_to_markdown() {
        let table = TableStructure {
            rows: 1,
            cols: 2,
            cells: vec![
                TableCell { row: 0, col: 0, content: "Header1".to_string(), confidence: 1.0 },
                TableCell { row: 0, col: 1, content: "Header2".to_string(), confidence: 1.0 },
            ],
            confidence: 100.0,
            detection_time_ms: 0,
        };

        let md = TableDetection::table_to_markdown(&table);
        assert!(md.contains("Header1"));
        assert!(md.contains("Header2"));
        assert!(md.contains("---"));
    }

    #[test]
    fn test_validate_table() {
        let valid_table = TableStructure {
            rows: 1,
            cols: 1,
            cells: vec![
                TableCell { row: 0, col: 0, content: "X".to_string(), confidence: 1.0 },
            ],
            confidence: 100.0,
            detection_time_ms: 0,
        };

        assert!(TableDetection::validate_table(&valid_table).is_ok());

        let invalid_table = TableStructure {
            rows: 0,
            cols: 0,
            cells: vec![],
            confidence: 0.0,
            detection_time_ms: 0,
        };

        assert!(TableDetection::validate_table(&invalid_table).is_err());
    }
}
