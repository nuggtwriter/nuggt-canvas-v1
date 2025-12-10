import React, { useState, useEffect } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer
} from 'recharts';
import { Card, CardHeader, CardTitle, CardContent } from '../ui/Card';

interface LineChartNuggtProps {
  id?: string;
  dataStr?: string; // Raw JSON string from props
  xData?: string;
  yData?: string;
  labelX?: string;
  labelY?: string;
  colour?: string;
  title?: string;
}

export const LineChartNuggt: React.FC<LineChartNuggtProps> = ({ 
  id, 
  dataStr, 
  xData = "name", 
  yData = "value", 
  labelX, 
  labelY, 
  colour = "#8884d8",
  title
}) => {
  const [data, setData] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (dataStr) {
      try {
        const parsed = JSON.parse(dataStr);
        if (Array.isArray(parsed)) {
          setData(parsed);
          setError(null);
        } else {
          console.error("[LineChart] Data must be an array:", dataStr);
          setError("Data format invalid (must be array)");
        }
      } catch (e) {
        console.error("[LineChart] Failed to parse data JSON:", e);
        console.log("Problematic String:", dataStr);
        setError("Invalid JSON");
      }
    } else {
      setData([]);
    }
  }, [dataStr]);

  // Parse pipe-separated values for multi-line support
  const yKeys = yData.split('|').map(s => s.trim());
  const colors = colour.split('|').map(s => s.trim());

  return (
    <Card className="w-full flex flex-col">
      {title && (
        <CardHeader className="pb-2 flex-shrink-0">
          <CardTitle className="text-lg">{title}</CardTitle>
        </CardHeader>
      )}
      <CardContent className="flex-1 p-4 pt-0">
        {error ? (
          <div className="h-full flex items-center justify-center text-red-500 text-sm">
            {error}
          </div>
        ) : data.length === 0 ? (
          <div className="h-full flex items-center justify-center text-slate-400 text-sm">
            No data to display
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <LineChart
              data={data}
              margin={{
                top: 5,
                right: 30,
                left: 20,
                bottom: 25,
              }}
            >
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
              <XAxis 
                dataKey={xData} 
                stroke="#6b7280" 
                fontSize={12}
                tickLine={false}
                axisLine={false}
                label={labelX ? { value: labelX, position: 'insideBottom', offset: -15 } : undefined}
              />
              <YAxis 
                stroke="#6b7280" 
                fontSize={12}
                tickLine={false}
                axisLine={false}
                label={labelY ? { value: labelY, angle: -90, position: 'insideLeft' } : undefined}
              />
              <Tooltip 
                contentStyle={{ backgroundColor: '#fff', borderRadius: '8px', border: '1px solid #e5e7eb', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
              />
              <Legend verticalAlign="top" height={36}/>
              {yKeys.map((key, index) => (
                <Line
                  key={key}
                  type="monotone"
                  dataKey={key}
                  stroke={colors[index] || colors[0] || "#8884d8"}
                  activeDot={{ r: 8 }}
                  strokeWidth={2}
                  dot={{ r: 4 }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
};