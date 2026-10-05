import { notifyBookingStoreChanged } from './store'
import { isSupabaseConfigured, requireSupabase } from './supabase'

// The courts are in the Philippines, so booking availability ("today",
// "is this slot past") must always follow Philippine wall-clock time —
// not whatever timezone a visitor's device happens to be set to. This
// builds a Date whose local getters (getHours, getDate, etc.) report
// Asia/Manila time no matter where the browser thinks it is.
export function nowInManila(): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date())

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0')
  const year = get('year')
  const month = get('month') - 1
  const day = get('day')
  const hour = get('hour') % 24 // some locales report midnight as "24"
  const minute = get('minute')
  const second = get('second')

  return new Date(year, month, day, hour, minute, second)
}

export interface BookingCourt {
  id: string
  name: string
  rate: number
}

const defaultBookingCourts: BookingCourt[] = [
  { id: 'A', name: 'Court A — Windward', rate: 600 },
  { id: 'B', name: 'Court B — Leeward', rate: 600 },
  { id: 'C', name: 'Court C — Covered', rate: 600 },
  { id: 'D', name: 'Court D — Covered', rate: 600 },
]

const COURTS_KEY = '2500h-court-settings'

function readBookingCourts(): BookingCourt[] {
  try {
    if (typeof window === 'undefined') return defaultBookingCourts.map((court) => ({ ...court }))
    const raw = window.localStorage.getItem(COURTS_KEY)
    if (!raw) return defaultBookingCourts.map((court) => ({ ...court }))

    const saved = JSON.parse(raw) as Partial<BookingCourt>[]
    if (!Array.isArray(saved)) return defaultBookingCourts.map((court) => ({ ...court }))

    return defaultBookingCourts.map((court) => {
      const stored = saved.find((item) => item.id === court.id)
      if (
        !stored ||
        typeof stored.name !== 'string' ||
        !stored.name.trim() ||
        typeof stored.rate !== 'number' ||
        !Number.isFinite(stored.rate) ||
        stored.rate < 0
      ) {
        return { ...court }
      }
      return { ...court, name: stored.name.trim(), rate: stored.rate }
    })
  } catch {
    return defaultBookingCourts.map((court) => ({ ...court }))
  }
}

export const bookingCourts: BookingCourt[] = readBookingCourts()

export async function loadBookingCourts() {
  if (!isSupabaseConfigured) return
  const { data, error } = await requireSupabase().from('courts').select('id, name, rate').order('id')
  if (error) throw error
  const next = defaultBookingCourts.map((court) => {
    const stored = data?.find((item) => item.id === court.id)
    if (!stored || typeof stored.name !== 'string' || !Number.isFinite(Number(stored.rate))) return { ...court }
    return { ...court, name: stored.name, rate: Number(stored.rate) }
  })
  bookingCourts.splice(0, bookingCourts.length, ...next)
  notifyBookingStoreChanged()
}

export async function saveBookingCourts(updatedCourts: readonly BookingCourt[]) {
  const next = defaultBookingCourts.map((defaultCourt) => {
    const updated = updatedCourts.find((court) => court.id === defaultCourt.id)
    if (
      !updated ||
      !updated.name.trim() ||
      !Number.isFinite(updated.rate) ||
      updated.rate < 0
    ) {
      throw new Error('Each court needs a name and a valid hourly rate.')
    }
    return { ...defaultCourt, name: updated.name.trim(), rate: updated.rate }
  })

  if (isSupabaseConfigured) {
    const { error } = await requireSupabase().from('courts').upsert(
      next.map((court) => ({ id: court.id, name: court.name, rate: court.rate, updated_at: new Date().toISOString() })),
    )
    if (error) throw error
  }

  bookingCourts.splice(0, bookingCourts.length, ...next)
  if (!isSupabaseConfigured) {
    try {
      localStorage.setItem(COURTS_KEY, JSON.stringify(next))
    } catch {
      // Keep the updated values for this session when localStorage is unavailable.
    }
  }
  notifyBookingStoreChanged()
}

export interface HourSlot {
  hour: number // 24h start hour
  label: string // "3–4 PM"
}

function formatHour(h: number) {
  const h12 = h % 12 === 0 ? 12 : h % 12
  const suffix = h < 12 || h === 24 ? 'AM' : 'PM'
  return { h12, suffix }
}

export const hourSlots: HourSlot[] = Array.from({ length: 16 }, (_, i) => {
  const startHour = 8 + i // 8 AM .. 23 (11 PM-midnight)
  const endHour = startHour + 1
  const start = formatHour(startHour)
  const end = formatHour(endHour)
  const label =
    start.suffix === end.suffix
      ? `${start.h12}–${end.h12} ${end.suffix}`
      : `${start.h12} ${start.suffix}–${end.h12} ${end.suffix}`
  return { hour: startHour, label }
})

export interface DayOption {
  date: Date
  iso: string
  weekday: string
  dayNum: number
  isToday: boolean
}

function toLocalDateIso(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function getDayOptions(count = 7, startOffset = 0): DayOption[] {
  const today = nowInManila()
  today.setHours(0, 0, 0, 0)
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(today)
    d.setDate(d.getDate() + i + startOffset)
    return {
      date: d,
      iso: toLocalDateIso(d),
      weekday: d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
      dayNum: d.getDate(),
      isToday: i + startOffset === 0,
    }
  })
}

export function formatFullDate(d: Date) {
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
}

export { isSlotTaken as isSlotBooked } from './store'

export function isSlotPast(dayIso: string, hour: number) {
  const now = nowInManila()
  const slotDate = new Date(`${dayIso}T00:00:00`)
  // A slot only counts as "past" once it has fully ended, not the moment
  // it starts — an 8–9 PM booking should still show through 8:59 PM.
  slotDate.setHours(hour + 1)
  return slotDate.getTime() <= now.getTime()
}
