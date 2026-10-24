/* ─────────────────────────────────────────────────────────────
   The regions globe (founders, 2026-10-14: "a globe professional which rolls
   slightly in that place, 4-5 servers ... the areas most tech founders and
   early startups use ... see the example from appwrite").

   Drawn the way cobe draws its globe, in one sphere shader: every fragment
   finds its nearest point on a hexagonal dot lattice, looks up whether that
   point is land in an equirectangular mask (Natural Earth 1:110m land,
   public domain, rasterized to public/media/v7/land-mask.png), and draws a
   round dot there. So dots foreshorten with the curve and stay sharp at any
   size, and the whole globe is one draw call.

   No post-processing on purpose: Chrome's D3D11 backend (the Windows default)
   renders a multisampled half-float target black; the default framebuffer is
   safe and antialiased.

   Regions: all five are live (founders, 2026-10-14: "all are live"). Beyond
   Mumbai they are where startup-focused platforms open first and where most
   startup ecosystems sit (Startup Genome GSER 2025: Silicon Valley, New York,
   London, then Tel Aviv, Boston, Singapore): US East, US West, Frankfurt and
   Singapore. A region added before it opens sets `live: false` and draws as
   a hollow ring, never the violet disc.

   The page names places, never the provider's codes (founders, 2026-10-14:
   Appwrite sells "The Appwrite Network", not its cloud vendor). `code` keeps
   the AWS region behind each place for maintainers; nothing renders it.
───────────────────────────────────────────────────────────── */

import type * as T from 'three'

export type Region = { id: string; name: string; code: string; lat: number; lon: number; live: boolean }

export const REGIONS: Region[] = [
  { id: 'mumbai', name: 'Mumbai', code: 'ap-south-1', lat: 19.08, lon: 72.88, live: true },
  { id: 'frankfurt', name: 'Frankfurt', code: 'eu-central-1', lat: 50.11, lon: 8.68, live: true },
  { id: 'virginia', name: 'US East', code: 'us-east-1', lat: 38.95, lon: -77.45, live: true },
  { id: 'oregon', name: 'US West', code: 'us-west-2', lat: 45.6, lon: -121.2, live: true },
  { id: 'singapore', name: 'Singapore', code: 'ap-southeast-1', lat: 1.35, lon: 103.82, live: true },
]

/** The tour runs west, the way the planet turns under a fixed view. */
const DWELL = 2.8
const TILT = (-9 * Math.PI) / 180
const STEP = (1.2 * Math.PI) / 180

const VS = /* glsl */ `
  varying vec3 vObj;
  varying vec3 vNormalW;
  void main() {
    vObj = position;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const FS = /* glsl */ `
  uniform sampler2D uMask;
  uniform vec3 uBase;
  uniform vec3 uDot;
  uniform vec3 uDotDim;
  uniform vec3 uRim;
  uniform vec3 uLight;
  uniform float uStep;
  uniform float uFade;
  varying vec3 vObj;
  varying vec3 vNormalW;
  const float PI = 3.141592653589793;
  void main() {
    vec3 n = normalize(vObj);
    float lat = asin(clamp(n.y, -1.0, 1.0));
    float lon = atan(-n.z, n.x);

    float row = floor(lat / uStep + 0.5);
    float latC = row * uStep;
    float count = max(1.0, floor(2.0 * PI * cos(latC) / uStep));
    float dLon = 2.0 * PI / count;
    float shift = mod(row, 2.0) * 0.5 * dLon;
    float col = floor((lon - shift) / dLon + 0.5);
    float lonC = col * dLon + shift;
    float dl = mod(lon - lonC + PI, 2.0 * PI) - PI;
    vec2 q = vec2(dl * cos(lat), lat - latC);
    float d = length(q);

    vec2 uv = vec2(fract((lonC + PI) / (2.0 * PI)), (latC + 0.5 * PI) / PI);
    float land = step(0.5, texture2D(uMask, uv).r);
    float r = uStep * 0.31;
    float aa = max(fwidth(d), 1e-5) * 1.1;
    float dotMask = (1.0 - smoothstep(r - aa, r + aa, d)) * land;

    vec3 N = normalize(vNormalW);
    float facing = clamp(N.z, 0.0, 1.0);
    float light = clamp(dot(N, normalize(uLight)), 0.0, 1.0);
    vec3 base = uBase * (0.62 + 0.5 * light);
    vec3 dotCol = mix(uDotDim, uDot, smoothstep(0.05, 0.85, light * 0.75 + facing * 0.35));
    vec3 c = mix(base, dotCol, dotMask);
    c += uRim * pow(1.0 - facing, 3.0);
    gl_FragColor = vec4(c * uFade, uFade);
    #include <colorspace_fragment>
  }
`
export type GlobeHooks = {
  label: (id: string) => HTMLElement | null
  onFocus: (id: string) => void
}

export type Globe = {
  render: (now: number, still?: boolean) => void
  focus: (id: string) => void
  resize: () => void
  dispose: () => void
}

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x))
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)
const rad = (d: number) => (d * Math.PI) / 180

export async function createGlobe(canvas: HTMLCanvasElement, wrap: HTMLElement, hooks: GlobeHooks): Promise<Globe> {
  const THREE = await import('three')

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'default' })
  renderer.setClearColor(0x000000, 0)

  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20)
  camera.position.set(0, 0, 5)
  camera.lookAt(0, 0, 0)

  const disposables: { dispose: () => void }[] = []
  const keep = <D extends { dispose: () => void }>(d: D) => {
    disposables.push(d)
    return d
  }

  const mask = keep(
    await new THREE.TextureLoader().loadAsync('/media/v7/land-mask.png').catch(() => {
      throw new Error('land mask failed to load')
    }),
  )
  mask.wrapS = THREE.RepeatWrapping
  mask.minFilter = THREE.LinearFilter
  mask.magFilter = THREE.LinearFilter
  mask.generateMipmaps = false
  mask.colorSpace = THREE.NoColorSpace

  const tilt = new THREE.Group()
  tilt.rotation.x = TILT
  scene.add(tilt)
  const spin = new THREE.Group()
  tilt.add(spin)

  const globeMat = keep(
    new THREE.ShaderMaterial({
      vertexShader: VS,
      fragmentShader: FS,
      uniforms: {
        uMask: { value: mask },
        uBase: { value: new THREE.Color('#15161b') },
        uDot: { value: new THREE.Color('#a1a1aa') },
        uDotDim: { value: new THREE.Color('#34353c') },
        uRim: { value: new THREE.Color('#ffffff').multiplyScalar(0.025) },
        uLight: { value: new THREE.Vector3(-0.55, 0.75, 0.6) },
        uStep: { value: STEP },
        uFade: { value: 0 },
      },
      transparent: true,
      premultipliedAlpha: true,
    }),
  )
  const globe = new THREE.Mesh(keep(new THREE.SphereGeometry(1, 192, 144)), globeMat)
  spin.add(globe)

  /* The silhouette as a 1px line (the bento's line art) instead of a glow. It
     lies in the view plane at the globe's centre, so it is the outline at any tilt. */
  const outlineMat = keep(new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthTest: false, depthWrite: false }))
  const outline = new THREE.LineLoop(
    keep(
      new THREE.BufferGeometry().setFromPoints(
        Array.from({ length: 360 }, (_, k) => new THREE.Vector3(Math.cos((k / 360) * Math.PI * 2), Math.sin((k / 360) * Math.PI * 2), 0)),
      ),
    ),
    outlineMat,
  )
  outline.renderOrder = 2
  scene.add(outline)

  /* Markers: a disc for the live region, a ring for the rest, both lying on the surface. */
  const toVec = (lat: number, lon: number, r = 1) => {
    const la = rad(lat)
    const lo = rad(lon)
    return new THREE.Vector3(Math.cos(la) * Math.cos(lo) * r, Math.sin(la) * r, -Math.cos(la) * Math.sin(lo) * r)
  }
  const Z = new THREE.Vector3(0, 0, 1)
  // The page's one accent (violet-300) marks live regions; one not yet open is neutral.
  const liveColor = new THREE.Color('#c4b5fd')
  const soonColor = new THREE.Color('#d4d4d8')
  const discGeo = keep(new THREE.CircleGeometry(0.016, 40))
  const ringGeo = keep(new THREE.RingGeometry(0.0105, 0.0165, 40))
  const pulseGeo = keep(new THREE.RingGeometry(0.94, 1.0, 64))
  const focusGeo = keep(new THREE.RingGeometry(0.026, 0.029, 48))

  const markers = REGIONS.map((region, i) => {
    const normal = toVec(region.lat, region.lon).normalize()
    const q = new THREE.Quaternion().setFromUnitVectors(Z, normal)
    const holder = new THREE.Group()
    holder.position.copy(normal.clone().multiplyScalar(1.003))
    holder.quaternion.copy(q)
    spin.add(holder)

    const mat = keep(new THREE.MeshBasicMaterial({ color: region.live ? liveColor : soonColor, transparent: true, depthWrite: false }))
    holder.add(new THREE.Mesh(region.live ? discGeo : ringGeo, mat))

    const focusMat = keep(new THREE.MeshBasicMaterial({ color: region.live ? liveColor : soonColor, transparent: true, opacity: 0, depthWrite: false }))
    const focusRing = new THREE.Mesh(focusGeo, focusMat)
    holder.add(focusRing)

    let pulse: { mesh: T.Mesh; mat: T.MeshBasicMaterial } | null = null
    if (region.live) {
      const pm = keep(new THREE.MeshBasicMaterial({ color: liveColor, transparent: true, opacity: 0, depthWrite: false }))
      const mesh = new THREE.Mesh(pulseGeo, pm)
      holder.add(mesh)
      pulse = { mesh, mat: pm }
    }
    // Offset each pulse so the live regions never blink in unison.
    return { region, normal, holder, focusMat, pulse, phase: (i * 0.37) % 1 }
  })

  /* Framing: the globe's centre sits on the canvas's bottom edge, so it rises
     out of the section like a horizon (Appwrite's composition). */
  let W = 1
  let H = 1
  let R = 1
  function resize() {
    W = Math.max(1, wrap.clientWidth)
    H = Math.max(1, wrap.clientHeight)
    const pr = Math.min(window.devicePixelRatio || 1, 1.5)
    renderer.setPixelRatio(pr)
    renderer.setSize(W, H, false)
    const narrow = W < 640
    R = Math.min(H - (narrow ? 16 : 28), W * (narrow ? 0.6 : 0.42))
    camera.left = -W / 2 / R
    camera.right = W / 2 / R
    camera.top = H / 2 / R
    camera.bottom = -H / 2 / R
    camera.updateProjectionMatrix()
    tilt.position.y = -H / 2 / R
    outline.position.y = tilt.position.y
  }
  resize()

  /* The tour. Longitudes are unwrapped so the globe only ever turns one way. */
  const byId = new Map(REGIONS.map((r) => [r.id, r]))
  let index = 0
  let centerLon = REGIONS[0].lon
  let fromLon = centerLon
  let toLon = centerLon
  let phase: 'dwell' | 'travel' = 'dwell'
  let phaseStart = -1
  let travelDur = 1
  let pinnedUntil = 0
  let focused = REGIONS[0].id
  const startTime = { t: -1 }

  function westOf(from: number, lon: number) {
    let target = lon
    while (target > from - 0.5) target -= 360
    while (target < from - 360) target += 360
    return target
  }
  function travelTo(id: string, now: number) {
    const region = byId.get(id)
    if (!region) return
    fromLon = centerLon
    toLon = westOf(centerLon, region.lon)
    if (Math.abs(toLon - fromLon) < 0.5) toLon = fromLon
    travelDur = 1.3 + (Math.abs(toLon - fromLon) / 90) * 1.25
    phase = 'travel'
    phaseStart = now
    focused = id
    hooks.onFocus(id)
  }

  function focus(id: string) {
    const now = performance.now() / 1000
    index = REGIONS.findIndex((r) => r.id === id)
    pinnedUntil = now + 9
    const region = byId.get(id)
    if (!region) return
    // A pick goes the short way round; only the tour insists on west.
    fromLon = centerLon
    let target = region.lon
    while (target - centerLon > 180) target -= 360
    while (target - centerLon < -180) target += 360
    toLon = target
    travelDur = 0.9 + (Math.abs(toLon - fromLon) / 90) * 0.8
    phase = 'travel'
    phaseStart = now
    focused = id
    hooks.onFocus(id)
  }

  const world = new THREE.Vector3()
  const nWorld = new THREE.Vector3()
  const ndc = new THREE.Vector3()
  const spinQ = new THREE.Quaternion()

  function render(nowMs: number, still = false) {
    const now = nowMs / 1000
    if (startTime.t < 0) startTime.t = now
    const fade = still ? 1 : clamp((now - startTime.t) / 0.9)
    globeMat.uniforms.uFade.value = fade
    outlineMat.opacity = 0.13 * fade

    if (still) {
      centerLon = 38
    } else {
      if (phaseStart < 0) phaseStart = now
      if (phase === 'travel') {
        const k = clamp((now - phaseStart) / travelDur)
        centerLon = fromLon + (toLon - fromLon) * easeInOut(k)
        if (k >= 1) {
          phase = 'dwell'
          phaseStart = now
        }
      } else if (now - phaseStart > DWELL && now > pinnedUntil) {
        index = (index + 1) % REGIONS.length
        travelTo(REGIONS[index].id, now)
      }
    }
    // A slight roll on top of the tour, so the globe is never quite still.
    const roll = still ? 0 : Math.sin(now * 0.35) * 0.6
    spin.rotation.y = -Math.PI / 2 - rad(centerLon + roll)

    /* Markers: the live pulse, the focus ring. */
    for (const m of markers) {
      const isFocus = m.region.id === focused
      m.focusMat.opacity += ((isFocus ? 0.9 : 0) - m.focusMat.opacity) * 0.12
      if (still) m.focusMat.opacity = 0
      if (m.pulse) {
        const a = still ? 0.4 : ((now * 0.55 + m.phase) % 1)
        const s = 0.012 + a * 0.05
        m.pulse.mesh.scale.setScalar(s)
        m.pulse.mat.opacity = (1 - a) * 0.7 * fade
      }
    }

    renderer.render(scene, camera)

    /* Labels follow their markers; they fade at the limb and below the horizon. */
    scene.updateMatrixWorld()
    spin.getWorldQuaternion(spinQ)
    for (const m of markers) {
      const el = hooks.label(m.region.id)
      if (!el) continue
      m.holder.getWorldPosition(world)
      nWorld.copy(m.normal).applyQuaternion(spinQ)
      const facing = nWorld.z
      ndc.copy(world).project(camera)
      const x = (ndc.x * 0.5 + 0.5) * W
      const y = (-ndc.y * 0.5 + 0.5) * H
      const edge = clamp((x - 70) / 60) * clamp((W - 70 - x) / 60)
      const vis = clamp((facing - 0.18) / 0.22) * clamp((H - 14 - y) / 26) * edge * fade
      const isFocus = m.region.id === focused
      const o = vis
      if (o <= 0.003) {
        if (el.style.opacity !== '0') el.style.opacity = '0'
        continue
      }
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`
      el.style.opacity = o.toFixed(3)
      el.dataset.focus = isFocus && !still ? 'true' : 'false'
    }
  }

  function dispose() {
    disposables.forEach((d) => d.dispose())
    renderer.dispose()
  }

  // Compile every program now, while the page is idle, through
  // KHR_parallel_shader_compile where the driver has it: including the objects
  // that start hidden, so no shader compiles the first time something appears
  // mid-scroll (ANGLE's D3D11 translation can stall a frame for 100 ms+).
  const hidden: T.Object3D[] = []
  scene.traverse((o) => {
    if (!o.visible) {
      hidden.push(o)
      o.visible = true
    }
  })
  await renderer.compileAsync(scene, camera).catch(() => undefined)
  for (const o of hidden) o.visible = false

  return { render, focus, resize, dispose }
}
