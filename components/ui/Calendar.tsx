
import React, { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './Button';

const cn = (...classes: (string | undefined | null | false)[]) => classes.filter(Boolean).join(' ');

interface CalendarProps {
  mode?: 'single' | 'range';
  selected?: Date | { from: Date; to?: Date } | undefined;
  onSelect?: (date: any) => void;
  className?: string;
  numberOfMonths?: number;
  defaultMonth?: Date;
  month?: Date;
  onMonthChange?: (date: Date) => void;
  captionLayout?: string;
}

const daysOfWeek = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

export const Calendar = ({
  mode = 'single',
  selected,
  onSelect,
  className,
  numberOfMonths = 1,
  defaultMonth,
  month: controlledMonth,
  onMonthChange
}: CalendarProps) => {
  // Use controlled month if provided, otherwise local state
  const [internalMonth, setInternalMonth] = useState(defaultMonth || new Date());
  const currentMonth = controlledMonth || internalMonth;

  const setCurrentMonth = (date: Date) => {
    if (onMonthChange) {
      onMonthChange(date);
    }
    setInternalMonth(date);
  };

  const getDaysInMonth = (date: Date) => {
    const year = date.getFullYear();
    const month = date.getMonth();
    const days = new Date(year, month + 1, 0).getDate();
    const firstDay = new Date(year, month, 1).getDay();
    return { days, firstDay, year, month };
  };

  const isSameDay = (d1?: Date, d2?: Date) => {
    if (!d1 || !d2) return false;
    return d1.getFullYear() === d2.getFullYear() &&
           d1.getMonth() === d2.getMonth() &&
           d1.getDate() === d2.getDate();
  };

  const isDateInRange = (date: Date, range: { from?: Date; to?: Date }) => {
    if (!range?.from || !range?.to) return false;
    return date > range.from && date < range.to;
  };

  const handleDayClick = (day: number, currentMonthDate: Date) => {
    const clickedDate = new Date(currentMonthDate.getFullYear(), currentMonthDate.getMonth(), day);
    
    if (mode === 'single') {
      onSelect?.(clickedDate);
    } else if (mode === 'range') {
      const currentRange = selected as { from?: Date; to?: Date } | undefined;
      let newRange = { from: clickedDate, to: undefined };

      if (currentRange?.from && !currentRange.to && clickedDate > currentRange.from) {
        newRange = { from: currentRange.from, to: clickedDate };
      } else if (currentRange?.from && !currentRange.to && clickedDate < currentRange.from) {
        newRange = { from: clickedDate, to: currentRange.from };
      }
      
      onSelect?.(newRange);
    }
  };

  const renderMonth = (monthOffset: number) => {
    const displayDate = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + monthOffset, 1);
    const { days, firstDay, year, month } = getDaysInMonth(displayDate);
    const monthName = displayDate.toLocaleString('default', { month: 'long', year: 'numeric' });

    const blanks = Array(firstDay).fill(null);
    const dayNumbers = Array.from({ length: days }, (_, i) => i + 1);

    return (
      <div key={monthOffset} className="space-y-4">
        <div className="flex justify-center pt-1 relative items-center mb-2">
          <div className="text-sm font-medium whitespace-nowrap">{monthName}</div>
        </div>
        <div className="grid grid-cols-7 gap-1">
          {daysOfWeek.map(d => (
            <div key={d} className="text-[0.8rem] text-slate-500 font-normal text-center w-9 h-9 flex items-center justify-center">
              {d}
            </div>
          ))}
          {blanks.map((_, i) => <div key={`blank-${i}`} className="w-9 h-9" />)}
          {dayNumbers.map(day => {
            const date = new Date(year, month, day);
            let isSelected = false;
            let isRangeMiddle = false;
            let isRangeStart = false;
            let isRangeEnd = false;

            if (mode === 'single') {
              isSelected = isSameDay(date, selected as Date);
            } else if (mode === 'range') {
              const r = selected as { from?: Date; to?: Date };
              isRangeStart = isSameDay(date, r?.from);
              isRangeEnd = isSameDay(date, r?.to);
              isSelected = isRangeStart || isRangeEnd;
              isRangeMiddle = isDateInRange(date, r);
            }

            return (
              <button
                key={day}
                onClick={() => handleDayClick(day, displayDate)}
                className={cn(
                  "h-9 w-9 p-0 font-normal text-sm flex items-center justify-center transition-colors focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-1",
                  isSelected && "bg-slate-900 text-slate-50 hover:bg-slate-900 hover:text-slate-50 rounded-md shadow-sm",
                  !isSelected && !isRangeMiddle && "hover:bg-slate-100 rounded-md",
                  isRangeMiddle && "bg-slate-100 text-slate-900 rounded-none",
                  isRangeStart && "rounded-r-none rounded-l-md",
                  isRangeEnd && "rounded-l-none rounded-r-md",
                  (isRangeStart && isRangeEnd) && "rounded-md"
                )}
              >
                {day}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className={cn("p-3 bg-white border rounded-md shadow-sm w-fit", className)}>
      <div className="relative flex items-start gap-4">
        {/* Navigation Buttons: Positioned relative to the first month's header area */}
        <div className="absolute left-1 top-0 z-10">
           <Button 
            variant="ghost" 
            size="icon" 
            className="h-7 w-7 bg-transparent hover:bg-slate-100 p-0" 
            onClick={() => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1))}
           >
             <ChevronLeft className="h-4 w-4" />
           </Button>
        </div>
        <div className="absolute right-1 top-0 z-10">
           <Button 
            variant="ghost" 
            size="icon" 
            className="h-7 w-7 bg-transparent hover:bg-slate-100 p-0" 
            onClick={() => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1))}
           >
             <ChevronRight className="h-4 w-4" />
           </Button>
        </div>
        
        {Array.from({ length: numberOfMonths }).map((_, i) => renderMonth(i))}
      </div>
    </div>
  );
};
