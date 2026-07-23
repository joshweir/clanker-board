// "Opened ..." relative time for the ticket meta card (#40). Same-day timestamps read
// as a relative distance ("3 hours ago"); older ones read as an absolute date
// ("22 Jul"), gaining the year once it differs from now ("22 Jul 2025"). Native
// Intl does both, so no date library is needed. The "on " prefix was dropped
// everywhere (#83) so the wording matches the timeline verbatim ("opened 22 Jul",
// not "opened on 22 Jul").
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export function formatOpened(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const sameDay =
    then.getFullYear() === now.getFullYear() &&
    then.getMonth() === now.getMonth() &&
    then.getDate() === now.getDate();

  if (sameDay) {
    const diffMs = then.getTime() - now.getTime();
    // Under an hour reads in minutes ("5 minutes ago"), otherwise in whole hours.
    if (diffMs > -HOUR_MS) {
      return rtf.format(Math.round(diffMs / MINUTE_MS), 'minute');
    }
    return rtf.format(Math.round(diffMs / HOUR_MS), 'hour');
  }

  // en-GB gives day-then-month ("22 Jul" / "22 Jul 2025"), matching the requested shape.
  const opts: Intl.DateTimeFormatOptions =
    then.getFullYear() === now.getFullYear()
      ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' };
  return then.toLocaleDateString('en-GB', opts);
}
