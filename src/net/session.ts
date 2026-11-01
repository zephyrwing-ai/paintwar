import { cleanName, cleanRoom, randomRoom } from '../../shared/protocol.ts'

/**
 * Room codes are public invitations carried in `?room=`. The resume token is private: it lives in
 * this tab's sessionStorage only (a refresh keeps the seat, a new tab is a new player).
 */
const resumeKey = (room: string) => `paintwar_resume_${room}`
const NAME_KEY = 'paintwar_name'

/** The room in `?room=`, or '' when the page was opened without an invitation. */
export function invitedRoom(): string {
  return cleanRoom(new URLSearchParams(location.search).get('room'))
}

export function writeRoom(room: string): void {
  const url = new URL(location.href)
  if (room) url.searchParams.set('room', room)
  else url.searchParams.delete('room')
  url.hash = ''
  history.replaceState(history.state, '', url.href)
}

export function inviteUrl(room: string): string {
  const url = new URL(location.href)
  // Preview/dev-only parameters never go into an invitation.
  for (const key of [...url.searchParams.keys()]) if (key !== 'room') url.searchParams.delete(key)
  url.searchParams.set('room', room)
  url.hash = ''
  return url.href
}

export const newRoomCode = () => randomRoom()

export function loadResume(room: string, endpoint: string): string {
  try {
    const value = JSON.parse(sessionStorage.getItem(resumeKey(room)) ?? '') as { endpoint?: unknown; token?: unknown }
    return value.endpoint === endpoint && typeof value.token === 'string' && value.token.length <= 64 ? value.token : ''
  } catch {
    return ''
  }
}

export function storeResume(room: string, endpoint: string, token: string): void {
  try {
    if (token) sessionStorage.setItem(resumeKey(room), JSON.stringify({ endpoint, token }))
    else sessionStorage.removeItem(resumeKey(room))
  } catch {
    // Private mode: the seat is simply not resumable after a reload.
  }
}

export function socketUrl(endpoint: string, room: string, create: boolean, name: string, resume: string): string {
  const params = new URLSearchParams({ room, create: create ? '1' : '0', name })
  if (resume) params.set('resume', resume)
  return `${endpoint}?${params.toString()}`
}

const ADJECTIVES = ['元气', '闪电', '迷糊', '勇敢', '神秘', '暴躁', '快乐', '酷酷', '彩虹', '无敌', '软萌', '机智']
const NOUNS = ['番茄', '企鹅', '柠檬', '刺猬', '画笔', '熊猫', '海豹', '布丁', '橘猫', '小鲸', '芒果', '跳跳']

export function randomName(random: () => number = Math.random): string {
  return ADJECTIVES[Math.floor(random() * ADJECTIVES.length)] + NOUNS[Math.floor(random() * NOUNS.length)]
}

export function loadName(): string {
  try {
    const saved = cleanName(localStorage.getItem(NAME_KEY))
    if (saved) return saved
  } catch {
    // ignore
  }
  return randomName()
}

export function storeName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name)
  } catch {
    // ignore
  }
}
