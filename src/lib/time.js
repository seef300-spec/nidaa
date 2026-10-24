// التاريخ التشغيلي للفرع: يبدأ اليوم عند day_start_hour بتوقيت الفرع (مثلًا 4 فجرًا)
export function isValidTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
export function businessDate(date, timezone, dayStartHour) {
  const shifted = new Date(date.getTime() - dayStartHour * 3600_000);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(shifted);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
