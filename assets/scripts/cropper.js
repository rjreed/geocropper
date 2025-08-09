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
const handle_radius = 10;

// ---------- Utilities ----------
function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Convert a client (CSS) point to canvas (image) pixels
function to_canvas_coords(client_x, client_y) {
  const rect = main_canvas.getBoundingClientRect();
  const scale_x = main_canvas.width / rect.width;
  const scale_y = main_canvas.height / rect.height;
  return {
    x: (client_x - rect.left) * scale_x,
    y: (client_y - rect.top) * scale_y,
  };
}

// Convert canvas (image) pixels to CSS pixels *relative to the wrapper*
function canvas_to_css(x, y) {
  // Canvas fills the wrapper, so use its rect for CSS scaling
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

// ---------- Drawing ----------
function draw_grid_and_handles() {
  const divisions = Math.max(1, parseInt(grid_divisions_input.value, 10) || 10);
  const valid = is_valid_quad(corners);

  // Outer quad
  main_ctx.strokeStyle = valid ? 'rgba(255,255,255,0.8)' : 'rgba(255,0,0,0.9)';
  main_ctx.lineWidth = valid ? 2 : 3;
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

  for (let i = 1; i < divisions; i++) {
    const t = i / divisions;
    // horizontals
    const lx = lerp(corners[0].x, corners[3].x, t);
    const ly = lerp(corners[0].y, corners[3].y, t);
    const rx = lerp(corners[1].x, corners[2].x, t);
    const ry = lerp(corners[1].y, corners[2].y, t);
    main_ctx.strokeStyle = `rgba(${line_color},${line_alpha})`;
    main_ctx.lineWidth = 1;
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
    main_ctx.beginPath();
    main_ctx.moveTo(tx, ty);
    main_ctx.lineTo(bx, by);
    main_ctx.stroke();
  }

  // Handles (transparent fill, green stroke)
  for (let i = 0; i < 4; i++) {
    const { x, y } = corners[i];
    main_ctx.strokeStyle = 'rgba(0,255,128,1)';
    main_ctx.lineWidth = 3;
    main_ctx.beginPath();
    main_ctx.arc(x, y, handle_radius, 0, Math.PI * 2);
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

// ---------- Events: mouse, touch, keyboard ----------
main_canvas.addEventListener('mousedown', (e) => {
  const { x: mx, y: my } = to_canvas_coords(e.clientX, e.clientY);
  for (let i = 0; i < 4; i++) {
    const dx = corners[i].x - mx;
    const dy = corners[i].y - my;
    if (Math.hypot(dx, dy) <= handle_radius + 4) {
      dragging_index = i;
      selected_corner = i;
      return;
    }
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
  dragging_index = -1;
});

// Click to select/deselect
main_canvas.addEventListener('click', (e) => {
  const { x: mx, y: my } = to_canvas_coords(e.clientX, e.clientY);
  let hit = false;
  for (let i = 0; i < 4; i++) {
    const dx = corners[i].x - mx;
    const dy = corners[i].y - my;
    if (Math.hypot(dx, dy) <= handle_radius + 4) {
      selected_corner = i;
      hit = true;
      break;
    }
  }
  if (!hit) selected_corner = null;
});

// Touch support
main_canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const t = e.touches[0];
  const { x: tx, y: ty } = to_canvas_coords(t.clientX, t.clientY);
  for (let i = 0; i < 4; i++) {
    const dx = corners[i].x - tx;
    const dy = corners[i].y - ty;
    if (Math.hypot(dx, dy) <= handle_radius + 4) {
      dragging_index = i;
      selected_corner = i;
      return;
    }
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
  dragging_index = -1;
});
window.addEventListener('touchcancel', () => {
  dragging_index = -1;
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
  // Ensure canvas fills wrapper in CSS (handled by your CSS: width:100%; height:100%)

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
  // Only the CSS size changes; canvas coords remain in image pixels
  draw();
});
if (wrapper_el) resize_observer.observe(wrapper_el);

window.addEventListener('load', () => draw());
window.addEventListener('orientationchange', () => draw());
