# Nova native material repairs — 2026-10-11

These PNGs and ordered operation records replace the former compiled-atlas patch script. They were applied through PSD2Live to the editable projects, then exported as complete model/texture sets. Operation paths are relative to this directory; resolve them to absolute paths when using the editor API. Do not apply an atlas UV patch to these exports.

Maid: clean face, neck, natural eyelashes, front/back hair and speaking mouth. Eyelash textures are registered to the original upper-lid locations; the previous left-lash shift has been reverted. Duplicate generated lip meshes are hidden. Export uses two 2048 texture pages.

Chibi: clean opaque back hair, bonnet fragments, preserved neutral/sleepy eyelashes and closed mouth, simplified speaking mouth, expression-to-speaking transition at MouthOpenY 0.05–0.1. Back hair widened by 2.5% to cover the fine seam.

**User requested rollback: legs, stockings and shoes use the original art and mesh geometry. No leg image replacement or leg deformation is included here.** The Core comparison against the pre-repair committed model reports zero vertex difference for both stockings and both shoes. This proves restoration, not a redesign or repair of any pre-existing seam.

Editable final archives are kept in the companion local art deliverable: `maid-repair-contour-final.psd2live` and `chibi-repair-original-legs.psd2live`. Earlier chibi step5/sock variants were rejected and must not be installed. The operation records target the original source layer/mesh IDs; they are not a generic model conversion tool.

Generated replacement art uses imagegen; preserved chibi linework was extracted from the existing model. SHA-256 hashes cover all final replacement PNGs. Application motions, expressions, physics and chat data are unchanged.

Facial alignment correction: registered the cleaned face to original raster bounds (522×594, alpha bounds 5,5–517,579), removed its duplicate baked nose while retaining the separate nose mesh, and restored upper-lid texture placement. Replacement lash foregrounds were cropped and placed in the original raster canvases (L 141×96 at y=16; R 132×84 at y=15). The earlier alignment-only pass left all 12 facial meshes unchanged, but this was insufficient to establish visual alignment. The final pass deliberately corrects the lower face contour; the other 11 facial meshes retain their original vertices. Runtime/model loading tests cannot certify visual quality; the final render set covers 22 expression/pose states.

Lower-face follow-up: the replacement skin artwork had its lower outline landmark at raster (297.5,560), while the original was (311.5,578). A feathered native mesh correction compensates this difference below normalized y=0.6; eye, nose, brow and mouth meshes are not moved. The recorded operation, rather than a claim of unchanged face geometry, defines the final source. Original-rig geometry equality alone does not certify facial alignment after replacing textures.
