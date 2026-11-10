const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { runInNewContext } = require('node:vm')

async function check(head, stereoOffset = 0) {
  const eye = (x, yaw, fov) => ({
    position: [x, 1.65, 0],
    orientation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
    fov,
  })
  const views = [
    eye(-0.032, -0.2, [-0.9, 0.6, 0.7, -0.8]),
    eye(0.032, 0.2, [-0.6, 0.9, 0.8, -0.7]),
  ]
  // q と -q は同じ回転。古いアドオンのフォールバックでも中央を向くこと。
  views[1].orientation = views[1].orientation.map((v) => -v)
  let started = false, exiting = false, nextFrame
  const bridge = {
    probe: () => ({ ok: true }),
    prepareGPU: async () => ({ ok: true }),
    createSession: () => ({ width: 64, height: 64, backend: 'openvr', stereoOffset }),
    pollEvents: () => {
      if (exiting) return [{ type: 'exit' }]
      if (started) return []
      started = true
      return [{ type: 'begin' }, { type: 'state', detail: 'focused' }]
    },
    waitFrame: () => new Promise((resolve) => { nextFrame = resolve }),
    beginFrame() {},
    locateViews: () => ({ head, views, valid: true, positionTracked: true, seq: 1 }),
    syncInput: () => [],
    present() {},
    endFrame() {},
    requestExit() { exiting = true; nextFrame({ shouldRender: false }) },
    destroy() {},
  }
  const navigator = {}
  const window = { __xriftOpenXR: bridge }
  const module = { exports: {} }
  const context = { navigator, window, module, DOMException, EventTarget, Event, performance,
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
    MessageChannel: class { port1 = {}; port2 = {} },
  }
  runInNewContext(readFileSync(require.resolve('../electron/webxr-mainworld.cjs'), 'utf8'), context)
  module.exports()
  // app.xrift.net の @pmndrs/xr が immersive-vr で要求する機能。
  const request = navigator.xr.requestSession('immersive-vr', {
    requiredFeatures: ['local-floor'],
    optionalFeatures: ['anchors', 'hand-tracking', 'layers', 'mesh-detection', 'plane-detection', 'dom-overlay', 'hit-test'],
  })
  await assert.rejects(navigator.xr.requestSession('immersive-vr'), { name: 'InvalidStateError' })
  const session = await request
  assert.deepEqual(Array.from(session.enabledFeatures), ['viewer', 'local', 'local-floor'])
  const floor = await session.requestReferenceSpace('local-floor')
  const viewer = await session.requestReferenceSpace('viewer')
  const gl = { canvas: { width: 128, height: 64 }, getContextAttributes: () => ({ antialias: false }) }
  session.updateRenderState({ baseLayer: new window.XRWebGLLayer(session, gl) })
  const result = new Promise((resolve) => {
    session.requestAnimationFrame((_time, frame) => resolve({
      pose: frame.getViewerPose(floor),
      viewer: frame.getPose(viewer, floor),
    }))
  })
  nextFrame({ shouldRender: true })
  const { pose, viewer: viewerPose } = await result
  assert.ok(Math.abs(pose.transform.position.y - (head?.position[1] ?? 1.65)) < 1e-5)
  assert.ok(Math.abs(pose.transform.orientation.y) < 1e-5)
  assert.ok(Math.abs(viewerPose.transform.orientation.y) < 1e-5)
  for (const [i, view] of pose.views.entries()) {
    const expectedSign = i === 0 ? -1 : 1
    assert.equal(view.eye, i === 0 ? 'left' : 'right')
    assert.equal(Math.sign(view.transform.orientation.y), expectedSign)
    const [left, right] = views[i].fov.map(Math.tan)
    const expectedProjectionCenter = (right + left) / (right - left) + 2 * expectedSign * stereoOffset
    assert.ok(Math.abs(view.projectionMatrix[8] - expectedProjectionCenter) < 1e-6)
    assert.equal(session.renderState.baseLayer.getViewport(view).x, i * 64)
  }
  await session.end()
}

;(async () => {
  await check({ position: [0, 1.7, 0], orientation: [0, 0, 0, 1] })
  await check(undefined)
  await check(undefined, 0.05)
  console.log('WebXR stereo and session checks passed')
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
