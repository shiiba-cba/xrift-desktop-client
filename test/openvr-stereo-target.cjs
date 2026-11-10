// WebXR を経由せず、左右眼の正面方向に同じ十字を描く。
const { OpenVRSession } = require('../bin/xrift_openxr.node')
const survey = process.argv.includes('--survey')
const centered = process.argv.includes('--center')
const align = survey || process.argv.includes('--align')
if (align && !process.stdin.isTTY) throw new Error('Alignment requires an interactive terminal')

const session = new OpenVRSession({
  resolutionScale: 0.25,
  useExplicitPose: !survey && !process.argv.includes('--default-pose'),
})
const { width, height } = session.getInfo()
const pitch = width * 8
const pixels = new Uint8Array(pitch * height)
// x/y は頭の正面に対する角度（度）。距離は頭の正面からの奥行き（m）。
const targets = [
  { name: 'far-center', x: 0, y: 0, depth: Infinity },
  { name: 'far-left', x: -22, y: 0, depth: Infinity },
  { name: 'far-right', x: 22, y: 0, depth: Infinity },
  { name: 'far-up', x: 0, y: 18, depth: Infinity },
  { name: 'far-down', x: 0, y: -18, depth: Infinity },
  { name: 'mid-center-2m', x: 0, y: 0, depth: 2 },
  { name: 'near-center-0.75m', x: 0, y: 0, depth: 0.75 },
]
const results = []
let targetIndex = 0
let offset = survey ? 0.05 : 0
let vertical = 0
let quit = false
let displayed = false

function record(matched) {
  if (!displayed || quit) return
  results.push({
    target: targets[targetIndex].name,
    result: matched ? 'matched' : 'skipped',
    horizontal: Number(offset.toFixed(3)),
    vertical: Number(vertical.toFixed(3)),
  })
  displayed = false
  targetIndex++
  quit = targetIndex === targets.length
  if (!quit) console.log(`Next: ${targets[targetIndex].name}`)
}

if (align) {
  require('node:readline').emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on('keypress', (_text, key = {}) => {
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) quit = true
    if (quit) return
    const step = key.shift ? 0.001 : 0.005
    if (key.name === 'left' || key.name === 'right') {
      offset = Math.max(-0.3, Math.min(0.3, offset + (key.name === 'right' ? step : -step)))
      console.log(`Stereo offset: ${offset.toFixed(3)}`)
    }
    if (!survey) return
    if (key.name === 'up' || key.name === 'down') {
      vertical = Math.max(-0.15, Math.min(0.15, vertical + (key.name === 'up' ? step : -step)))
      console.log(`Vertical offset: ${vertical.toFixed(3)}`)
    }
    if (key.name === 'return') record(true)
    if (key.name === 'space') record(false)
    if (key.name === 'r') { offset = 0.05; vertical = 0 }
  })
  console.log(survey
    ? 'Arrows: horizontal/vertical separation. Shift: fine. Enter: matched. Space: skip. R: reset. Esc: finish.'
    : 'Left/right arrows adjust the horizontal separation. Esc finishes.')
  if (survey) console.log(`First: ${targets[0].name}`)
}

function targetRay(head, eye, { Quaternion, Vector3 }) {
  const target = targets[targetIndex]
  const ray = new Vector3(Math.tan(target.x * Math.PI / 180), Math.tan(target.y * Math.PI / 180), -1)
  const headRotation = new Quaternion().fromArray(head.orientation)
  if (Number.isFinite(target.depth)) {
    ray.multiplyScalar(target.depth).applyQuaternion(headRotation)
    ray.add(new Vector3().fromArray(head.position)).sub(new Vector3().fromArray(eye.position))
  } else {
    ray.applyQuaternion(headRotation)
  }
  return ray.applyQuaternion(new Quaternion().fromArray(eye.orientation).invert())
}

function drawEye(index, eye, head, math) {
  const [left, right, up, down] = Array.from(eye.fov, Math.tan)
  const ray = survey ? targetRay(head, eye, math) : null
  const sign = index === 0 ? 1 : -1
  const targetX = ray ? ray.x / -ray.z : centered ? (left + right) / 2 : 0
  const targetY = ray ? ray.y / -ray.z : centered ? (up + down) / 2 : 0
  const centerX = targetX + sign * offset * (right - left)
  const centerY = targetY + sign * vertical * (up - down)
  for (let y = 0; y < height; y++) {
    const v = up - ((y + 0.5) / height) * (up - down) - centerY
    for (let x = 0; x < width; x++) {
      const u = left + ((x + 0.5) / width) * (right - left) - centerX
      const cross = (Math.abs(u) < 0.004 && Math.abs(v) < 0.09) ||
        (Math.abs(v) < 0.004 && Math.abs(u) < 0.09)
      const dot = !survey && Math.hypot(u + sign * 0.14, v + 0.10) < 0.016
      const offset = y * pitch + (index * width + x) * 4
      pixels[offset] = cross ? 255 : dot && index === 0 ? 240 : 22
      pixels[offset + 1] = cross ? 255 : 22
      pixels[offset + 2] = cross ? 255 : dot && index === 1 ? 240 : 22
      pixels[offset + 3] = 255
    }
  }
}

async function run() {
  const deadline = Date.now() + (survey ? 600_000 : align ? 90_000 : 30_000)
  let previous
  try {
    const math = survey ? await import('three') : null
    while (!quit && Date.now() < deadline) {
      if (session.pollEvents().some((event) => event.type === 'exit')) break
      const frame = await session.waitFrame()
      if (quit) break
      session.beginFrame()
      const view = session.locateViews()
      if (frame.shouldRender && view.valid) {
        const settings = `${targetIndex}/${offset}/${vertical}`
        if (settings !== previous && (!survey || view.head)) {
          view.views.forEach((eye, index) => drawEye(index, eye, view.head, math))
          if (previous === undefined && !survey) console.log(`Stereo target active (${centered ? 'image center' : 'projection center'}). Left eye: red dot. Right eye: blue dot.`)
          previous = settings
          displayed = true
        }
        if (displayed) session.submitLatched(pixels.buffer, 0, width * 4, pitch, view.seq)
      }
      session.endFrame()
    }
  } finally {
    session.destroy()
    if (align) {
      process.stdin.setRawMode(false)
      process.stdin.pause()
      if (survey) {
        console.table(results)
        console.log('STEREO_SURVEY ' + JSON.stringify(results))
      } else {
        console.log(`Final stereo offset: ${offset.toFixed(3)}`)
      }
    }
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
