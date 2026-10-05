import { useMemo, useState } from 'react'
import { formatFullDate, isSlotPast } from '../../data/booking'
import { getBookings, useBookingStoreVersion, type StoredBooking } from '../../data/store'

type StatusFilter = 'all' | StoredBooking['status']

const statusLabels: Record<StoredBooking['status'], string> = {
  confirmed: 'Confirmed',
  reserved: 'Reserved',
  pending: 'Pending',
  rejected: 'Rejected',
}

const statusStyles: Record<StoredBooking['status'], string> = {
  confirmed: 'bg-court/15 text-court',
  reserved: 'bg-citrus/25 text-ink',
  pending: 'bg-citrus/25 text-ink',
  rejected: 'bg-tide/10 text-tide',
}

const filters: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'confirmed', label: 'Confirmed' },
  { id: 'reserved', label: 'Reserved' },
  { id: 'pending', label: 'Pending' },
  { id: 'rejected', label: 'Rejected' },
]

function rangeLabel(startHour: number, endHour: number) {
  const fmt = (h: number) => `${h % 12 || 12}${h < 12 || h === 24 ? 'AM' : 'PM'}`
  return `${fmt(startHour)}–${fmt(endHour)}`
}

interface DayGroup {
  dayIso: string
  bookings: StoredBooking[]
}

export default function ScheduleHistory() {
  const storeVersion = useBookingStoreVersion()
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [query, setQuery] = useState('')

  // A booking belongs in history once its end time has actually passed —
  // same "past" definition isSlotPast uses everywhere else, so this always
  // agrees with what the live bookings calendar considers done.
  const pastByDay = useMemo<DayGroup[]>(() => {
    const groups = new Map<string, StoredBooking[]>()
    getBookings()
      .filter((booking) => isSlotPast(booking.dayIso, booking.endHour - 1))
      .forEach((booking) => {
        const group = groups.get(booking.dayIso) ?? []
        group.push(booking)
        groups.set(booking.dayIso, group)
      })
    return [...groups.entries()]
      .map(([dayIso, bookings]) => ({
        dayIso,
        bookings: [...bookings].sort(
          (a, b) => a.startHour - b.startHour || a.courtName.localeCompare(b.courtName)
        ),
      }))
      .sort((a, b) => b.dayIso.localeCompare(a.dayIso))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeVersion])

  const totalPast = pastByDay.reduce((sum, day) => sum + day.bookings.length, 0)

  const visibleDays = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const digits = needle.replace(/\D/g, '')
    return pastByDay
      .map((day) => ({
        dayIso: day.dayIso,
        bookings: day.bookings.filter((booking) => {
          if (filter !== 'all' && booking.status !== filter) return false
          if (!needle) return true
          return (
            booking.name.toLowerCase().includes(needle) ||
            booking.courtName.toLowerCase().includes(needle) ||
            booking.reference.toLowerCase().includes(needle) ||
            (digits.length > 0 && booking.mobile.replace(/\D/g, '').includes(digits))
          )
        }),
      }))
      .filter((day) => day.bookings.length > 0)
  }, [pastByDay, filter, query])

  const visibleCount = visibleDays.reduce((sum, day) => sum + day.bookings.length, 0)

  return (
    <section className="rounded-card border border-ink/10 bg-sand p-5 shadow-xl shadow-ink/5 sm:p-6">
      <div>
        <h2 className="font-display text-base font-semibold text-ink">Schedule history</h2>
        <p className="mt-1 text-sm text-ink/60">
          Every slot that has already finished, grouped by date — newest first.
        </p>
      </div>

      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
          {filters.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
              className={`min-h-9 rounded-full px-4 text-sm font-semibold transition-colors ${
                filter === item.id ? 'bg-court text-white' : 'bg-white text-ink/65 hover:bg-sand-dim hover:text-ink'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search name, court, mobile, or reference"
          aria-label="Search schedule history"
          className="w-full rounded-xl border border-ink/15 bg-white px-3 py-2.5 text-sm text-ink outline-none transition-all duration-200 focus:border-citrus focus:ring-4 focus:ring-citrus/15 sm:max-w-xs"
        />
      </div>

      {visibleDays.length === 0 ? (
        <p className="mt-5 rounded-xl bg-white px-4 py-5 text-center text-sm text-ink/55">
          {totalPast === 0 ? 'No past bookings yet.' : 'No past bookings match your filters.'}
        </p>
      ) : (
        <>
          <div className="mt-5 space-y-5">
            {visibleDays.map((day) => (
              <div key={day.dayIso}>
                <h3 className="mb-2 text-sm font-semibold text-ink/70">
                  {formatFullDate(new Date(`${day.dayIso}T00:00:00`))}
                </h3>
                <ul className="space-y-2">
                  {day.bookings.map((booking) => (
                    <li
                      key={booking.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink/10 bg-white p-3"
                    >
                      <div className="min-w-0">
                        <p className="font-semibold text-ink">
                          {booking.courtName} · {rangeLabel(booking.startHour, booking.endHour)}
                        </p>
                        <p className="mt-1 text-xs text-ink/55">
                          {booking.name}
                          {booking.mobile ? ` · ${booking.mobile}` : ''}
                          {booking.sport ? ` · ${booking.sport}` : ''}
                        </p>
                      </div>
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusStyles[booking.status]}`}>
                        {statusLabels[booking.status]}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="mt-4 text-right text-sm text-ink/60">
            Showing {visibleCount} of {totalPast}
          </p>
        </>
      )}
    </section>
  )
}
