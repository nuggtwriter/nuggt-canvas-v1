
import React, { useState } from 'react';
import { X, BookOpen, LayoutGrid, Monitor, MousePointerClick, Keyboard, BarChart2 } from 'lucide-react';

const DISPLAY_NUGGTS = [
  {
    id: 'accordion',
    title: 'Accordion',
    desc: 'Creates a collapsible accordion item.',
    syntax: 'accordion: (trigger: <Text>, content: <Text>)',
    example: 'accordion: (trigger: FAQ 1, content: Answer here.)'
  },
  {
    id: 'card',
    title: 'Card',
    desc: 'Creates a simple card with a title and content body.',
    syntax: 'card: (title: <Text>, content: <Text>)',
    example: 'card: (title: Profile, content: User details.)'
  },
  {
    id: 'alert',
    title: 'Alert',
    desc: 'Creates an inline alert box.',
    syntax: 'alert: (title: <Text>, description: <Text>)',
    example: 'alert: (title: Warning, description: Expiring soon.)'
  }
];

const VISUAL_NUGGTS = [
  {
    id: 'line-chart',
    title: 'Line Chart',
    desc: 'Displays a line chart with inline JSON data. Use pipe | to separate multiple y-data/colors.',
    syntax: 'line-chart: [(data: <JSON_Array>, x-data: <key>, y-data: <key>|<key>, colour: <hex>|<hex>), <id>]',
    example: 'line-chart: [(data: [{"x":"Jan","y":10}, {"x":"Feb","y":20}], x-data: x, y-data: y, colour: #2563eb), myChart]'
  }
];

const INPUT_NUGGTS = [
  {
    id: 'input',
    title: 'Input',
    desc: 'Text input field. Supports type text, email, password.',
    syntax: 'input: [(label: <Text>, placeholder: <Text>, type: <text|email>), <id>]',
    example: 'input: [(label: Email, placeholder: user@example.com), emailId]'
  },
  {
    id: 'calendar',
    title: 'Calendar',
    desc: 'Monthly calendar. Pass an ID to reference its value.',
    syntax: 'calendar: [(mode: single), <id>]',
    example: 'calendar: [(mode: single), myCal]'
  },
  {
    id: 'range-calendar',
    title: 'Range Calendar',
    desc: 'Date range selector. Pass an ID to reference its value.',
    syntax: 'range-calendar: [(), <id>]',
    example: 'range-calendar: [(), myRange]'
  },
  {
    id: 'date-picker',
    title: 'Date Picker',
    desc: 'Popover date input. Pass an ID to reference its value.',
    syntax: 'date-picker: [(label: <Text>), <id>]',
    example: 'date-picker: [(label: Birthday), bday]'
  },
  {
    id: 'time-picker',
    title: 'Time Picker',
    desc: 'Time input. Pass an ID to reference its value.',
    syntax: 'time-picker: [(label: <Text>), <id>]',
    example: 'time-picker: [(label: Alarm), alarmTime]'
  }
];

const ACTION_NUGGTS = [
  {
    id: 'button',
    title: 'Button',
    desc: 'Clickable button. Defines a prompt action.',
    syntax: 'button: [(label: <Text>, variant: <Variant>), prompt: <Action Text>]',
    example: 'button: [(label: Search, variant: default), prompt: Search for <queryId>]'
  },
  {
    id: 'alert-dialog',
    title: 'Alert Dialog',
    desc: 'Modal dialog. Prompt executes on Action click.',
    syntax: 'alert-dialog: [(trigger: <Text>, ..., action: <Text>), prompt: <Action Text>]',
    example: 'alert-dialog: [(trigger: Reset, action: Yes), prompt: Resetting graph <graphId>]'
  }
];

const LAYOUT = [
  {
    title: 'Grid Row',
    desc: 'Define a row with N columns.',
    syntax: '[cols]: { <nuggt1>, <nuggt2>, ... }',
    example: '[2]: { alert: (title: A), button: (label: B) }'
  },
  {
    title: 'Spanning',
    desc: 'Explicit spans or "continue" for row spanning.',
    syntax: '[4]: { [3]: <nuggt>, [1]: space }',
    example: ''
  }
];

interface SyntaxGuideProps {
  onClose: () => void;
}

export const SyntaxGuide: React.FC<SyntaxGuideProps> = ({ onClose }) => {
  const [tab, setTab] = useState<'display' | 'visual' | 'input' | 'action' | 'layout'>('display');

  const renderSection = (items: any[]) => (
    items.map(doc => (
      <div key={doc.id || doc.title || doc.name} className="space-y-2">
        <h4 className="font-medium text-slate-900 text-sm border-b pb-1 border-slate-100">{doc.title || doc.name}</h4>
        <p className="text-xs text-slate-500 leading-relaxed">{doc.desc}</p>
        {doc.syntax && (
          <div className="bg-slate-50 p-2 rounded border text-xs font-mono text-slate-600 break-all">
            {doc.syntax}
          </div>
        )}
        <div className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Example</div>
        <code className="block text-xs text-indigo-600 bg-indigo-50 p-2 rounded">
          {doc.example}
        </code>
      </div>
    ))
  );

  return (
    <div className="absolute inset-y-0 right-0 w-96 bg-white shadow-xl border-l z-40 overflow-auto flex flex-col">
      <div className="p-4 border-b bg-slate-50 sticky top-0">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-slate-800 flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-indigo-600"/>
            Nuggt Guide
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex flex-wrap gap-1 rounded-md bg-slate-200 p-1">
          {[
            { id: 'display', icon: Monitor, label: 'Display' },
            { id: 'visual', icon: BarChart2, label: 'Visual' },
            { id: 'input', icon: Keyboard, label: 'Input' },
            { id: 'action', icon: MousePointerClick, label: 'Action' },
            { id: 'layout', icon: LayoutGrid, label: 'Layout' }
          ].map((t) => (
             <button
              key={t.id}
              onClick={() => setTab(t.id as any)}
              className={`flex-1 min-w-[50px] flex items-center justify-center gap-1 text-[10px] font-medium py-1.5 rounded-sm transition-all ${tab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="p-4 space-y-6">
        {tab === 'display' && renderSection(DISPLAY_NUGGTS)}
        {tab === 'visual' && renderSection(VISUAL_NUGGTS)}
        {tab === 'input' && renderSection(INPUT_NUGGTS)}
        {tab === 'action' && renderSection(ACTION_NUGGTS)}
        {tab === 'layout' && renderSection(LAYOUT)}
      </div>
    </div>
  );
};
