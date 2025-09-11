// cropper.js

//// IMPORTS

import {
  compute_homography,
  invert_3x3,
  multiply_mat3_vec3,
  is_valid_quad,
  bilinear_sample,
} from './geometry.js';

//// APP

// ---------- DOM ----------
const file_input = document.getElementById('file_input');
const main_canvas = document.getElementById('main_canvas');
const crop_button = document.getElementById('crop_button');
const grid_divisions_input = document.getElementById('grid_divisions');
const cropped_canvas = document.getElementById('cropped_canvas');
const download_link = document.getElementById('download_link');
const tooltip = document.getElementById('tooltip');
const wrapper_el = document.querySelector('.canvas-wrapper');

const main_ctx = main_canvas.getContext('2d', { alpha: true });

// ---------- UI sizing (CSS px) ----------
const UI = {
  gridStrokeCss: 2,
  gridStrokeInvalidCss: 3,
  innerLineCss: 1,
  handleStrokeCss: 3,

  // Handle at the corner stays normal size (even while dragging)
  handleRadiusCss: 18,
  handleHitRadiusCss: 60,

  // Center magnifier circle (shown only while dragging)
  magnifierRadiusCss: 160, // adjust bigger/smaller if you like
  magnifyScale: 5,
  crosshairArmCss: 16,
};

// ---------- State (all coordinates in CANVAS/IMAGE pixels) ----------
let image_bitmap = null; // original-size ImageBitmap
let src_image_data = null; // original-size ImageData

let corners = [
  { x: 100, y: 100 }, // TL
  { x: 700, y: 100 }, // TR
  { x: 700, y: 500 }, // BR
  { x: 100, y: 500 }, // BL
];

let dragging_index = -1;
let selected_corner = null;

// ---------- Utilities ----------
function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Canvas CSS->canvas scale factors (for constant on-screen sizes)
function get_canvas_scale() {
  const rect = main_canvas.getBoundingClientRect();
  const sx = main_canvas.width / Math.max(1, rect.width);
  const sy = main_canvas.height / Math.max(1, rect.height);
  const s = (sx + sy) / 2; // isotropic for strokes/radii
  return { sx, sy, s };
}

// Convert a client (CSS) point to canvas (image) pixels
function to_canvas_coords(client_x, client_y) {
  const rect = main_canvas.getBoundingClientRect();
  const { sx, sy } = get_canvas_scale();
  return {
    x: (client_x - rect.left) * sx,
    y: (client_y - rect.top) * sy,
  };
}

// Convert canvas (image) pixels to CSS pixels *relative to the wrapper*
function canvas_to_css(x, y) {
  const rect = main_canvas.getBoundingClientRect();
  const scale_x = rect.width / main_canvas.width;
  const scale_y = rect.height / main_canvas.height;
  return { x: x * scale_x, y: y * scale_y };
}

function show_tooltip_at_canvas(text, cx, cy) {
  const { x, y } = canvas_to_css(cx, cy);
  tooltip.textContent = text;
  tooltip.style.display = 'block';
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}
function hide_tooltip() {
  tooltip.style.display = 'none';
}

// ---------- Magnifier (now rendered at CANVAS CENTER; samples around corner) ----------
function draw_magnifier(
  viewCx,
  viewCy,
  radiusCanvasPx,
  zoom,
  cornerIndex,
  sampleCx,
  sampleCy,
) {
  if (!image_bitmap) return;
  const { s } = get_canvas_scale();

  // Source rectangle in image/canvas pixels to zoom into (centered on the corner)
  const srcHalf = radiusCanvasPx / zoom;
  let sx0 = sampleCx - srcHalf;
  let sy0 = sampleCy - srcHalf;

  // Clamp source rect to image bounds
  const maxSx0 = Math.max(0, main_canvas.width - 2 * srcHalf);
  const maxSy0 = Math.max(0, main_canvas.height - 2 * srcHalf);
  if (sx0 < 0) sx0 = 0;
  if (sy0 < 0) sy0 = 0;
  if (sx0 > maxSx0) sx0 = maxSx0;
  if (sy0 > maxSy0) sy0 = maxSy0;

  // Clip to circle at the *view* center
  main_ctx.save();
  main_ctx.beginPath();
  main_ctx.arc(viewCx, viewCy, radiusCanvasPx, 0, Math.PI * 2);
  main_ctx.clip();

  // Draw the zoomed image inside the circle at the center
  main_ctx.drawImage(
    image_bitmap,
    sx0,
    sy0,
    2 * srcHalf,
    2 * srcHalf,
    viewCx - radiusCanvasPx,
    viewCy - radiusCanvasPx,
    2 * radiusCanvasPx,
    2 * radiusCanvasPx,
  );

  // Draw the two quad edges meeting at this corner, transformed into magnifier space
  if (cornerIndex != null) {
    const c = corners[cornerIndex];
    const prev = corners[(cornerIndex + 3) % 4];
    const next = corners[(cornerIndex + 1) % 4];

    main_ctx.save();
    // Map source rect (sx0..+2srcHalf, sy0..+2srcHalf) -> magnifier box (viewCx±r, viewCy±r)
    main_ctx.translate(viewCx - radiusCanvasPx, viewCy - radiusCanvasPx);
    const scale = radiusCanvasPx / srcHalf; // == (2r)/(2srcHalf)
    main_ctx.scale(scale, scale);
    main_ctx.translate(-sx0, -sy0);

    main_ctx.strokeStyle = 'rgba(0,255,128,0.95)';
    main_ctx.lineWidth = 2; // scaled by transform
    // Edge to prev
    main_ctx.beginPath();
    main_ctx.moveTo(c.x, c.y);
    main_ctx.lineTo(prev.x, prev.y);
    main_ctx.stroke();
    // Edge to next
    main_ctx.beginPath();
    main_ctx.moveTo(c.x, c.y);
    main_ctx.lineTo(next.x, next.y);
    main_ctx.stroke();

    main_ctx.restore();
  }

  // Crosshair for precision (fixed on-screen size; centered in magnifier)
  const arm = UI.crosshairArmCss * s;
  main_ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  main_ctx.lineWidth = 1 * s;
  main_ctx.beginPath();
  main_ctx.moveTo(viewCx - arm, viewCy);
  main_ctx.lineTo(viewCx + arm, viewCy);
  main_ctx.moveTo(viewCx, viewCy - arm);
  main_ctx.lineTo(viewCx, viewCy + arm);
  main_ctx.stroke();

  main_ctx.restore();

  // Subtle ring/shadow around the magnifier
  main_ctx.save();
  main_ctx.shadowColor = 'rgba(0,0,0,0.35)';
  main_ctx.shadowBlur = 6 * s;
  main_ctx.beginPath();
  main_ctx.arc(viewCx, viewCy, radiusCanvasPx, 0, Math.PI * 2);
  main_ctx.strokeStyle = 'rgba(0,0,0,0.22)';
  main_ctx.lineWidth = 2 * s;
  main_ctx.stroke();
  main_ctx.restore();
}

// ---------- Drawing ----------
function draw_grid_and_handles() {
  const divisions = Math.max(1, parseInt(grid_divisions_input.value, 10) || 10);
  const valid = is_valid_quad(corners);
  const { s } = get_canvas_scale();

  // Outer quad
  main_ctx.strokeStyle = valid ? 'rgba(255,255,255,0.8)' : 'rgba(255,0,0,0.9)';
  main_ctx.lineWidth = (valid ? UI.gridStrokeCss : UI.gridStrokeInvalidCss) * s;
  main_ctx.beginPath();
  main_ctx.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < 4; i++) main_ctx.lineTo(corners[i].x, corners[i].y);
  main_ctx.closePath();
  main_ctx.stroke();

  // Tooltip on invalid
  if (!valid) {
    const centroid = corners.reduce(
      (acc, p) => ({ x: acc.x + p.x / 4, y: acc.y + p.y / 4 }),
      { x: 0, y: 0 },
    );
    show_tooltip_at_canvas('U bum', centroid.x, centroid.y);
  } else {
    hide_tooltip();
  }

  // Internal grid lines
  const line_alpha = valid ? 0.4 : 0.6;
  const line_color = valid ? '255,255,255' : '255,0,0';
  const inner_w = UI.innerLineCss * s;

  for (let i = 1; i < divisions; i++) {
    const t = i / divisions;
    // horizontals
    const lx = lerp(corners[0].x, corners[3].x, t);
    const ly = lerp(corners[0].y, corners[3].y, t);
    const rx = lerp(corners[1].x, corners[2].x, t);
    const ry = lerp(corners[1].y, corners[2].y, t);
    main_ctx.strokeStyle = `rgba(${line_color},${line_alpha})`;
    main_ctx.lineWidth = inner_w;
    main_ctx.beginPath();
    main_ctx.moveTo(lx, ly);
    main_ctx.lineTo(rx, ry);
    main_ctx.stroke();
  }
  for (let i = 1; i < divisions; i++) {
    const t = i / divisions;
    // verticals
    const tx = lerp(corners[0].x, corners[1].x, t);
    const ty = lerp(corners[0].y, corners[1].y, t);
    const bx = lerp(corners[3].x, corners[2].x, t);
    const by = lerp(corners[3].y, corners[2].y, t);
    main_ctx.strokeStyle = `rgba(${line_color},${line_alpha})`;
    main_ctx.lineWidth = inner_w;
    main_ctx.beginPath();
    main_ctx.moveTo(tx, ty);
    main_ctx.lineTo(bx, by);
    main_ctx.stroke();
  }

  // Center magnifier (only while dragging)
  if (dragging_index !== -1) {
    const viewCx = main_canvas.width / 2;
    const viewCy = main_canvas.height / 2;
    const rMag = UI.magnifierRadiusCss * s;
    const ci = dragging_index;
    draw_magnifier(
      viewCx,
      viewCy,
      rMag,
      UI.magnifyScale,
      ci,
      corners[ci].x,
      corners[ci].y,
    );
  }

  // Corner handles: always draw at normal size
  const baseRadius = UI.handleRadiusCss * s;
  const strokeW = UI.handleStrokeCss * s;
  main_ctx.strokeStyle = 'rgba(0,255,128,1)';
  main_ctx.lineWidth = strokeW;

  for (let i = 0; i < 4; i++) {
    const { x, y } = corners[i];
    main_ctx.beginPath();
    main_ctx.arc(x, y, baseRadius, 0, Math.PI * 2);
    main_ctx.stroke();
  }
}

function draw() {
  // Clear full canvas in *canvas pixel* space
  main_ctx.setTransform(1, 0, 0, 1, 0, 0);
  main_ctx.clearRect(0, 0, main_canvas.width, main_canvas.height);

  if (image_bitmap) {
    // Draw image at its native resolution (canvas == image size)
    main_ctx.drawImage(image_bitmap, 0, 0);
  }

  draw_grid_and_handles();
}

// ---------- Hit test ----------
function hit_test_corner(mx, my) {
  const { s } = get_canvas_scale();
  const hit_r = UI.handleHitRadiusCss * s;
  for (let i = 0; i < 4; i++) {
    const dx = corners[i].x - mx;
    const dy = corners[i].y - my;
    if (Math.hypot(dx, dy) <= hit_r) return i;
  }
  return -1;
}

// ---------- Events: mouse, touch, keyboard ----------
main_canvas.addEventListener('mousedown', (e) => {
  const { x: mx, y: my } = to_canvas_coords(e.clientX, e.clientY);
  const idx = hit_test_corner(mx, my);
  if (idx !== -1) {
    dragging_index = idx;
    selected_corner = idx;
    draw(); // show center magnifier immediately
  }
});

main_canvas.addEventListener('mousemove', (e) => {
  if (dragging_index === -1) return;
  const { x: mx, y: my } = to_canvas_coords(e.clientX, e.clientY);
  corners[dragging_index].x = Math.min(main_canvas.width, Math.max(0, mx));
  corners[dragging_index].y = Math.min(main_canvas.height, Math.max(0, my));
  draw();
});

window.addEventListener('mouseup', () => {
  if (dragging_index !== -1) {
    dragging_index = -1; // hides center magnifier
    draw();
  }
});

// Click to select/deselect (selection doesn’t change size; just for arrow nudging)
main_canvas.addEventListener('click', (e) => {
  const { x: mx, y: my } = to_canvas_coords(e.clientX, e.clientY);
  const idx = hit_test_corner(mx, my);
  selected_corner = idx !== -1 ? idx : null;
  draw();
});

// Touch support
main_canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const t = e.touches[0];
  const { x: tx, y: ty } = to_canvas_coords(t.clientX, t.clientY);
  const idx = hit_test_corner(tx, ty);
  if (idx !== -1) {
    dragging_index = idx;
    selected_corner = idx;
    draw(); // show center magnifier
  }
});

main_canvas.addEventListener('touchmove', (e) => {
  if (dragging_index === -1) return;
  e.preventDefault();
  const t = e.touches[0];
  const { x: tx, y: ty } = to_canvas_coords(t.clientX, t.clientY);
  corners[dragging_index].x = Math.min(main_canvas.width, Math.max(0, tx));
  corners[dragging_index].y = Math.min(main_canvas.height, Math.max(0, ty));
  draw();
});

window.addEventListener('touchend', () => {
  if (dragging_index !== -1) {
    dragging_index = -1;
    draw(); // hide magnifier
  }
});
window.addEventListener('touchcancel', () => {
  if (dragging_index !== -1) {
    dragging_index = -1;
    draw();
  }
});

// Arrow-key nudging (Shift = 5px) in canvas pixel space
window.addEventListener('keydown', (e) => {
  if (selected_corner === null) return;
  const step = e.shiftKey ? 5 : 1;
  let dx = 0,
    dy = 0;
  switch (e.key) {
    case 'ArrowLeft':
      dx = -step;
      break;
    case 'ArrowRight':
      dx = step;
      break;
    case 'ArrowUp':
      dy = -step;
      break;
    case 'ArrowDown':
      dy = step;
      break;
    default:
      return;
  }
  e.preventDefault();
  const c = corners[selected_corner];
  c.x = Math.min(main_canvas.width, Math.max(0, c.x + dx));
  c.y = Math.min(main_canvas.height, Math.max(0, c.y + dy));
  draw();
});

// Repaint on grid division change
grid_divisions_input.addEventListener('input', draw);

// ---------- File loading ----------
file_input.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const img_bitmap = await create_image_bitmap_from_file(file);
  image_bitmap = img_bitmap;

  // Set canvas INTERNAL size to original image dimensions
  main_canvas.width = image_bitmap.width;
  main_canvas.height = image_bitmap.height;

  // Make wrapper/canvas display fit: wrapper gets matching aspect ratio,
  // CSS scales the canvas to fit inside the wrapper.
  if (wrapper_el) {
    wrapper_el.style.setProperty(
      'aspect-ratio',
      `${image_bitmap.width} / ${image_bitmap.height}`,
    );
  }

  // Seed corners with a small inset inside the image bounds
  const inset = Math.round(
    Math.min(main_canvas.width, main_canvas.height) * 0.04,
  );
  corners = [
    { x: inset, y: inset },
    { x: main_canvas.width - inset, y: inset },
    { x: main_canvas.width - inset, y: main_canvas.height - inset },
    { x: inset, y: main_canvas.height - inset },
  ];

  crop_button.disabled = false;
  draw();
});

async function create_image_bitmap_from_file(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const off = document.createElement('canvas');
      off.width = img.naturalWidth;
      off.height = img.naturalHeight;
      const ctx = off.getContext('2d');
      ctx.drawImage(img, 0, 0);
      src_image_data = ctx.getImageData(0, 0, off.width, off.height);
      createImageBitmap(img).then((bm) => res(bm));
    };
    img.onerror = (e) => rej(e);
    img.src = URL.createObjectURL(file);
  });
}

// ---------- Crop (uses original-resolution coordinates) ----------
crop_button.addEventListener('click', () => {
  if (!image_bitmap || !src_image_data) return;
  if (!is_valid_quad(corners)) {
    alert('Quadrilateral is invalid; fix the corners first.');
    return;
  }
  perform_crop();
});

function perform_crop() {
  // src_quad is already in source (image) pixels, 1:1 with src_image_data
  const src_quad = corners.map((p) => ({ x: p.x, y: p.y }));

  // Choose target size from average edge lengths in source space
  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  const width_a = dist(src_quad[0], src_quad[1]);
  const width_b = dist(src_quad[3], src_quad[2]);
  const target_width = Math.max(1, Math.round((width_a + width_b) / 2));
  const height_a = dist(src_quad[0], src_quad[3]);
  const height_b = dist(src_quad[1], src_quad[2]);
  const target_height = Math.max(1, Math.round((height_a + height_b) / 2));

  const dst_rect = [
    { x: 0, y: 0 },
    { x: target_width, y: 0 },
    { x: target_width, y: target_height },
    { x: 0, y: target_height },
  ];

  const H = compute_homography(src_quad, dst_rect); // src -> dst
  const H_inv = invert_3x3(H); // sample with dst->src

  const dest_ctx = cropped_canvas.getContext('2d');
  cropped_canvas.width = target_width;
  cropped_canvas.height = target_height;
  const dest_image = dest_ctx.createImageData(target_width, target_height);
  const dest_data = dest_image.data;

  for (let j = 0; j < target_height; j++) {
    for (let i = 0; i < target_width; i++) {
      const [x_h, y_h, w_h] = multiply_mat3_vec3(H_inv, [i, j, 1]);
      const src_x = x_h / w_h;
      const src_y = y_h / w_h;
      const [r, g, b, a] = bilinear_sample(src_image_data, src_x, src_y);
      const idx = (j * target_width + i) * 4;
      dest_data[idx + 0] = r;
      dest_data[idx + 1] = g;
      dest_data[idx + 2] = b;
      dest_data[idx + 3] = a;
    }
  }

  dest_ctx.putImageData(dest_image, 0, 0);

  cropped_canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    download_link.href = url;
  }, 'image/png');
}

// ---------- Responsive repaint ----------
const resize_observer = new ResizeObserver(() => {
  draw();
});
if (wrapper_el) resize_observer.observe(wrapper_el);

window.addEventListener('load', () => draw());
window.addEventListener('orientationchange', () => draw());
