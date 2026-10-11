# Nova maid clean hair and lashes

These six PNG patches replace the front hair, both upper eyelashes, central back hair, and both side/back hair UV islands. The material was regenerated with the built-in image generator from the previous isolated texture cutouts. The reviewed texture uses the existing 2048 atlas, MOC, physics and expression bindings.

The old front hair contained skin/eye fragments along its inner edge; the upper lashes contained skin and eye highlights. Back hair contained ghosted face, jewelry and clothing outlines left by reconstruction. The replacement hair contains continuous hair strands; the upper lashes are isolated transparent contours. Back hair retains the original alpha coverage to avoid introducing gaps between existing meshes.

The generated high-resolution masters and rejected atlas-wide candidate are retained in the local delivery `outputs/Nova女仆素材修复-20261011`. Only reviewed, UV-sized patches are versioned here. Generation did not replace the clothing, face base, irises, neck or mouth.

Run `node scripts/deskpet/apply-nova-maid-materials.cjs --check` to verify the installed texture. To replay onto the original atlas, run the script without `--check` (or use `--texture PATH` for a separate copy). It rejects unexpected model/atlas hashes. Do not apply these UV rectangles blindly to a new export or atlas layout.

The patches are compiled-atlas material sources, not an updated Cubism/PSD2Live editor project. A future editor export must port these clean layers and review its UV layout. The old `.psd2live` archives still contain the previous images.

Remaining rig limitations: the existing side/back-hair joins can still show a straight tonal boundary at large scale, and the headwear/crown overlap needs further mesh/layer review. This material pass does not claim those geometry issues or the separate Q-version defects are fixed.
