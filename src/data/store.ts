// Booking data uses Supabase when configured and localStorage as a local-only fallback.

import { useSyncExternalStore } from 'react'
import { isSupabaseConfigured, requireSupabase } from './supabase'

export interface StoredBooking {
  id: string
  reference: string
  paymentReference?: string
  paymentScreenshotPath?: string
  paymentScreenshotData?: string
  courtId: string
  courtName: string
  sport?: string
  dayIso: string
  startHour: number
  endHour: number
  rate: number
  name: string
  mobile: string
  email?: string
  notes?: string
  source: 'customer' | 'admin' | 'reclub'
  status: 'confirmed' | 'reserved' | 'pending' | 'rejected'
  createdAt: string
}

export interface BlockedSlot {
  id: string
  courtId: string
  dayIso: string
  startHour: number
  endHour: number
  reason?: string
  createdAt: string
}

export interface CustomerBookingSlot {
  courtId: string
  courtName: string
  dayIso: string
  startHour: number
  endHour: number
  rate: number
}

interface DbBooking {
  id: string
  reference: string
  payment_reference: string | null
  payment_screenshot_path?: string | null
  court_id: string
  court_name: string
  sport: string | null
  day_iso: string
  start_hour: number
  end_hour: number
  rate: number | string
  name: string
  mobile: string
  email: string | null
  notes: string | null
  source: StoredBooking['source']
  status: StoredBooking['status']
  created_at: string
}

interface DbBlock {
  id: string
  court_id: string
  day_iso: string
  start_hour: number
  end_hour: number
  reason: string | null
  created_at: string
}

interface PublicScheduleRow {
  id: string
  court_id: string
  day_iso: string
  start_hour: number
  end_hour: number
  status: StoredBooking['status'] | 'blocked'
  source: StoredBooking['source'] | null
  sport: string | null
}

const BOOKINGS_KEY = '2500h-bookings'
const BLOCKS_KEY = '2500h-blocked-slots'
const CHANGE_EVENT = '2500h-store-changed'

function read<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T[]) : []
  } catch {
    return []
  }
}

function write<T>(key: string, value: T[]) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Browser storage may be unavailable or full.
  }
}

let bookingsCache: StoredBooking[] = isSupabaseConfigured ? [] : read<StoredBooking>(BOOKINGS_KEY)
let blocksCache: BlockedSlot[] = isSupabaseConfigured ? [] : read<BlockedSlot>(BLOCKS_KEY)

function fromDbBooking(row: DbBooking): StoredBooking {
  return {
    id: row.id,
    reference: row.reference,
    paymentReference: row.payment_reference ?? undefined,
    paymentScreenshotPath: row.payment_screenshot_path ?? undefined,
    courtId: row.court_id,
    courtName: row.court_name,
    sport: row.sport ?? undefined,
    dayIso: row.day_iso,
    startHour: Number(row.start_hour),
    endHour: Number(row.end_hour),
    rate: Number(row.rate),
    name: row.name,
    mobile: row.mobile,
    email: row.email ?? undefined,
    notes: row.notes ?? undefined,
    source: row.source,
    status: row.status,
    createdAt: row.created_at,
  }
}

function fromDbBlock(row: DbBlock): BlockedSlot {
  return {
    id: row.id,
    courtId: row.court_id,
    dayIso: row.day_iso,
    startHour: Number(row.start_hour),
    endHour: Number(row.end_hour),
    reason: row.reason ?? undefined,
    createdAt: row.created_at,
  }
}

function toDbBooking(booking: Omit<StoredBooking, 'id' | 'createdAt'>) {
  return {
    reference: booking.reference,
    payment_reference: booking.paymentReference ?? null,
    payment_screenshot_path: booking.paymentScreenshotPath ?? null,
    court_id: booking.courtId,
    court_name: booking.courtName,
    sport: booking.sport ?? null,
    day_iso: booking.dayIso,
    start_hour: booking.startHour,
    end_hour: booking.endHour,
    rate: booking.rate,
    name: booking.name,
    mobile: booking.mobile,
    email: booking.email ?? null,
    notes: booking.notes ?? null,
    source: booking.source,
    status: booking.status,
  }
}

function mapPublicSchedule(rows: PublicScheduleRow[]) {
  const bookings = rows
    .filter((row) => row.status !== 'blocked')
    .map<StoredBooking>((row) => ({
      id: row.id,
      reference: '',
      courtId: row.court_id,
      courtName: row.court_id,
      sport: row.sport ?? undefined,
      dayIso: row.day_iso,
      startHour: Number(row.start_hour),
      endHour: Number(row.end_hour),
      rate: 0,
      name: row.source === 'reclub' ? 'Reclub' : 'Reserved',
      mobile: '',
      source: row.source ?? 'customer',
      status: row.status as StoredBooking['status'],
      createdAt: '',
    }))
  const blocks = rows
    .filter((row) => row.status === 'blocked')
    .map<BlockedSlot>((row) => ({
      id: row.id,
      courtId: row.court_id,
      dayIso: row.day_iso,
      startHour: Number(row.start_hour),
      endHour: Number(row.end_hour),
      createdAt: '',
    }))
  return { bookings, blocks }
}

export function notifyBookingStoreChanged() {
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

function replaceBookingCache(next: StoredBooking[]) {
  bookingsCache = next
  if (!isSupabaseConfigured) write(BOOKINGS_KEY, bookingsCache)
  notifyBookingStoreChanged()
}

function replaceBlockCache(next: BlockedSlot[]) {
  blocksCache = next
  if (!isSupabaseConfigured) write(BLOCKS_KEY, blocksCache)
  notifyBookingStoreChanged()
}

export function genReference() {
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()
    : Math.random().toString(36).slice(2, 18).toUpperCase()
  return `2500H-${rand}`
}

function screenshotExtension(file: File) {
  const extensions: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  }
  const extension = extensions[file.type]
  if (!extension) throw new Error('Choose a PNG, JPG, or WEBP screenshot.')
  // Keep the upload limit enforced for every booking creation path.
  if (file.size > 3 * 1024 * 1024) throw new Error('The screenshot must be 3 MB or smaller.')
  return extension
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('Could not read the payment screenshot.'))
    reader.onerror = () => reject(new Error('Could not read the payment screenshot.'))
    reader.readAsDataURL(file)
  })
}

function genId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return aStart < bEnd && bStart < aEnd
}

export async function loadPublicSchedule(from: string, to: string) {
  if (!isSupabaseConfigured) return
  const { data, error } = await requireSupabase().rpc('get_public_schedule', {
    p_from: from,
    p_to: to,
  })
  if (error) throw error

  const { bookings, blocks } = mapPublicSchedule((data ?? []) as PublicScheduleRow[])
  bookingsCache = [...bookingsCache.filter((item) => item.dayIso < from || item.dayIso > to), ...bookings]
  blocksCache = [...blocksCache.filter((item) => item.dayIso < from || item.dayIso > to), ...blocks]
  notifyBookingStoreChanged()
}

export async function loadAdminStore() {
  if (!isSupabaseConfigured) return
  const client = requireSupabase()
  const [bookingsResult, blocksResult] = await Promise.all([
    client.from('bookings').select('*').order('day_iso').order('start_hour'),
    client.from('blocked_slots').select('*').order('day_iso').order('start_hour'),
  ])
  if (bookingsResult.error) throw bookingsResult.error
  if (blocksResult.error) throw blocksResult.error

  bookingsCache = ((bookingsResult.data ?? []) as DbBooking[]).map(fromDbBooking)
  blocksCache = ((blocksResult.data ?? []) as DbBlock[]).map(fromDbBlock)
  notifyBookingStoreChanged()
}

export async function lookupCustomerBookings(reference: string, mobile: string) {
  if (!isSupabaseConfigured) {
    const normalizedMobile = mobile.replace(/\D/g, '')
    return getBookings().filter(
      (booking) => booking.source === 'customer'
        && booking.reference.toUpperCase() === reference.trim().toUpperCase()
        && booking.mobile.replace(/\D/g, '') === normalizedMobile,
    )
  }
  const { data, error } = await requireSupabase().rpc('lookup_customer_booking', {
    p_reference: reference.trim(),
    p_mobile: mobile.trim(),
  })
  if (error) throw error
  return ((data ?? []) as DbBooking[]).map(fromDbBooking)
}

export function getBookings(): StoredBooking[] {
  return bookingsCache
}

export async function createCustomerBooking(input: {
  reference: string
  name: string
  mobile: string
  email?: string
  sport: string
  paymentScreenshot: File
  slots: CustomerBookingSlot[]
}) {
  const extension = screenshotExtension(input.paymentScreenshot)
  if (!isSupabaseConfigured) {
    const reference = input.reference || genReference()
    const paymentScreenshotData = await fileToDataUrl(input.paymentScreenshot)
    for (const slot of input.slots) {
      await addBooking({
        reference,
        paymentScreenshotData: input.slots.indexOf(slot) === 0 ? paymentScreenshotData : undefined,
        ...slot,
        sport: input.sport,
        name: input.name,
        mobile: input.mobile,
        email: input.email,
        source: 'customer',
        status: 'reserved',
      })
    }
    return reference
  }

  const client = requireSupabase()
  const screenshotPath = `${input.reference}/${crypto.randomUUID()}.${extension}`
  const { error: uploadError } = await client.storage.from('payment-proofs').upload(
    screenshotPath,
    input.paymentScreenshot,
    { contentType: input.paymentScreenshot.type, upsert: false },
  )
  if (uploadError) throw uploadError

  const { data, error } = await client.rpc('create_customer_booking', {
    p_reference: input.reference,
    p_name: input.name,
    p_mobile: input.mobile,
    p_email: input.email ?? null,
    p_sport: input.sport,
    p_payment_screenshot_path: screenshotPath,
    p_slots: input.slots.map((slot) => ({
      court_id: slot.courtId,
      day_iso: slot.dayIso,
      start_hour: slot.startHour,
      end_hour: slot.endHour,
    })),
  })
  if (error) throw error

  const reference = String(data)
  const optimisticRows = input.slots.map<StoredBooking>((slot, index) => ({
    id: `pending-${reference}-${index}`,
    reference,
    paymentScreenshotPath: index === 0 ? screenshotPath : undefined,
    ...slot,
    sport: input.sport,
    name: input.name,
    mobile: input.mobile,
    email: input.email,
    source: 'customer',
    status: 'reserved',
    createdAt: new Date().toISOString(),
  }))
  bookingsCache = [...bookingsCache, ...optimisticRows]
  notifyBookingStoreChanged()
  return reference
}

export async function addBooking(
  input: Omit<StoredBooking, 'id' | 'reference' | 'createdAt' | 'status'> &
    Partial<Pick<StoredBooking, 'status' | 'reference'>>,
): Promise<StoredBooking> {
  if (isSupabaseConfigured) {
    const payload = toDbBooking({
      ...input,
      reference: input.reference ?? genReference(),
      status: input.status ?? 'confirmed',
    })
    const { data, error } = await requireSupabase().from('bookings').insert(payload).select('*').single()
    if (error) throw error
    const booking = fromDbBooking(data as DbBooking)
    replaceBookingCache([...bookingsCache.filter((item) => !item.id.startsWith('pending-')), booking])
    return booking
  }

  const booking: StoredBooking = {
    ...input,
    id: genId(),
    reference: input.reference ?? genReference(),
    status: input.status ?? 'confirmed',
    createdAt: new Date().toISOString(),
  }
  replaceBookingCache([...bookingsCache, booking])
  return booking
}

export async function updateBooking(id: string, patch: Partial<StoredBooking>) {
  if (isSupabaseConfigured) {
    const columnMap: Partial<Record<keyof StoredBooking, string>> = {
      reference: 'reference',
      paymentReference: 'payment_reference',
      courtId: 'court_id',
      courtName: 'court_name',
      sport: 'sport',
      dayIso: 'day_iso',
      startHour: 'start_hour',
      endHour: 'end_hour',
      rate: 'rate',
      name: 'name',
      mobile: 'mobile',
      email: 'email',
      notes: 'notes',
      source: 'source',
      status: 'status',
    }
    const dbPatch: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(patch) as [keyof StoredBooking, unknown][]) {
      const column = columnMap[key]
      if (column) dbPatch[column] = value ?? null
    }
    const { data, error } = await requireSupabase()
      .from('bookings').update(dbPatch).eq('id', id).select('*').single()
    if (error) throw error
    const updated = fromDbBooking(data as DbBooking)
    replaceBookingCache(bookingsCache.map((booking) => booking.id === id ? updated : booking))
    return
  }
  replaceBookingCache(bookingsCache.map((booking) => (booking.id === id ? { ...booking, ...patch } : booking)))
}

export async function updateCustomerBookingsByReference(
  reference: string,
  status: StoredBooking['status'],
) {
  if (isSupabaseConfigured) {
    const { data, error } = await requireSupabase()
      .from('bookings')
      .update({ status })
      .eq('reference', reference)
      .eq('source', 'customer')
      .select('*')
    if (error) throw error
    const updatedRows = ((data ?? []) as DbBooking[]).map(fromDbBooking)
    const updatedById = new Map(updatedRows.map((booking) => [booking.id, booking]))
    replaceBookingCache(bookingsCache.map((booking) => updatedById.get(booking.id) ?? booking))
    return
  }
  replaceBookingCache(bookingsCache.map((booking) =>
    booking.reference === reference && booking.source === 'customer' ? { ...booking, status } : booking,
  ))
}

export async function removeBooking(id: string) {
  if (isSupabaseConfigured) {
    const { error } = await requireSupabase().from('bookings').delete().eq('id', id)
    if (error) throw error
  }
  replaceBookingCache(bookingsCache.filter((booking) => booking.id !== id))
}

export function getBookingAt(dayIso: string, courtId: string, hour: number) {
  return bookingsCache.find((booking) =>
    booking.status !== 'rejected'
    && booking.dayIso === dayIso
    && booking.courtId === courtId
    && overlaps(booking.startHour, booking.endHour, hour, hour + 1),
  )
}

export function findOverlappingBooking(
  dayIso: string,
  courtId: string,
  startHour: number,
  endHour: number,
  excludeId?: string,
) {
  return bookingsCache.find((booking) =>
    booking.id !== excludeId
    && booking.status !== 'rejected'
    && booking.dayIso === dayIso
    && booking.courtId === courtId
    && overlaps(booking.startHour, booking.endHour, startHour, endHour),
  )
}

export function getBlockedSlots(): BlockedSlot[] {
  return blocksCache
}

export async function addBlockedSlot(input: Omit<BlockedSlot, 'id' | 'createdAt'>): Promise<BlockedSlot> {
  if (isSupabaseConfigured) {
    const { data, error } = await requireSupabase().from('blocked_slots').insert({
      court_id: input.courtId,
      day_iso: input.dayIso,
      start_hour: input.startHour,
      end_hour: input.endHour,
      reason: input.reason ?? null,
    }).select('*').single()
    if (error) throw error
    const block = fromDbBlock(data as DbBlock)
    replaceBlockCache([...blocksCache, block])
    return block
  }
  const block: BlockedSlot = { ...input, id: genId(), createdAt: new Date().toISOString() }
  replaceBlockCache([...blocksCache, block])
  return block
}

export async function removeBlockedSlot(id: string) {
  if (isSupabaseConfigured) {
    const { error } = await requireSupabase().from('blocked_slots').delete().eq('id', id)
    if (error) throw error
  }
  replaceBlockCache(blocksCache.filter((block) => block.id !== id))
}

export function getBlockAt(dayIso: string, courtId: string, hour: number) {
  return blocksCache.find((block) =>
    block.dayIso === dayIso
    && block.courtId === courtId
    && overlaps(block.startHour, block.endHour, hour, hour + 1),
  )
}

export function findOverlappingBlock(
  dayIso: string,
  courtId: string,
  startHour: number,
  endHour: number,
  excludeId?: string,
) {
  return blocksCache.find((block) =>
    block.id !== excludeId
    && block.dayIso === dayIso
    && block.courtId === courtId
    && overlaps(block.startHour, block.endHour, startHour, endHour),
  )
}

export function isSlotTaken(dayIso: string, courtId: string, hour: number) {
  return Boolean(getBookingAt(dayIso, courtId, hour) || getBlockAt(dayIso, courtId, hour))
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback)
  window.addEventListener('storage', callback)
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback)
    window.removeEventListener('storage', callback)
  }
}

let snapshotVersion = 0
window.addEventListener(CHANGE_EVENT, () => {
  snapshotVersion++
})
window.addEventListener('storage', () => {
  snapshotVersion++
})

export function useBookingStoreVersion() {
  return useSyncExternalStore(subscribe, () => snapshotVersion, () => 0)
}
