// Drag the divider. The pointer is tracked by screen position rather than by movement
// deltas, so the split lands where the human is pointing even if a frame is dropped.
const raf = { queued: false, ratio: 0 }

function apply(ratio) {
  raf.ratio = ratio
  if (raf.queued) return
  raf.queued = true
  requestAnimationFrame(() => {
    raf.queued = false
    window.divider.set(raf.ratio)
  })
}

document.addEventListener('mousedown', event => {
  if (event.button !== 0) return
  document.body.classList.add('dragging')
  event.preventDefault()

  const onMove = move => apply(move.screenX / window.screen.width)
  const onUp = () => {
    document.body.classList.remove('dragging')
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
})

document.addEventListener('keydown', event => {
  if (event.key === 'ArrowLeft') window.divider.nudge(-0.02)
  else if (event.key === 'ArrowRight') window.divider.nudge(0.02)
})
