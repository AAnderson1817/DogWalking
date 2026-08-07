# Locked Today composition

`sanpo-today-locked-composition.png` is the approved and locked visual
comparison reference for Sanpo's Today screen. Review implementations against
this composition; do not reinterpret or redesign it.

The production interface is implemented in
`app/src/components/TodayIllustratedSchedule.tsx` and uses real application
data. Approved production assets are guarded by
`app/scripts/verify-sanpo-assets.mjs`.

The PNG in this directory is a visual comparison reference only. It is not UI
source and must not be embedded in the application as the Today interface.
