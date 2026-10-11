# Nova native material repairs — 2026-10-11

These PNGs and ordered operation records replace the former compiled-atlas patch script. They were applied through PSD2Live to the editable projects, then exported as complete model/texture sets. Operation paths are relative to this directory; resolve them to absolute paths when using the editor API. Do not apply an atlas UV patch to these exports.

Maid: clean face, neck, natural eyelashes, front/back hair and speaking mouth. Open left eyelash shifted to fit the upper lid; duplicate generated lip meshes hidden. Export uses two 2048 texture pages.

Chibi: clean opaque back hair, bonnet fragments, preserved neutral/sleepy eyelashes and closed mouth, simplified speaking mouth, expression-to-speaking transition at MouthOpenY 0.05–0.1. Back hair widened by 2.5% to cover the fine seam.

**User requested rollback: legs, stockings and shoes use the original art and mesh geometry. No leg image replacement or leg deformation is included here.** The Core comparison against the pre-repair committed model reports zero vertex difference for both stockings and both shoes. This proves restoration, not a redesign or repair of any pre-existing seam.

Editable final archives are kept in the companion local art deliverable: `maid-repair-step3.psd2live` and `chibi-repair-original-legs.psd2live`. Earlier chibi step5/sock variants were rejected and must not be installed. The operation records target the original source layer/mesh IDs; they are not a generic model conversion tool.

Generated replacement art uses imagegen; preserved chibi linework was extracted from the existing model. SHA-256 hashes cover all final replacement PNGs. Application motions, expressions, physics and chat data are unchanged.
