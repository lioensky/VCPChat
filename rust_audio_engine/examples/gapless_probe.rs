//! 量一个文件解码后和原始 PCM 差几帧、开头错开多少帧（无缝衔接要两个都是 0）。
//! cargo run --release --example gapless_probe -- reference.wav encoded.mp3 [...]
use vcp_audio_engine::decoder::StreamingDecoder;

fn decode(path: &str) -> (Vec<f64>, usize, u32) {
    let mut d = StreamingDecoder::open(path).expect("open");
    let ch = d.info.channels;
    let sr = d.info.sample_rate;
    let mut out = Vec::new();
    while let Some(s) = d.decode_next().expect("decode") { out.extend(s); }
    let mono: Vec<f64> = out.chunks(ch).map(|f| f[0]).collect();
    (mono, ch, sr)
}

fn best_lag(r: &[f64], x: &[f64]) -> (i64, f64) {
    let n = 4096.min(r.len()).min(x.len().saturating_sub(4000));
    let mut best = (0i64, f64::MAX);
    for lag in -3000i64..=3000 {
        let mut e = 0.0;
        for i in 2000..2000 + n.saturating_sub(4000).max(1) {
            let j = i as i64 + lag;
            if j < 0 || j as usize >= x.len() { e = f64::MAX; break; }
            let d = r[i] - x[j as usize];
            e += d * d;
        }
        if e < best.1 { best = (lag, e); }
    }
    best
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (r, _, _) = decode(&args[0]);
    for p in &args[1..] {
        let (x, _, sr) = decode(p);
        let (lag, _) = best_lag(&r, &x);
        // 末尾：用倒过来的信号找错位
        let rr: Vec<f64> = r.iter().rev().cloned().collect();
        let xr: Vec<f64> = x.iter().rev().cloned().collect();
        let (tail, _) = best_lag(&rr, &xr);
        println!("{p}: {sr} Hz, frames {} vs ref {} (diff {:+}), start offset {:+}, end offset {:+}", x.len(), r.len(), x.len() as i64 - r.len() as i64, lag, tail);
    }
}
