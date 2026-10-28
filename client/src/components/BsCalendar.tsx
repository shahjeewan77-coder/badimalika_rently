import { BS_MONTHS_EN, BS_MONTHS_NP, WEEKDAYS_EN, bsToAd, daysInBsMonth, kathmanduToday } from "@shared/bs-calendar";
import { cn } from "@/lib/utils";

/** A compact Bikram Sambat month grid with today highlighted. */
export function BsCalendar({ year, month }: { year: number; month: number }) {
  const today = kathmanduToday();
  const isCurrent = today.bs.year === year && today.bs.month === month;
  const firstWeekday = bsToAd(year, month, 1).getUTCDay();
  const total = daysInBsMonth(year, month);
  const cells: (number | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: total }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <p className="font-semibold">
          {BS_MONTHS_EN[month - 1]} {year}
        </p>
        <p className="text-xs text-muted-foreground">{BS_MONTHS_NP[month - 1]}</p>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center">
        {WEEKDAYS_EN.map((d) => (
          <div key={d} className="pb-1 text-[10px] font-semibold uppercase text-muted-foreground">
            {d.slice(0, 2)}
          </div>
        ))}
        {cells.map((day, i) => {
          const isToday = isCurrent && day === today.bs.day;
          return (
            <div
              key={i}
              className={cn(
                "flex h-8 items-center justify-center rounded-md text-sm tabular-nums",
                day === null && "text-transparent",
                day !== null && !isToday && "text-foreground/80 hover:bg-muted",
                isToday && "bg-primary font-bold text-primary-foreground",
              )}
            >
              {day ?? "·"}
            </div>
          );
        })}
      </div>
    </div>
  );
}
