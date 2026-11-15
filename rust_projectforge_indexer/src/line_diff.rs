//! Exact line insertion/deletion counts, not a unified-diff renderer.
//! Large unrelated middles fail explicitly rather than inventing approximate counts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Counts {
    pub added: u64,
    pub removed: u64,
}

const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_LINES: usize = 200_000;
const MAX_CELLS: usize = 1_000_000;

fn lines(text: &str) -> Vec<&str> {
    if text.is_empty() { return Vec::new(); }
    // Keep newline terminators: changing final newline is a real line change.
    text.split_inclusive('\n').collect()
}

pub fn counts(before: &str, after: &str) -> Result<Counts, String> {
    if before.len() > MAX_BYTES || after.len() > MAX_BYTES {
        return Err("diff byte budget exceeded".into());
    }
    if before == after { return Ok(Counts { added: 0, removed: 0 }); }
    // Count before allocating per-line pointers.
    let line_count = |s: &str| {
        s.bytes().filter(|&c| c == b'\n').count()
            + usize::from(!s.is_empty() && !s.ends_with('\n'))
    };
    if line_count(before) > MAX_LINES || line_count(after) > MAX_LINES {
        return Err("diff line budget exceeded".into());
    }
    let a = lines(before);
    let b = lines(after);
    let mut prefix = 0;
    while prefix < a.len().min(b.len()) && a[prefix] == b[prefix] { prefix += 1; }
    let (mut ae, mut be) = (a.len(), b.len());
    while ae > prefix && be > prefix && a[ae-1] == b[be-1] {
        ae -= 1; be -= 1;
    }
    let (a, b) = (&a[prefix..ae], &b[prefix..be]);
    if a.is_empty() || b.is_empty() {
        return Ok(Counts { added: b.len() as u64, removed: a.len() as u64 });
    }
    if a.len().checked_mul(b.len()).is_none_or(|n| n > MAX_CELLS) {
        return Err("diff work budget exceeded".into());
    }
    // Bound actual byte comparisons as well as cell count: long repeated lines
    // must not turn a million cells into terabytes of comparisons.
    let work = a.iter().try_fold(0usize, |n, x| n.checked_add(x.len()))
        .and_then(|n| n.checked_mul(b.len()));
    if work.is_none_or(|n| n > 64 * 1024 * 1024) {
        return Err("diff comparison byte budget exceeded".into());
    }
    let mut row = vec![0usize; b.len()+1];
    for x in a {
        let mut diagonal = 0;
        for (j, y) in b.iter().enumerate() {
            let previous = row[j+1];
            row[j+1] = if x == y { diagonal + 1 } else { row[j+1].max(row[j]) };
            diagonal = previous;
        }
    }
    let common = row[b.len()];
    Ok(Counts { added: (b.len()-common) as u64, removed: (a.len()-common) as u64 })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_counts_cover_replacements_insertions_and_reordering() {
        assert_eq!(counts("a\nb\nc\n","a\nB\nc\n").unwrap(),Counts{added:1,removed:1});
        assert_eq!(counts("a\n","x\na\ny\n").unwrap(),Counts{added:2,removed:0});
        assert_eq!(counts("a\nb\n","b\na\n").unwrap(),Counts{added:1,removed:1});
        assert_eq!(counts("","猫\n").unwrap(),Counts{added:1,removed:0});
        assert_eq!(counts("x\n","").unwrap(),Counts{added:0,removed:1});
    }
    #[test]
    fn final_newline_is_not_silently_discarded() {
        assert_eq!(counts("a","a\n").unwrap(),Counts{added:1,removed:1});
        assert_eq!(counts("a\n","a\n").unwrap(),Counts{added:0,removed:0});
    }
    #[test]
    fn large_common_context_is_linear_but_large_middle_is_rejected() {
        let context = "same\n".repeat(20_000);
        assert_eq!(counts(&format!("{context}before\n"),&format!("{context}after\n")).unwrap(),
            Counts{added:1,removed:1});
        assert!(counts(&"a\n".repeat(1001),&"b\n".repeat(1001)).is_err());
        assert!(counts(&"\n".repeat(MAX_LINES+1),"x").is_err());
    }
}