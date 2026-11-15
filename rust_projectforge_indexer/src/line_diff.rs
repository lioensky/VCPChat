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
/// Bound on real byte comparisons as well as cell count: long repeated lines
/// must not turn a million cells into terabytes of memcmp.
const MAX_COMPARE_BYTES: usize = 64 * 1024 * 1024;
/// Lines per block when fingerprinting an out-of-budget middle.
const ESTIMATE_BLOCK_LINES: usize = 256;
const ERR_BYTE_BUDGET: &str = "diff byte budget exceeded";
const ERR_LINE_BUDGET: &str = "diff line budget exceeded";
const ERR_WORK_BUDGET: &str = "diff work budget exceeded";
const ERR_COMPARE_BUDGET: &str = "diff comparison byte budget exceeded";
/// Reason reported when the exact LCS was skipped because of the work budget.
const BUDGET_REASON_CELLS: &str = "cell_or_byte_budget";
/// Reason reported when the rendered diff was clipped by `max_lines`.
const BUDGET_REASON_LINES: &str = "max_lines";
/// Reason reported when the rendered diff was clipped by `max_bytes`.
const BUDGET_REASON_BYTES: &str = "max_bytes";

/// Bounded line statistics.
///
/// `added`/`removed` are exact LCS counts while `truncated` is false. When the
/// exact path would exceed the work budget they are a linear per-line estimate
/// and `budget_reason` says why the exact count was skipped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiffStats {
    pub added: u64,
    pub removed: u64,
    pub truncated: bool,
    pub budget_reason: Option<&'static str>,
}

/// Rendered unified diff plus its truncation bookkeeping.
///
/// `total_lines`/`hunks_total` describe the diff that *would* have been
/// emitted; `shown_lines`/`hunks_shown` describe `text`. Callers can therefore
/// tell "nothing changed" (0/0) from "everything was omitted" (N/0).
///
/// When the middle is out of budget the text shows it as one full replacement
/// block while `added`/`removed` come from the linear estimate, so both stay
/// consistent with [`stats_bounded`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnifiedDiff {
    pub text: String,
    pub added: u64,
    pub removed: u64,
    pub truncated: bool,
    pub total_lines: usize,
    pub shown_lines: usize,
    pub omitted_lines: usize,
    pub hunks_total: usize,
    pub hunks_shown: usize,
    pub reason: Option<&'static str>,
}

fn lines(text: &str) -> Vec<&str> {
    if text.is_empty() { return Vec::new(); }
    // Keep newline terminators: changing final newline is a real line change.
    text.split_inclusive('\n').collect()
}

pub fn counts(before: &str, after: &str) -> Result<Counts, String> {
    if before.len() > MAX_BYTES || after.len() > MAX_BYTES {
        return Err(ERR_BYTE_BUDGET.into());
    }
    if before == after { return Ok(Counts { added: 0, removed: 0 }); }
    // Count before allocating per-line pointers.
    let line_count = |s: &str| {
        s.bytes().filter(|&c| c == b'\n').count()
            + usize::from(!s.is_empty() && !s.ends_with('\n'))
    };
    if line_count(before) > MAX_LINES || line_count(after) > MAX_LINES {
        return Err(ERR_LINE_BUDGET.into());
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
        return Err(ERR_WORK_BUDGET.into());
    }
    // Bound actual byte comparisons as well as cell count: long repeated lines
    // must not turn a million cells into terabytes of comparisons.
    let work = a.iter().try_fold(0usize, |n, x| n.checked_add(x.len()))
        .and_then(|n| n.checked_mul(b.len()));
    if work.is_none_or(|n| n > MAX_COMPARE_BYTES) {
        return Err(ERR_COMPARE_BUDGET.into());
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

/// Exact counts where they fit the work budget, a linear estimate where they do
/// not. Only the byte and line ceilings still reject: rewriting the middle of a
/// 1000+ line file must not block a commit.
pub fn stats_bounded(before: &str, after: &str) -> Result<DiffStats, String> {
    match counts(before, after) {
        Ok(exact) => Ok(DiffStats {
            added: exact.added,
            removed: exact.removed,
            truncated: false,
            budget_reason: None,
        }),
        Err(error) if error == ERR_WORK_BUDGET || error == ERR_COMPARE_BUDGET => {
            let estimate = estimate_counts_text(before, after)?;
            Ok(DiffStats {
                added: estimate.added,
                removed: estimate.removed,
                truncated: true,
                budget_reason: Some(BUDGET_REASON_CELLS),
            })
        }
        Err(error) => Err(error),
    }
}

/// Same hard ceilings as [`counts`], then a linear pass over the rewritten
/// middle. Kept separate so [`stats_bounded`] never invents numbers for content
/// it could not even have split into lines.
fn estimate_counts_text(before: &str, after: &str) -> Result<Counts, String> {
    if before.len() > MAX_BYTES || after.len() > MAX_BYTES {
        return Err(ERR_BYTE_BUDGET.into());
    }
    if before == after {
        return Ok(Counts { added: 0, removed: 0 });
    }
    if count_lines(before) > MAX_LINES || count_lines(after) > MAX_LINES {
        return Err(ERR_LINE_BUDGET.into());
    }
    let a = lines(before);
    let b = lines(after);
    let (_, mid_a, mid_b) = trim_common(&a, &b);
    if mid_a.is_empty() || mid_b.is_empty() {
        return Ok(Counts { added: mid_b.len() as u64, removed: mid_a.len() as u64 });
    }
    Ok(estimate_counts(mid_a, mid_b))
}

/// Line count that keeps a missing final newline significant (same rule as the
/// `lines` splitter).
fn count_lines(text: &str) -> usize {
    text.bytes().filter(|&c| c == b'\n').count()
        + usize::from(!text.is_empty() && !text.ends_with('\n'))
}

/// Strip the shared prefix and suffix so only the rewritten middle is priced.
fn trim_common<'a>(a: &'a [&'a str], b: &'a [&'a str]) -> (usize, &'a [&'a str], &'a [&'a str]) {
    let mut prefix = 0;
    while prefix < a.len().min(b.len()) && a[prefix] == b[prefix] {
        prefix += 1;
    }
    let (mut a_end, mut b_end) = (a.len(), b.len());
    while a_end > prefix && b_end > prefix && a[a_end - 1] == b[b_end - 1] {
        a_end -= 1;
        b_end -= 1;
    }
    (prefix, &a[prefix..a_end], &b[prefix..b_end])
}

/// FNV-1a over the line bytes, seeded with the line length so the same bytes cut
/// differently cannot pile up on one key.
fn fingerprint(line: &str) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64 ^ (line.len() as u64).wrapping_mul(0x0100_0000_01b3);
    for byte in line.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

/// Linear multiset estimate over per-line fingerprints.
///
/// A line present on both sides cancels even when it moved, so pure insertions,
/// pure deletions and in-place rewrites stay exact; only a genuine reordering
/// inside an out-of-budget middle can over-report. Blocks keep the scratch state
/// bounded for a 200k-line file, and the whole pass is O(n + m).
fn estimate_counts(a: &[&str], b: &[&str]) -> Counts {
    use std::collections::HashMap;
    let mut balance: HashMap<u64, u64> = HashMap::with_capacity(a.len());
    for block in a.chunks(ESTIMATE_BLOCK_LINES) {
        for line in block {
            *balance.entry(fingerprint(line)).or_insert(0) += 1;
        }
    }
    let mut added = 0u64;
    for block in b.chunks(ESTIMATE_BLOCK_LINES) {
        for line in block {
            match balance.get_mut(&fingerprint(line)) {
                Some(left) if *left > 0 => *left -= 1,
                _ => added += 1,
            }
        }
    }
    let mut removed = 0u64;
    for left in balance.values() {
        removed += *left;
    }
    Counts { added, removed }
}

/// One line of the edit stream, borrowed from whichever side owns the text.
#[derive(Debug, Clone, Copy)]
enum Edit<'a> {
    Keep(&'a str),
    Drop(&'a str),
    Add(&'a str),
}

fn is_add(edit: &Edit) -> bool { matches!(*edit, Edit::Add(_)) }
fn is_drop(edit: &Edit) -> bool { matches!(*edit, Edit::Drop(_)) }

fn edit_text<'a>(edit: &Edit<'a>) -> &'a str {
    match *edit {
        Edit::Keep(line) | Edit::Drop(line) | Edit::Add(line) => line,
    }
}

/// Drop the line terminator kept by `lines()`. The renderer supplies separators,
/// so a payload must never carry its own newline.
fn display_line(line: &str) -> &str {
    match line.strip_suffix('\n') {
        Some(rest) => rest.strip_suffix('\r').unwrap_or(rest),
        None => line,
    }
}

fn advance(edit: &Edit, old_no: &mut usize, new_no: &mut usize) {
    match *edit {
        Edit::Keep(_) => { *old_no += 1; *new_no += 1; }
        Edit::Drop(_) => *old_no += 1,
        Edit::Add(_) => *new_no += 1,
    }
}

/// Standard LCS edit script; callers must have priced the table already.
fn exact_edits<'a>(a: &'a [&'a str], b: &'a [&'a str]) -> Vec<Edit<'a>> {
    let (rows, cols) = (a.len(), b.len());
    let width = cols + 1;
    // u32 halves the table: the 1e6-cell budget costs 4 MiB.
    let mut table = vec![0u32; (rows + 1) * width];
    for i in (0..rows).rev() {
        for j in (0..cols).rev() {
            table[i * width + j] = if a[i] == b[j] {
                table[(i + 1) * width + j + 1] + 1
            } else {
                table[(i + 1) * width + j].max(table[i * width + j + 1])
            };
        }
    }
    let mut edits = Vec::with_capacity(rows + cols);
    let (mut i, mut j) = (0usize, 0usize);
    while i < rows && j < cols {
        if a[i] == b[j] {
            edits.push(Edit::Keep(a[i]));
            i += 1;
            j += 1;
        } else if table[(i + 1) * width + j] >= table[i * width + j + 1] {
            edits.push(Edit::Drop(a[i]));
            i += 1;
        } else {
            edits.push(Edit::Add(b[j]));
            j += 1;
        }
    }
    while i < rows { edits.push(Edit::Drop(a[i])); i += 1; }
    while j < cols { edits.push(Edit::Add(b[j])); j += 1; }
    edits
}

/// Honest fallback for an unpriced middle: show it as one full replacement.
fn replaced_edits<'a>(a: &'a [&'a str], b: &'a [&'a str]) -> Vec<Edit<'a>> {
    let mut edits = Vec::with_capacity(a.len() + b.len());
    edits.extend(a.iter().map(|line| Edit::Drop(*line)));
    edits.extend(b.iter().map(|line| Edit::Add(*line)));
    edits
}

fn nothing_changed() -> UnifiedDiff {
    UnifiedDiff {
        text: String::new(),
        added: 0,
        removed: 0,
        truncated: false,
        total_lines: 0,
        shown_lines: 0,
        omitted_lines: 0,
        hunks_total: 0,
        hunks_shown: 0,
        reason: None,
    }
}

/// Append one rendered line while honouring both ceilings; false means clipped.
fn push_line(
    text: &mut String,
    line: &str,
    shown: &mut usize,
    bytes: &mut usize,
    max_lines: usize,
    max_bytes: usize,
) -> bool {
    let separator = usize::from(!text.is_empty());
    if *shown + 1 > max_lines || *bytes + separator + line.len() > max_bytes {
        return false;
    }
    if separator == 1 { text.push('\n'); }
    text.push_str(line);
    *shown += 1;
    *bytes += separator + line.len();
    true
}

/// Render a unified diff under both a line and a byte ceiling, and report exactly
/// how much was left out.
///
/// `total_lines`/`hunks_total` count what an unbounded render would have
/// produced; `shown_lines`/`hunks_shown` describe `text`, so callers can tell
/// "nothing changed" (0/0) from "everything was omitted" (N/0). `reason` is
/// `cell_or_byte_budget` when the middle was estimated (that fact outranks a
/// later clip), otherwise `max_lines` or `max_bytes`.
pub fn unified(
    before: &str,
    after: &str,
    old_label: &str,
    new_label: &str,
    context: usize,
    max_lines: usize,
    max_bytes: usize,
) -> Result<UnifiedDiff, String> {
    if before.len() > MAX_BYTES || after.len() > MAX_BYTES {
        return Err(ERR_BYTE_BUDGET.into());
    }
    if count_lines(before) > MAX_LINES || count_lines(after) > MAX_LINES {
        return Err(ERR_LINE_BUDGET.into());
    }
    if before == after {
        return Ok(nothing_changed());
    }

    let a = lines(before);
    let b = lines(after);
    let (prefix, mid_a, mid_b) = trim_common(&a, &b);
    let comparison_bytes = mid_a.iter()
        .try_fold(0usize, |n, line| n.checked_add(line.len()))
        .and_then(|n| n.checked_mul(mid_b.len()));
    let estimated = mid_a.len().saturating_mul(mid_b.len()) > MAX_CELLS
        || comparison_bytes.is_none_or(|n| n > MAX_COMPARE_BYTES);
    let middle = if estimated {
        replaced_edits(mid_a, mid_b)
    } else {
        exact_edits(mid_a, mid_b)
    };

    // Only the context window of the untouched prefix/suffix can reach the
    // output, so a huge shared context does not inflate the stream.
    let head_len = prefix.min(context);
    let tail_start = prefix + mid_a.len();
    let tail_len = (a.len() - tail_start).min(context);
    let mut stream: Vec<Edit> = Vec::with_capacity(head_len + middle.len() + tail_len);
    stream.extend(a[prefix - head_len..prefix].iter().map(|line| Edit::Keep(*line)));
    stream.extend(middle);
    stream.extend(a[tail_start..tail_start + tail_len].iter().map(|line| Edit::Keep(*line)));
    if stream.is_empty() {
        return Ok(nothing_changed());
    }

    let mut keep = vec![false; stream.len()];
    for (index, edit) in stream.iter().enumerate() {
        if !is_add(edit) && !is_drop(edit) {
            continue;
        }
        let from = index.saturating_sub(context);
        let to = (index + context).min(stream.len() - 1);
        for slot in &mut keep[from..=to] {
            *slot = true;
        }
    }

    let mut old_no = prefix - head_len + 1;
    let mut new_no = old_no;
    let mut hunks: Vec<(usize, usize, usize, usize)> = Vec::new();
    let mut index = 0usize;
    while index < stream.len() {
        if !keep[index] {
            advance(&stream[index], &mut old_no, &mut new_no);
            index += 1;
            continue;
        }
        let start = index;
        let (start_old, start_new) = (old_no, new_no);
        while index < stream.len() && keep[index] {
            advance(&stream[index], &mut old_no, &mut new_no);
            index += 1;
        }
        hunks.push((start, index, start_old, start_new));
    }
    if hunks.is_empty() {
        return Ok(nothing_changed());
    }

    let total_lines = 2 + hunks.iter().map(|&(start, end, _, _)| 1 + (end - start)).sum::<usize>();
    // Estimated answers come from the same multiset pass as `stats_bounded`, so
    // the two entry points can never disagree on added/removed.
    let (added, removed) = if estimated {
        let estimate = estimate_counts(mid_a, mid_b);
        (estimate.added, estimate.removed)
    } else {
        (
            stream.iter().filter(|edit| is_add(edit)).count() as u64,
            stream.iter().filter(|edit| is_drop(edit)).count() as u64,
        )
    };

    let mut text = String::new();
    let mut shown_lines = 0usize;
    let mut bytes = 0usize;
    let mut hunks_shown = 0usize;
    let mut clipped: Option<&'static str> = None;

    'render: {
        for header in [format!("--- {old_label}"), format!("+++ {new_label}")] {
            if !push_line(&mut text, &header, &mut shown_lines, &mut bytes, max_lines, max_bytes) {
                clipped = Some(if shown_lines < max_lines { BUDGET_REASON_BYTES } else { BUDGET_REASON_LINES });
                break 'render;
            }
        }
        for &(start, end, start_old, start_new) in &hunks {
            let slice = &stream[start..end];
            let old_count = slice.iter().filter(|edit| !is_add(edit)).count();
            let new_count = slice.iter().filter(|edit| !is_drop(edit)).count();
            let hunk_header = format!("@@ -{start_old},{old_count} +{start_new},{new_count} @@");
            // Price the whole hunk before writing any of it so a clip never
            // leaves half a hunk in the output.
            let mut needed_lines = 1usize;
            let mut needed_bytes = hunk_header.len();
            for edit in slice {
                needed_lines += 1;
                needed_bytes += 1 + display_line(edit_text(edit)).len();
            }
            if shown_lines + needed_lines > max_lines {
                clipped = Some(BUDGET_REASON_LINES);
                break 'render;
            }
            if bytes + usize::from(!text.is_empty()) + needed_bytes > max_bytes {
                clipped = Some(BUDGET_REASON_BYTES);
                break 'render;
            }
            push_line(&mut text, &hunk_header, &mut shown_lines, &mut bytes, usize::MAX, usize::MAX);
            for edit in slice {
                let marker = match *edit {
                    Edit::Keep(_) => ' ',
                    Edit::Drop(_) => '-',
                    Edit::Add(_) => '+',
                };
                let line = format!("{marker}{}", display_line(edit_text(edit)));
                push_line(&mut text, &line, &mut shown_lines, &mut bytes, usize::MAX, usize::MAX);
            }
            hunks_shown += 1;
        }
    }

    let reason = if estimated { Some(BUDGET_REASON_CELLS) } else { clipped };
    Ok(UnifiedDiff {
        text,
        added,
        removed,
        truncated: reason.is_some(),
        total_lines,
        shown_lines,
        omitted_lines: total_lines.saturating_sub(shown_lines),
        hunks_total: hunks.len(),
        hunks_shown,
        reason,
    })
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
    #[test]
    fn stats_bounded_stays_exact_inside_the_work_budget() {
        assert_eq!(stats_bounded("a\nb\nc\n","a\nB\nc\n").unwrap(),
            DiffStats{added:1,removed:1,truncated:false,budget_reason:None});
        assert_eq!(stats_bounded("a\n","a\n").unwrap(),
            DiffStats{added:0,removed:0,truncated:false,budget_reason:None});
    }
    #[test]
    fn stats_bounded_estimates_instead_of_rejecting_a_large_middle() {
        let before="a\n".repeat(1001);
        let after="b\n".repeat(1001);
        // The exact LCS refuses this shape; a commit must not be blocked by it.
        assert!(counts(&before,&after).is_err());
        assert_eq!(stats_bounded(&before,&after).unwrap(),
            DiffStats{added:1001,removed:1001,truncated:true,budget_reason:Some(BUDGET_REASON_CELLS)});
    }
    #[test]
    fn stats_bounded_keeps_the_hard_byte_and_line_ceilings() {
        assert!(stats_bounded(&"\n".repeat(MAX_LINES+1),"x").is_err());
    }
    #[test]
    fn stats_bounded_sees_through_a_long_shared_context() {
        let context="same\n".repeat(20_000);
        let stats=stats_bounded(&format!("{context}before\n"),&format!("{context}after\n")).unwrap();
        assert_eq!((stats.added,stats.removed,stats.truncated),(1,1,false));
    }
    #[test]
    fn unified_renders_one_hunk_with_exact_bookkeeping() {
        let diff=unified("a\nb\nc\n","a\nB\nc\n","a/f.txt","b/f.txt",3,400,1024*1024).unwrap();
        assert!(diff.text.contains("@@ -1,3 +1,3 @@"));
        assert!(diff.text.contains("-b\n"));
        assert!(diff.text.contains("+B\n"));
        assert_eq!((diff.added,diff.removed),(1,1));
        assert_eq!((diff.hunks_total,diff.hunks_shown),(1,1));
        assert!(!diff.truncated);
        assert_eq!(diff.reason,None);
        assert_eq!(diff.omitted_lines,0);
        assert_eq!(diff.total_lines,diff.shown_lines);
        assert_eq!(diff.shown_lines,diff.text.split('\n').count());
    }
    #[test]
    fn unified_reports_omitted_lines_when_max_lines_bites() {
        // Two edits far apart => two hunks; a budget that cannot hold the second
        // one must report the loss instead of silently dropping it.
        let before=format!("x\n{}y\n{}z\n","same\n".repeat(20),"same\n".repeat(20));
        let after=format!("X\n{}Y\n{}z\n","same\n".repeat(20),"same\n".repeat(20));
        let full=unified(&before,&after,"a","b",1,10_000,1024*1024).unwrap();
        assert_eq!(full.hunks_total,2);
        assert!(!full.truncated);
        let clipped=unified(&before,&after,"a","b",1,6,1024*1024).unwrap();
        assert!(clipped.truncated);
        assert_eq!(clipped.reason,Some(BUDGET_REASON_LINES));
        assert_eq!(clipped.hunks_shown,1);
        assert_eq!(clipped.hunks_total,2);
        assert_eq!(clipped.total_lines,full.total_lines);
        assert_eq!(clipped.shown_lines,clipped.text.split('\n').count());
        assert!(clipped.shown_lines<clipped.total_lines);
        assert_eq!(clipped.omitted_lines,clipped.total_lines-clipped.shown_lines);
    }
    #[test]
    fn unified_reports_omitted_lines_when_max_bytes_bites() {
        let diff=unified(&"a\n".repeat(50),&"b\n".repeat(50),"a","b",3,10_000,60).unwrap();
        assert!(diff.truncated);
        assert_eq!(diff.reason,Some(BUDGET_REASON_BYTES));
        assert_eq!(diff.hunks_shown,0);
        assert_eq!(diff.shown_lines,diff.text.split('\n').count());
        assert_eq!(diff.omitted_lines,diff.total_lines-diff.shown_lines);
    }
    #[test]
    fn unified_marks_an_out_of_budget_middle_as_estimated() {
        let (before,after)=("a\n".repeat(1001),"b\n".repeat(1001));
        let diff=unified(&before,&after,"a","b",0,10_000,1024*1024).unwrap();
        // Estimated numbers come from the same pass as stats_bounded.
        let stats=stats_bounded(&before,&after).unwrap();
        assert_eq!((diff.added,diff.removed),(stats.added,stats.removed));
        assert!(diff.text.contains("@@ -1,1001 +1,1001 @@"));
        assert!(diff.truncated);
        assert_eq!(diff.reason,Some(BUDGET_REASON_CELLS));
        assert_eq!(diff.omitted_lines,0);
    }
    #[test]
    fn unified_reports_no_output_when_nothing_changed() {
        assert_eq!(unified("a\n","a\n","a","b",3,400,1024).unwrap(),nothing_changed());
    }
}