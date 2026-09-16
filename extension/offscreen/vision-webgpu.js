/**
 * Aegis-Agent :: Lens B — on-device visual perception (WebGPU compute)
 *
 * Lens A can only see what the DOM admits to. Text painted into a <canvas>, baked
 * into a screenshot/JPEG, or rendered inside a cross-origin frame we cannot read is
 * invisible to it. Lens B looks at the *pixels*, on the client GPU, and returns
 * text-like regions — which we then treat as un-inspectable PII.
 *
 * Pipeline (all on-device, zero network):
 *   pass 1 (GPU) : per-tile textness descriptor — luminance variance, Sobel energy,
 *                  horizontal/vertical gradient anisotropy, edge-crossing density.
 *   pass 2 (CPU) : threshold -> horizontal morphological closing -> connected
 *                  components -> line-shaped candidate boxes.
 *
 * The tile grid is ~20k cells for a 1440x900 viewport, so pass 2 costs microseconds
 * while pass 1 — 100 texture fetches per cell — is what actually needs the GPU.
 */

const TEXTNESS_WGSL = /* wgsl */ `
struct Params {
  imgW    : u32,
  imgH    : u32,
  tilesX  : u32,
  tilesY  : u32,
  tile    : u32,
  _pad0   : u32,
  _pad1   : u32,
  _pad2   : u32,
};

@group(0) @binding(0) var srcTex : texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> tiles : array<f32>;
@group(0) @binding(2) var<uniform> params : Params;

fn lum(p : vec4<f32>) -> f32 {
  return dot(p.rgb, vec3<f32>(0.299, 0.587, 0.114));
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.tilesX || gid.y >= params.tilesY) { return; }

  let t  = params.tile;
  let ox = i32(gid.x * t);
  let oy = i32(gid.y * t);
  let W  = i32(params.imgW);
  let H  = i32(params.imgH);

  var sum   = 0.0;
  var sumSq = 0.0;
  var hEdge = 0.0;
  var vEdge = 0.0;
  var cross = 0.0;
  var n     = 0.0;
  var minL  = 1.0;
  var maxL  = 0.0;

  for (var j : u32 = 0u; j < t; j = j + 1u) {
    var prevSign = 0.0;
    let y = oy + i32(j);
    if (y >= H) { break; }
    for (var i : u32 = 0u; i < t; i = i + 1u) {
      let x = ox + i32(i);
      if (x >= W) { break; }

      let c  = lum(textureLoad(srcTex, vec2<i32>(x, y), 0));
      let cr = lum(textureLoad(srcTex, vec2<i32>(min(x + 1, W - 1), y), 0));
      let cd = lum(textureLoad(srcTex, vec2<i32>(x, min(y + 1, H - 1)), 0));

      sum   = sum + c;
      sumSq = sumSq + c * c;
      n     = n + 1.0;
      minL  = min(minL, c);
      maxL  = max(maxL, c);

      let dh = cr - c;
      let dv = cd - c;
      hEdge = hEdge + abs(dh);
      vEdge = vEdge + abs(dv);

      // Glyph strokes alternate dark/light many times across a scanline; flat UI
      // chrome and photographic gradients do not.
      if (abs(dh) > 0.12) {
        let s = sign(dh);
        if (prevSign != 0.0 && s != prevSign) { cross = cross + 1.0; }
        prevSign = s;
      }
    }
  }

  let idx = (gid.y * params.tilesX + gid.x) * 4u;
  if (n < 1.0) {
    tiles[idx] = 0.0; tiles[idx + 1u] = 0.0; tiles[idx + 2u] = 0.0; tiles[idx + 3u] = 0.0;
    return;
  }

  let mean     = sum / n;
  let variance = max(0.0, sumSq / n - mean * mean);
  let contrast = maxL - minL;
  let edge     = (hEdge + vEdge) / n;
  let crossD   = cross / n;
  let anis     = hEdge / max(vEdge, 1e-4);

  var score = 0.0;
  if (contrast > 0.20 && edge > 0.030 && crossD > 0.015) {
    score = edge * 6.0 + crossD * 9.0 + contrast * 0.5 + clamp(anis, 0.0, 3.0) * 0.15;
  }

  tiles[idx]      = score;
  tiles[idx + 1u] = variance;
  tiles[idx + 2u] = contrast;
  tiles[idx + 3u] = crossD;
}
`;

/* -------------------------------------------------------------------------- */
/* pass 2: tile map -> candidate boxes (shared by the GPU and CPU back ends)   */
/* -------------------------------------------------------------------------- */

function tilesToRegions(scores, tilesX, tilesY, tile, opts) {
  const threshold = opts.threshold ?? 0.95;
  const closeRun = opts.closeRun ?? 2;   // bridge gaps of N tiles (letter spacing)
  const minTiles = opts.minTiles ?? 3;

  const mask = new Uint8Array(tilesX * tilesY);
  for (let i = 0; i < mask.length; i++) mask[i] = scores[i] >= threshold ? 1 : 0;

  // Horizontal morphological closing: words become lines.
  for (let y = 0; y < tilesY; y++) {
    const row = y * tilesX;
    let lastOn = -99;
    for (let x = 0; x < tilesX; x++) {
      if (mask[row + x]) {
        if (x - lastOn <= closeRun + 1 && lastOn >= 0) {
          for (let k = lastOn + 1; k < x; k++) mask[row + k] = 1;
        }
        lastOn = x;
      }
    }
  }

  // 8-connected components over the tile grid.
  const labels = new Int32Array(tilesX * tilesY).fill(-1);
  const regions = [];
  const stack = [];

  for (let y = 0; y < tilesY; y++) {
    for (let x = 0; x < tilesX; x++) {
      const p = y * tilesX + x;
      if (!mask[p] || labels[p] !== -1) continue;
      const id = regions.length;
      let minX = x, maxX = x, minY = y, maxY = y, count = 0, scoreSum = 0;
      stack.length = 0;
      stack.push(p);
      labels[p] = id;
      while (stack.length) {
        const q = stack.pop();
        const qx = q % tilesX;
        const qy = (q - qx) / tilesX;
        count++;
        scoreSum += scores[q];
        if (qx < minX) minX = qx;
        if (qx > maxX) maxX = qx;
        if (qy < minY) minY = qy;
        if (qy > maxY) maxY = qy;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = qx + dx, ny = qy + dy;
            if (nx < 0 || ny < 0 || nx >= tilesX || ny >= tilesY) continue;
            const np = ny * tilesX + nx;
            if (mask[np] && labels[np] === -1) { labels[np] = id; stack.push(np); }
          }
        }
      }
      if (count < minTiles) continue;

      const w = (maxX - minX + 1) * tile;
      const h = (maxY - minY + 1) * tile;
      const aspect = w / Math.max(h, 1);
      const fill = count / ((maxX - minX + 1) * (maxY - minY + 1));

      // Text lines are wide, thin and densely filled. Reject icons, borders,
      // photographic noise and full-page textures.
      if (h < tile * 1.0) continue;
      if (aspect < 1.2 || aspect > 60) continue;
      if (fill < 0.35) continue;
      if (w * h > 0.35 * tilesX * tile * tilesY * tile) continue;

      regions.push({
        box: { x: minX * tile, y: minY * tile, w, h },
        tiles: count,
        aspect: +aspect.toFixed(2),
        fill: +fill.toFixed(2),
        score: +(scoreSum / count).toFixed(3)
      });
    }
  }

  regions.sort((a, b) => b.score - a.score);
  return regions.slice(0, 120);
}

/* -------------------------------------------------------------------------- */
/* WebGPU back end                                                            */
/* -------------------------------------------------------------------------- */

export class WebGPUTextDetector {
  constructor() {
    this.device = null;
    this.pipeline = null;
    this.adapterInfo = null;
    this.backend = 'webgpu';
  }

  static available() {
    return typeof navigator !== 'undefined' && 'gpu' in navigator;
  }

  async init() {
    if (this.device) return this;
    if (!WebGPUTextDetector.available()) throw new Error('WebGPU unavailable');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('no GPU adapter');
    this.device = await adapter.requestDevice();
    this.device.addEventListener?.('uncapturederror', (e) => console.warn('[aegis:gpu]', e.error?.message));
    try {
      const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
      this.adapterInfo = info ? { vendor: info.vendor, architecture: info.architecture, description: info.description } : null;
    } catch (_) { this.adapterInfo = null; }

    const module = this.device.createShaderModule({ code: TEXTNESS_WGSL, label: 'aegis-textness' });
    this.pipeline = await this.device.createComputePipelineAsync({
      label: 'aegis-textness-pipeline',
      layout: 'auto',
      compute: { module, entryPoint: 'main' }
    });
    return this;
  }

  async detect(bitmap, opts = {}) {
    const tile = opts.tile ?? 8;
    const t0 = performance.now();
    const W = bitmap.width, H = bitmap.height;
    const tilesX = Math.ceil(W / tile);
    const tilesY = Math.ceil(H / tile);
    const cells = tilesX * tilesY;
    const dev = this.device;

    const texture = dev.createTexture({
      size: [W, H, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
    });
    dev.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [W, H]);

    const bytes = cells * 4 * 4;
    const out = dev.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const read = dev.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const params = dev.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(params, 0, new Uint32Array([W, H, tilesX, tilesY, tile, 0, 0, 0]));

    const bind = dev.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: { buffer: out } },
        { binding: 2, resource: { buffer: params } }
      ]
    });

    const enc = dev.createCommandEncoder({ label: 'aegis-detect' });
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(tilesX / 8), Math.ceil(tilesY / 8));
    pass.end();
    enc.copyBufferToBuffer(out, 0, read, 0, bytes);
    dev.queue.submit([enc.finish()]);

    await read.mapAsync(GPUMapMode.READ);
    const raw = new Float32Array(read.getMappedRange().slice(0));
    read.unmap();
    const gpuMs = performance.now() - t0;

    const scores = new Float32Array(cells);
    for (let i = 0; i < cells; i++) scores[i] = raw[i * 4];

    const t1 = performance.now();
    const regions = tilesToRegions(scores, tilesX, tilesY, tile, opts);
    const cpuMs = performance.now() - t1;

    texture.destroy(); out.destroy(); read.destroy(); params.destroy();

    return {
      backend: 'webgpu',
      adapter: this.adapterInfo,
      regions,
      tileMap: opts.wantTileMap ? { scores, tilesX, tilesY, tile } : null,
      timings: { gpuMs: +gpuMs.toFixed(2), groupMs: +cpuMs.toFixed(2) },
      cells
    };
  }

  dispose() {
    try { this.device?.destroy?.(); } catch (_) {}
    this.device = null;
    this.pipeline = null;
  }
}

/* -------------------------------------------------------------------------- */
/* CPU back end — same descriptor, so a machine without WebGPU still redacts   */
/* -------------------------------------------------------------------------- */

export class CpuTextDetector {
  constructor() { this.backend = 'cpu'; this.adapterInfo = null; }
  async init() { return this; }
  dispose() {}

  async detect(bitmap, opts = {}) {
    const tile = opts.tile ?? 8;
    const t0 = performance.now();
    const W = bitmap.width, H = bitmap.height;
    const c = new OffscreenCanvas(W, H);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, W, H);

    const tilesX = Math.ceil(W / tile);
    const tilesY = Math.ceil(H / tile);
    const scores = new Float32Array(tilesX * tilesY);
    const L = (x, y) => {
      const i = (y * W + x) * 4;
      return (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
    };

    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        let sum = 0, sumSq = 0, hE = 0, vE = 0, cross = 0, n = 0, mn = 1, mx = 0;
        for (let j = 0; j < tile; j++) {
          const y = ty * tile + j;
          if (y >= H) break;
          let prev = 0;
          for (let i = 0; i < tile; i++) {
            const x = tx * tile + i;
            if (x >= W) break;
            const cc = L(x, y);
            const cr = L(Math.min(x + 1, W - 1), y);
            const cd = L(x, Math.min(y + 1, H - 1));
            sum += cc; sumSq += cc * cc; n++;
            if (cc < mn) mn = cc;
            if (cc > mx) mx = cc;
            const dh = cr - cc;
            hE += Math.abs(dh);
            vE += Math.abs(cd - cc);
            if (Math.abs(dh) > 0.12) {
              const s = Math.sign(dh);
              if (prev !== 0 && s !== prev) cross++;
              prev = s;
            }
          }
        }
        if (!n) continue;
        const contrast = mx - mn;
        const edge = (hE + vE) / n;
        const crossD = cross / n;
        const anis = hE / Math.max(vE, 1e-4);
        scores[ty * tilesX + tx] =
          (contrast > 0.20 && edge > 0.030 && crossD > 0.015)
            ? edge * 6 + crossD * 9 + contrast * 0.5 + Math.min(anis, 3) * 0.15
            : 0;
      }
    }

    const cpuMs = performance.now() - t0;
    const t1 = performance.now();
    const regions = tilesToRegions(scores, tilesX, tilesY, tile, opts);
    return {
      backend: 'cpu',
      adapter: null,
      regions,
      tileMap: opts.wantTileMap ? { scores, tilesX, tilesY, tile } : null,
      timings: { gpuMs: +cpuMs.toFixed(2), groupMs: +(performance.now() - t1).toFixed(2) },
      cells: tilesX * tilesY
    };
  }
}

export async function createDetector(prefer = 'webgpu') {
  if (prefer !== 'cpu' && WebGPUTextDetector.available()) {
    try { return await new WebGPUTextDetector().init(); } catch (e) {
      console.warn('[aegis] WebGPU init failed, falling back to CPU:', e.message);
    }
  }
  return new CpuTextDetector().init();
}

export { tilesToRegions };
