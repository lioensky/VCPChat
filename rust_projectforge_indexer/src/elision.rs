//! Exact whole-line elision candidates. Caller must try literal matching first.
//! No trimming of code lines, indentation rewriting or implicit first-tail choice.
const MAX_BYTES:usize=8*1024*1024;
const MAX_COMPARISONS:usize=1_000_000;
const MAX_COMPARED_BYTES:usize=32*1024*1024;
const MAX_PAIRS:usize=10_000;

#[derive(Debug,PartialEq,Eq)]
pub struct Hit {
    pub start:usize,
    pub end:usize,
    pub start_line:usize,
    pub end_line:usize,
}
fn marker(line:&str)->bool {
    matches!(line.trim(),"..."|"…"|"⋮")
}

/// None means the target is not this syntax. Ranges use the LF source snapshot.
pub fn candidates(source:&str,target:&str)->Result<Option<Vec<Hit>>,String> {
    if source.len()>MAX_BYTES || target.len()>MAX_BYTES {
        return Err("elision input budget exceeded".into());
    }
    if source.contains('\r') || target.contains('\r') {
        return Err("elision requires LF snapshots".into());
    }
    let target=target.strip_suffix('\n').unwrap_or(target);
    let parts:Vec<_>=target.split('\n').collect();
    let marks:Vec<_>=parts.iter().enumerate().filter(|(_,line)|marker(line))
        .map(|(i,_)|i).collect();
    if marks.len()!=1 {return Ok(None);}
    let cut=marks[0];
    if cut==0 || cut+1==parts.len() {return Ok(None);}
    let head=&parts[..cut];
    let tail=&parts[cut+1..];
    if head.iter().all(|s|s.trim().is_empty()) || tail.iter().all(|s|s.trim().is_empty()) {
        return Ok(None);
    }
    let mut starts=Vec::new();
    let mut lines=Vec::new();
    let mut offset=0usize;
    for segment in source.split_inclusive('\n') {
        starts.push(offset);
        lines.push(segment.strip_suffix('\n').unwrap_or(segment));
        offset+=segment.len();
    }
    let mut comparisons=MAX_COMPARISONS;
    let mut bytes=MAX_COMPARED_BYTES;
    let mut matches=|block:&[&str]|->Result<Vec<usize>,String> {
        let mut hits=Vec::new();
        if block.len()>lines.len() {return Ok(hits);}
        for start in 0..=lines.len()-block.len() {
            let mut matched=true;
            for (k,wanted) in block.iter().enumerate() {
                comparisons=comparisons.checked_sub(1).ok_or("elision comparison budget exceeded")?;
                // Charge both operands before comparing, including unsuccessful probes.
                let charge=lines[start+k].len().checked_add(wanted.len())
                    .ok_or("elision byte budget overflow")?;
                bytes=bytes.checked_sub(charge).ok_or("elision comparison byte budget exceeded")?;
                if lines[start+k]!=*wanted {matched=false;break;}
            }
            if matched {
                if hits.len()>=MAX_PAIRS {return Err("elision anchor count budget exceeded".into());}
                hits.push(start);
            }
        }
        Ok(hits)
    };
    let heads=matches(head)?;
    let tails=matches(tail)?;
    let mut hits=Vec::new();
    let mut pairing=MAX_COMPARISONS;
    for start in heads {
        for &end_start in &tails {
            pairing=pairing.checked_sub(1).ok_or("elision pairing budget exceeded")?;
            if end_start<start+head.len() {continue;}
            if hits.len()>=MAX_PAIRS {return Err("elision pair count budget exceeded".into());}
            let last=end_start+tail.len()-1;
            hits.push(Hit {
                start:starts[start],
                end:starts.get(last+1).copied().unwrap_or(source.len()),
                start_line:start+1,end_line:last+1,
            });
        }
    }
    Ok(Some(hits))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn indentation_and_all_tail_candidates_are_evidence() {
        let source="function a() {\n  if (x) {\n    y();\n  }\n}\n";
        let hits=candidates(source,"function a() {\n...\n}").unwrap().unwrap();
        assert_eq!(hits,vec![Hit{start:0,end:source.len(),start_line:1,end_line:5}]);
        let hits=candidates("head\nx\nend\ny\nend\n","head\n…\nend").unwrap().unwrap();
        assert_eq!(hits.len(),2);
        assert_eq!(hits[0].end_line,3);
        assert_eq!(hits[1].end_line,5);
        assert!(candidates("  head\nend\n","head\n...\nend").unwrap().unwrap().is_empty());
    }
    #[test]
    fn syntax_boundaries_unicode_and_work_limits() {
        for target in ["...","...\ntail","head\n...","head\n...\n...\ntail"] {
            assert!(candidates("",target).unwrap().is_none());
        }
        let hits=candidates("甲\n中\n末","甲\n⋮\n末").unwrap().unwrap();
        assert_eq!(hits[0].end,"甲\n中\n末".len());
        assert!(candidates("a\r\nb","a\n...\nb").is_err());
        let repeated="x\n".repeat(201);
        assert!(candidates(&repeated,"x\n...\nx").is_err());
    }
}