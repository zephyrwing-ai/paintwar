import * as THREE from 'three'
import type { Seat } from '../../shared/rules.ts'

/** One saturated colour per seat; tiles use a slightly lighter shade so painters stand out. */
const BASE: Record<Seat, { name: string; css: string; tile: string; body: string }> = {
  p1: { name: '珊瑚红', css: '#ff4d6d', tile: '#ff6b85', body: '#ff8fa3' },
  p2: { name: '天空蓝', css: '#3a86ff', tile: '#4d94ff', body: '#7fb2ff' },
  p3: { name: '柠檬黄', css: '#ffbe0b', tile: '#ffc933', body: '#ffd966' },
  p4: { name: '葡萄紫', css: '#9b5de5', tile: '#a76ef0', body: '#c19af5' },
}

export const SEAT_CSS: Record<Seat, string> = { p1: BASE.p1.css, p2: BASE.p2.css, p3: BASE.p3.css, p4: BASE.p4.css }
export const SEAT_COLOR_NAME: Record<Seat, string> = { p1: BASE.p1.name, p2: BASE.p2.name, p3: BASE.p3.name, p4: BASE.p4.name }

export const PALETTE = (['p1', 'p2', 'p3', 'p4'] as const).map(seat => ({
  css: BASE[seat].css,
  main: new THREE.Color(BASE[seat].css),
  tile: new THREE.Color(BASE[seat].tile),
  body: new THREE.Color(BASE[seat].body),
}))
