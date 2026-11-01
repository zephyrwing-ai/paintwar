import type { Action, Input } from '../engine/input'

/**
 * Touch control for phones: swipe anywhere on the arena to turn (a long swipe can turn again
 * mid-gesture), tap or press the dash button to dash. Directions are screen directions; the game
 * maps them to the board, which may be rotated in portrait.
 */
const SWIPE_PX = 22

export class TouchControls {
  private pointer: number | null = null
  private origin = { x: 0, y: 0 }
  private moved = false
  private last: Action | '' = ''
  private readonly trail: HTMLElement

  constructor(root: HTMLElement, private readonly input: Input, private readonly active: () => boolean) {
    const layer = root.querySelector<HTMLElement>('.touch')!
    this.trail = layer.querySelector<HTMLElement>('.touch-dot')!
    const dash = layer.querySelector<HTMLElement>('.touch-dash')!

    const enable = () => document.body.classList.add('has-touch')
    if (matchMedia('(pointer: coarse)').matches) enable()
    window.addEventListener('touchstart', enable, { once: true, passive: true })
    window.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch') this.input.method = 'touch'
    }, { capture: true })

    dash.addEventListener('pointerdown', e => {
      e.preventDefault()
      e.stopPropagation()
      if (this.active()) this.input.tap('dash')
    })

    const canvas = document.querySelector<HTMLCanvasElement>('#game')!
    canvas.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch' || !this.active() || this.pointer !== null) return
      this.pointer = e.pointerId
      this.origin = { x: e.clientX, y: e.clientY }
      this.moved = false
      this.last = ''
      this.trail.style.left = `${e.clientX}px`
      this.trail.style.top = `${e.clientY}px`
      this.trail.classList.add('is-active')
    })
    window.addEventListener('pointermove', e => {
      if (e.pointerId !== this.pointer) return
      const dx = e.clientX - this.origin.x
      const dy = e.clientY - this.origin.y
      if (Math.hypot(dx, dy) < SWIPE_PX) return
      const dir: Action = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up')
      this.moved = true
      if (dir !== this.last) this.input.tap(dir)
      this.last = dir
      // Re-anchor so the same gesture can steer again (an L-shaped swipe = two turns).
      this.origin = { x: e.clientX, y: e.clientY }
      this.trail.style.left = `${e.clientX}px`
      this.trail.style.top = `${e.clientY}px`
    })
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.pointer) return
      this.pointer = null
      this.trail.classList.remove('is-active')
      if (!this.moved && e.type === 'pointerup' && this.active()) this.input.tap('dash')
    }
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }
}
