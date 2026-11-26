//! 无缝衔接：有损格式解码后必须和原始 PCM 逐帧对齐，开头不多编码预热、结尾不多补零。
//! 夹具是 12345 帧的扫频（ref.flac 无损），chirp.m4a / chirp.mp3 由它编码。
use vcp_audio_engine::decoder::StreamingDecoder;

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/gapless/");

fn left(name: &str) -> Vec<f64> {
    let mut d = StreamingDecoder::open(format!("{DIR}{name}")).expect("open");
    let ch = d.info.channels;
    let mut out = Vec::new();
    while let Some(s) = d.decode_next().expect("decode") { out.extend(s); }
    out.chunks(ch).map(|f| f[0]).collect()
}

/// 编码后的信号和原始信号错开多少帧（扫频没有周期，最小误差的位置唯一）
fn offset(reference: &[f64], x: &[f64]) -> i64 {
    let (from, n) = (3000usize, 4000usize);
    (-2500i64..=2500)
        .map(|lag| {
            let e: f64 = (from..from + n).map(|i| { let j = (i as i64 + lag) as usize; let d = reference[i] - x.get(j).copied().unwrap_or(0.0); d * d }).sum();
            (lag, e)
        })
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .unwrap()
        .0
}

fn check(name: &str) {
    let r = left("ref.flac");
    assert_eq!(r.len(), 12345);
    let x = left(name);
    assert_eq!(offset(&r, &x), 0, "{name}: start is shifted (encoder priming left in)");
    assert_eq!(x.len(), r.len(), "{name}: length differs from the source");
}

#[test]
fn aac_in_m4a_is_sample_exact() { check("chirp.m4a"); }

#[test]
fn mp3_with_lame_header_is_sample_exact() { check("chirp.mp3"); }
