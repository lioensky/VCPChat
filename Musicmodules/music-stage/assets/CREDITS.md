# Lyric stage assets: sources and changes

Every file here is used for its light and dark only. Colour always comes from the stage palette.

## Solar System Scope textures (CC BY 4.0)

Textures by Solar System Scope, https://www.solarsystemscope.com/textures/, licensed under
Creative Commons Attribution 4.0 International (https://creativecommons.org/licenses/by/4.0/).
The files below are modified from the originals.

| File | Original | Changes |
|---|---|---|
| `gas-giant-a.webp` | `2k_jupiter.jpg` | Converted to greyscale, levels stretched, saved as WebP at 2048×1024. |
| `gas-giant-b.webp` | `2k_venus_atmosphere.jpg` | Converted to greyscale, levels stretched, local contrast raised and sharpened, saved as WebP at 2048×1024. |
| `ringed-giant.webp` | `2k_saturn.jpg` | Converted to greyscale, levels stretched, reduced to 1024×512, saved as WebP. |
| `ring-system.png` | `2k_saturn_ring_alpha.png` | One row taken along the radius and resampled to 1024×4: red holds the ring's opacity, green its brightness. |

## Poly Haven assets (CC0 1.0)

From https://polyhaven.com. CC0 asks for no attribution; the authors are named here all the same.

| File | Original | Authors | Changes |
|---|---|---|---|
| `planks.webp` | Weathered Planks, https://polyhaven.com/a/weathered_planks (1k diffuse) | Dario Barresi, Dimitrios Savva | Converted to greyscale, levels stretched, reduced to 512×512, saved as WebP. |
| `ballast.webp` | Gravel Floor 02, https://polyhaven.com/a/gravel_floor_02 (1k diffuse) | Jenelle van Heerden, Dimitrios Savva | Converted to greyscale, levels stretched, reduced to 512×512, saved as WebP. |
| `coast-rock.js` | Coast Rocks 05, https://polyhaven.com/a/coast_rocks_05 (glTF mesh) | Rob Tuytel | Reduced from 771,724 to 2,595 triangles, recentred to stand on its lowest point, positions, normals and texture coordinates quantised, stored as a script. |
| `coast-rock.webp` | Coast Rocks 05 (1k diffuse) | Rob Tuytel | Converted to greyscale, levels stretched, reduced to 512×512, saved as WebP. |

## Everything else

All other geometry, textures and effects in the Diorama and Tunnel stages (the train and its interior, stations, trackside, sky, rain, water, post-processing, planets other than the textures above, and the spacecraft) are generated in code in `modes/`. No other third-party models, textures or sounds are used. Real objects were used only as visual reference for proportions; no real fleet numbers or logos appear.
