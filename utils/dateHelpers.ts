export type DateRange = {
  from: Date | undefined;
  to?: Date | undefined;
};

export const addDays = (date: Date, days: number): Date => {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
};

export const formatMonth = (date: Date): string => {
  return date.toLocaleString('default', { month: 'long', year: 'numeric' });
};