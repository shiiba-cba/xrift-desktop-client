// WebXR を経由せず、左右眼の正面方向に同じ十字を描く。
const { OpenVRSession } = require('../bin/xrift_openxr.node')
const session = new OpenVRSession({
  resolutionScale: 0.25,
  useExplicitPose: !process.argv.includes('--default-pose'),
})
const { width, height } = session.getInfo()
const pitch = width * 8
const pixels = new Uint8Array(pitch * height)
const centered = process.argv.includes('--center')
const align = process.argv.includes('--align')
let offset = 0
let quit = false

if (align) {
  if (!process.stdin.isTTY) throw new Error('--align requires an interactive terminal')
  require('node:readline').emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on('keypress', (_text, key) => {
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) quit = true
    if (key.name === 'left' || key.name === 'right') {
      const step = key.shift ? 0.001 : 0.005
      offset = Math.max(-0.3, Math.min(0.3, offset + (key.name === 'right' ? step : -step)))
      console.log(`Stereo offset: ${offset.toFixed(3)}`)
    }
  })
  console.log('Left/right arrows adjust the horizontal separation. Esc finishes.')
}

function drawEye(index, fov) {
  const [left, right, up, down] = Array.from(fov, Math.tan)
  const centerX = (centered ? (left + right) / 2 : 0) + (index === 0 ? offset : -offset) * (right - left)
  const centerY = centered ? (up + down) / 2 : 0
  for (let y = 0; y < height; y++) {
    const v = up - ((y + 0.5) / height) * (up - down) - centerY
    for (let x = 0; x < width; x++) {
      const u = left + ((x + 0.5) / width) * (right - left) - centerX
      const cross = (Math.abs(u) < 0.004 && Math.abs(v) < 0.09) ||
        (Math.abs(v) < 0.004 && Math.abs(u) < 0.09)
      const dot = Math.hypot(u - (index === 0 ? -0.14 : 0.14), v + 0.10) < 0.016
      const offset = y * pitch + (index * width + x) * 4
      pixels[offset] = cross ? 255 : dot && index === 0 ? 240 : 22
      pixels[offset + 1] = cross ? 255 : 22
      pixels[offset + 2] = cross ? 255 : dot && index === 1 ? 240 : 22
      pixels[offset + 3] = 255
    }
  }
}

async function run() {
  const deadline = Date.now() + (align ? 90_000 : 30_000)
  let drawnOffset
  try {
    while (!quit && Date.now() < deadline) {
      if (session.pollEvents().some((event) => event.type === 'exit')) break
      const frame = await session.waitFrame()
      session.beginFrame()
      const view = session.locateViews()
      if (frame.shouldRender && view.valid) {
        if (drawnOffset !== offset) {
          view.views.forEach((eye, index) => drawEye(index, eye.fov))
          if (drawnOffset === undefined) console.log(`Stereo target active (${centered ? 'image center' : 'projection center'}). Left eye: red dot. Right eye: blue dot.`)
          drawnOffset = offset
        }
        session.submitLatched(pixels.buffer, 0, width * 4, pitch, view.seq)
      }
      session.endFrame()
    }
  } finally {
    session.destroy()
    if (align) {
      process.stdin.setRawMode(false)
      process.stdin.pause()
      console.log(`Final stereo offset: ${offset.toFixed(3)}`)
    }
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
