use image::{ImageBuffer, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use log::info;
use std::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenCapture {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,          // RGBA bytes
    pub timestamp: u64,
    pub capture_time_ms: u64,   // 捕获耗时（毫秒）
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureRegion {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub struct ScreenshotCapture;

impl ScreenshotCapture {
    /// 捕获指定区域的屏幕
    /// 返回 RGBA 格式的图像数据
    pub fn capture_region(region: &CaptureRegion) -> Result<ScreenCapture, String> {
        let start = Instant::now();
        
        #[cfg(target_os = "windows")]
        {
            Self::capture_region_windows(region)
        }
        
        #[cfg(not(target_os = "windows"))]
        {
            Err("Screenshot capture only supported on Windows".to_string())
        }
    }

    /// 使用 BitBlt 捕获 Windows 屏幕区域
    #[cfg(target_os = "windows")]
    fn capture_region_windows(region: &CaptureRegion) -> Result<ScreenCapture, String> {
        use std::time::{SystemTime, UNIX_EPOCH};
        
        let start = Instant::now();
        
        // 创建空的 RGBA 图像
        let mut img: RgbaImage = ImageBuffer::new(region.width, region.height);
        
        // 填充为黑色（后续会替换为实际屏幕数据）
        for pixel in img.pixels_mut() {
            *pixel = Rgba([0, 0, 0, 255]);
        }
        
        // TODO: 实现实际的 BitBlt 捕获逻辑
        // 当前为占位实现
        
        let data = img.into_raw();
        let capture_time = start.elapsed().as_millis() as u64;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        info!(
            "[ScreenshotCapture] Region ({}, {}) {}x{} captured in {}ms",
            region.x, region.y, region.width, region.height, capture_time
        );

        Ok(ScreenCapture {
            x: region.x,
            y: region.y,
            width: region.width,
            height: region.height,
            data,
            timestamp,
            capture_time_ms: capture_time,
        })
    }

    /// 将屏幕捕获转换为 Base64 编码的 PNG
    pub fn to_png_base64(capture: &ScreenCapture) -> Result<String, String> {
        use image::ImageBuffer;
        
        // 重建图像
        let img = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(
            capture.width,
            capture.height,
            capture.data.clone(),
        )
        .ok_or_else(|| "Failed to create image buffer".to_string())?;

        // 编码为 PNG
        let mut png_data = Vec::new();
        let mut encoder = image::codecs::png::PngEncoder::new(&mut png_data);
        encoder
            .encode(&img, capture.width, capture.height, image::ColorType::Rgba8)
            .map_err(|e| format!("PNG encoding failed: {}", e))?;

        // Base64 编码
        let base64_str = base64::encode(&png_data);
        Ok(base64_str)
    }

    /// 估计智能截图区域（围绕鼠标位置）
    pub fn estimate_region(mouse_x: i32, mouse_y: i32) -> CaptureRegion {
        const REGION_WIDTH: u32 = 600;
        const REGION_HEIGHT: u32 = 400;
        const PADDING: i32 = 50;

        let mut x = (mouse_x - (REGION_WIDTH as i32 / 2)).max(0);
        let mut y = (mouse_y - (REGION_HEIGHT as i32 / 2)).max(0);

        // 考虑屏幕边界（假设 1920x1080）
        let max_x = 1920 - REGION_WIDTH as i32;
        let max_y = 1080 - REGION_HEIGHT as i32;

        if x > max_x {
            x = max_x;
        }
        if y > max_y {
            y = max_y;
        }

        CaptureRegion {
            x,
            y,
            width: REGION_WIDTH,
            height: REGION_HEIGHT,
        }
    }

    /// 计算图像哈希用于检测重复截图
    pub fn compute_hash(capture: &ScreenCapture) -> u64 {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let mut hasher = DefaultHasher::new();
        capture.data.hash(&mut hasher);
        hasher.finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_estimate_region() {
        let region = ScreenshotCapture::estimate_region(960, 540);
        assert!(region.width > 0);
        assert!(region.height > 0);
        assert!(region.x >= 0);
        assert!(region.y >= 0);
    }

    #[test]
    fn test_compute_hash() {
        let capture = ScreenCapture {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            data: vec![0; 40000], // 100x100 RGBA
            timestamp: 0,
            capture_time_ms: 50,
        };
        
        let hash = ScreenshotCapture::compute_hash(&capture);
        assert!(hash > 0);
    }
}
