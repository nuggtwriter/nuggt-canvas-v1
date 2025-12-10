import React, { useState, useEffect } from 'react';
import { Calendar } from '../ui/Calendar';
import { Button } from '../ui/Button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/Popover';
import { Input } from '../ui/Input';
import { Label } from '../ui/Label';
import { ChevronDown } from 'lucide-react';
import { addDays } from '../../utils/dateHelpers';
import { InputStore } from '../../utils/store';

interface InputNuggtProps {
  id?: string;
  label?: string;
}

const syncToStore = (id: string | undefined, value: string) => {
  if (id) {
    InputStore.setValue(id, value);
  }
};

// 1. Normal Calendar
export const CalendarNuggt: React.FC<InputNuggtProps> = ({ id }) => {
  const [date, setDate] = useState<Date | undefined>(new Date());
  
  useEffect(() => {
    if (date) syncToStore(id, date.toLocaleDateString());
  }, [date, id]);

  const handleSelect = (newDate: Date | undefined) => {
    setDate(newDate);
    if (newDate) {
      console.log('[Calendar] Selected:', newDate.toLocaleDateString());
    }
  };

  return (
    <div className="flex justify-center p-2">
      <Calendar
        mode="single"
        selected={date}
        onSelect={handleSelect}
        className="rounded-md border shadow-sm"
      />
    </div>
  );
};

// 2. Range Calendar
export const RangeCalendarNuggt: React.FC<InputNuggtProps> = ({ id }) => {
  const [range, setRange] = useState<{ from: Date; to?: Date } | undefined>({
    from: new Date(),
    to: addDays(new Date(), 5),
  });

  useEffect(() => {
    if (range?.from && range?.to) {
      const val = `${range.from.toLocaleDateString()} - ${range.to.toLocaleDateString()}`;
      syncToStore(id, val);
    } else if (range?.from) {
      syncToStore(id, range.from.toLocaleDateString());
    }
  }, [range, id]);

  const handleSelect = (newRange: any) => {
    setRange(newRange);
    console.log('[RangeCalendar] Updated');
  };

  return (
    <div className="flex justify-center p-2">
      <Calendar
        mode="range"
        selected={range}
        onSelect={handleSelect}
        numberOfMonths={2}
        className="rounded-lg border shadow-sm"
      />
    </div>
  );
};

// 3. Date Picker
export const DatePickerNuggt: React.FC<InputNuggtProps> = ({ label, id }) => {
  const [date, setDate] = useState<Date | undefined>();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (date) syncToStore(id, date.toLocaleDateString());
  }, [date, id]);

  const handleSelect = (newDate: Date) => {
    setDate(newDate);
    setOpen(false);
    console.log('[DatePicker] Selected:', newDate?.toLocaleDateString());
  };

  return (
    <div className="flex flex-col gap-3 w-full max-w-sm">
      {label && <Label>{label}</Label>}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className="w-full justify-between font-normal text-left"
          >
            {date ? date.toLocaleDateString() : "Select date"}
            <ChevronDown className="h-4 w-4 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={date}
            onSelect={handleSelect}
            className="border-0 shadow-none"
          />
        </PopoverContent>
      </Popover>
    </div>
  );
};

// 4. Time Picker
export const TimePickerNuggt: React.FC<InputNuggtProps> = ({ label, id }) => {
  const [time, setTime] = useState("10:30");

  useEffect(() => {
    syncToStore(id, time);
  }, [time, id]);

  const handleTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTime(e.target.value);
    console.log('[TimePicker] Time:', e.target.value);
  };

  return (
    <div className="flex flex-col gap-3 w-full max-w-sm">
      {label && <Label>{label}</Label>}
      <Input
        type="time"
        value={time}
        onChange={handleTimeChange}
        className="bg-white"
      />
    </div>
  );
};

// 5. Text Input
export const InputTextNuggt: React.FC<InputNuggtProps & { placeholder?: string, type?: string }> = ({ label, placeholder, type, id }) => {
  const [val, setVal] = useState("");

  useEffect(() => {
    syncToStore(id, val);
  }, [val, id]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setVal(e.target.value);
  };

  return (
    <div className="flex flex-col gap-3 w-full max-w-sm">
      {label && <Label>{label}</Label>}
      <Input
        type={type || "text"}
        placeholder={placeholder}
        value={val}
        onChange={handleChange}
        className="bg-white"
      />
    </div>
  );
};