# Geometry Cropper

A small, vanilla JS web app that lets you upload a photo, overlay a draggable 4-corner grid, and perform a geometry crop (perspective/“keystone” fix). Runs 100% client-side.

## Features
- Upload → preview on canvas (keeps original pixel resolution internally)
- Drag handles (mouse/touch) to set the quad
- Invalid quad turns grid red
- Arrow keys nudge selected handle 1px (hold **Shift** = 5px steps)
- Outputs a rectified crop you can download

