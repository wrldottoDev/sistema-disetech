# Quotation PDF assets

`logo.png` is a tightly cropped derivative of the local transparent brand artwork
`/Users/ottogonzalez/Documents/disetech/page/assets/brand/disetech-logo.webp`.
Neutral white lettering was recolored to #111111 for white paper; the green accents
and alpha channel were preserved. The source files were not modified.

The five Arimo WOFF files in `fonts/` were copied unchanged from the installed
`@fontsource/arimo` package (5.3.x). Arimo is Arial metric-compatible and licensed
under SIL OFL 1.1; the original copyright and license are included in `fonts/OFL.txt`.
The Latin Extended regular/bold subsets supply U+20A1 (₡).

The renderer resolves these bundled assets relative to its module, with a project
root fallback for Next server bundles. Deployment packages must retain these assets.
No runtime font download or fontsource directory lookup is used.
