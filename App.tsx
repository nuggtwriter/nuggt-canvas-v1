
import React, { useState, useEffect, useRef } from 'react';
import { Send, Loader2, Sparkles, Play, ChevronRight, X, ChevronDown, Code2, Eye, GraduationCap, FileText } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

// Available AI models
const AI_MODELS = [
  { id: 'claude-opus-4.5', name: 'Claude Opus 4.5', provider: 'anthropic' },
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'anthropic' },
  { id: 'gemini-3-pro', name: 'Gemini 3 Pro', provider: 'google' },
  { id: 'gpt-5.1', name: 'GPT-5.1', provider: 'openai' },
  { id: 'gpt-oss-20b', name: 'GPT-OSS 20B', provider: 'openrouter' },
] as const;

type ModelId = typeof AI_MODELS[number]['id'];
import { parseDSL, ParsedNode, ParsedGrid, ParsedElement, GridCell } from './utils/parser';
import { generateUI, DebugEvent, generateWithToolCallingAgent, ToolCallingEvent } from './utils/gemini';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from './components/ui/Accordion';
import { Card, CardHeader, CardTitle, CardContent } from './components/ui/Card';
import { Alert, AlertTitle, AlertDescription } from './components/ui/Alert';
import { Button } from './components/ui/Button';
import { PreviewAlertDialog } from './components/ui/AlertDialog';
import { ToastContainer, ToastMessage } from './components/ui/Toast';
import { Confetti } from './components/ui/Confetti';
import { 
  Table, 
  TableBody, 
  TableCaption, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from './components/ui/Table';
import { eventBus } from './utils/events';
import { 
  CalendarNuggt, 
  RangeCalendarNuggt, 
  DatePickerNuggt, 
  TimePickerNuggt,
  InputTextNuggt
} from './components/nuggts/CalendarWrappers';
import { LineChartNuggt } from './components/nuggts/VisualWrappers';
import { ImageNuggt } from './components/ui/Image';

// Nuggt type categories
const DISPLAY_TYPES = ['card', 'alert', 'accordion', 'accordion-group', 'text', 'table', 'image'];
const VISUAL_TYPES = ['line-chart', 'bar-chart', 'pie-chart'];
const INPUT_TYPES = ['input', 'calendar', 'range-calendar', 'date-picker', 'time-picker'];
const ACTION_TYPES = ['button', 'alert-dialog'];

const isMarkdownNode = (node: ParsedNode): boolean => {
  if ((node as ParsedElement).type === 'markdown') return true;
  if (node.type === 'grid') {
    const gridNode = node as ParsedGrid;
    return (
      gridNode.cells.length === 1 &&
      !!gridNode.cells[0].content &&
      gridNode.cells[0].content.type === 'markdown'
    );
  }
  return false;
};

const isCanvasableElement = (el: ParsedElement): boolean => {
  return DISPLAY_TYPES.includes(el.type) || VISUAL_TYPES.includes(el.type);
};

const isInputElement = (el: ParsedElement): boolean => {
  return INPUT_TYPES.includes(el.type);
};

const isActionElement = (el: ParsedElement): boolean => {
  return ACTION_TYPES.includes(el.type);
};

// Check if a node contains only canvasable elements
const isCanvasableNode = (node: ParsedNode): boolean => {
  if (node.type === 'grid') {
    const gridNode = node as ParsedGrid;
    return gridNode.cells.every(cell => 
      !cell.content || isCanvasableElement(cell.content)
    );
  }
  const el = node as ParsedElement;
  return isCanvasableElement(el);
};

const splitNodes = (nodes: ParsedNode[]) => {
  const ui: ParsedNode[] = [];
  const markdown: ParsedNode[] = [];
  nodes.forEach(node => (isMarkdownNode(node) ? markdown.push(node) : ui.push(node)));
  return { ui, markdown };
};

// Split UI nodes into canvasable (display/visual) and interactive (input/action)
const splitUINodes = (nodes: ParsedNode[]) => {
  const canvasable: ParsedNode[] = [];
  const interactive: ParsedNode[] = [];
  
  nodes.forEach(node => {
    if (node.type === 'grid') {
      const gridNode = node as ParsedGrid;
      // Check if all cells are canvasable
      const allCanvasable = gridNode.cells.every(cell => 
        !cell.content || isCanvasableElement(cell.content)
      );
      const hasInteractive = gridNode.cells.some(cell => 
        cell.content && (isInputElement(cell.content) || isActionElement(cell.content))
      );
      
      if (allCanvasable) {
        canvasable.push(node);
      } else if (hasInteractive) {
        interactive.push(node);
      } else {
        // Mixed - add to canvasable by default
        canvasable.push(node);
      }
    } else {
      const el = node as ParsedElement;
      if (isCanvasableElement(el)) {
        canvasable.push(node);
      } else if (isInputElement(el) || isActionElement(el)) {
        interactive.push(node);
      }
    }
  });
  
  return { canvasable, interactive };
};

const cloneElement = (element: ParsedElement, prefix: string): ParsedElement => ({
  ...element,
  id: `${prefix}-${element.id}`,
  props: { ...element.props }
});

const cloneNode = (node: ParsedNode, prefix: string): ParsedNode => {
  if (node.type === 'grid') {
    const gridNode = node as ParsedGrid;
    return {
      ...gridNode,
      id: `${prefix}-${gridNode.id}`,
      cells: gridNode.cells.map(cell => ({
        ...cell,
        id: `${prefix}-${cell.id}`,
        content: cell.content ? cloneElement(cell.content, prefix) : undefined
      }))
    };
  }
  return cloneElement(node as ParsedElement, prefix);
};

// Helper to quote text values that may contain special characters
const quoteText = (text: string): string => {
  // If text contains comma, colon, parentheses, or special chars, wrap in "<...>"
  if (/[,:()\[\]{}]/.test(text) || text.includes('\n')) {
    return `"<${text}>"`;
  }
  return text;
};

// Serialize a ParsedElement back to DSL string
const serializeElement = (el: ParsedElement): string => {
  if (el.type === 'markdown') {
    return el.markdown || '';
  }
  
  if (el.type === 'accordion-group') {
    return (el.items || []).map(item => 
      `accordion: (trigger: ${quoteText(item.trigger || '')}, content: ${quoteText(item.content || '')})`
    ).join('\n');
  }

  const propsStr = Object.entries(el.props)
    .map(([k, v]) => `${k}: ${quoteText(v)}`)
    .join(', ');

  if (el.actionPrompt) {
    return `${el.type}: [ (${propsStr}), prompt: ${quoteText(el.actionPrompt)} ]`;
  } else if (el.inputId) {
    return `${el.type}: [ (${propsStr}), ${el.inputId} ]`;
  } else {
    return `${el.type}: (${propsStr})`;
  }
};

// Serialize nodes to DSL
const serializeNodes = (nodes: ParsedNode[]): string => {
  const lines: string[] = [];
  
  nodes.forEach(node => {
    if (node.type === 'grid') {
      const gridNode = node as ParsedGrid;
      // Group cells by rows based on their position
      const cellsByRow: Map<number, { cell: GridCell; colStart: number }[]> = new Map();
      let currentRow = 0;
      let currentCol = 0;
      
      gridNode.cells.forEach(cell => {
        if (currentCol >= gridNode.columns) {
          currentRow++;
          currentCol = 0;
        }
        
        if (!cellsByRow.has(currentRow)) {
          cellsByRow.set(currentRow, []);
        }
        cellsByRow.get(currentRow)!.push({ cell, colStart: currentCol });
        currentCol += cell.colSpan;
      });
      
      cellsByRow.forEach((rowCells) => {
        const cellStrs = rowCells.map(({ cell }) => {
          if (cell.type === 'space') return 'space';
          if (cell.content) {
            const contentStr = serializeElement(cell.content);
            if (cell.colSpan > 1) {
              return `[${cell.colSpan}]: ${contentStr}`;
            }
            return contentStr;
          }
          return 'space';
        });
        lines.push(`[${gridNode.columns}]: { ${cellStrs.join(', ')} }`);
      });
    } else {
      lines.push(serializeElement(node as ParsedElement));
    }
  });
  
  return lines.join('\n');
};

interface SelectableNuggtRendererProps {
  nodes: ParsedNode[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  selectable?: boolean;
}

const SelectableNuggtRenderer = ({ nodes, selectedIds, onToggleSelect, selectable = false }: SelectableNuggtRendererProps) => {
  const renderElement = (el: ParsedElement) => {
    if (el.type === 'markdown') {
      return (
        <div className="prose prose-base prose-slate max-w-none text-slate-600 mb-4 leading-relaxed">
          <ReactMarkdown>{el.markdown || ''}</ReactMarkdown>
        </div>
      );
    }

    // TYPE 1: DISPLAY - All text fields render as markdown
    
    // New: Text display component for rich markdown content
    if (el.type === 'text') {
      return (
        <div key={el.id} className="w-full h-full bg-white rounded-lg border shadow-sm hover:shadow-md transition-shadow p-5">
          <div className="prose prose-base prose-slate max-w-none">
            <ReactMarkdown>{el.props.content || ""}</ReactMarkdown>
          </div>
        </div>
      );
    }
    
    // Individual accordion (used inside grids)
    if (el.type === 'accordion') {
      return (
        <Accordion key={el.id} type="single" collapsible className="w-full bg-white rounded-lg px-4 border shadow-sm hover:shadow-md transition-shadow text-base">
          <AccordionItem value="item-0">
            <AccordionTrigger>
              <span className="prose prose-base prose-slate">
                <ReactMarkdown>{el.props.trigger || "Title"}</ReactMarkdown>
              </span>
            </AccordionTrigger>
            <AccordionContent>
              <div className="prose prose-base prose-slate max-w-none">
                <ReactMarkdown>{el.props.content || "Content"}</ReactMarkdown>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      );
    }
    
    // Grouped accordions (multiple consecutive accordions outside grids)
    if (el.type === 'accordion-group') {
      return (
        <Accordion key={el.id} type="single" collapsible className="w-full bg-white rounded-lg px-4 border shadow-sm hover:shadow-md transition-shadow text-base">
          {el.items?.map((item: any, i: number) => (
            <AccordionItem key={item.id} value={`item-${i}`}>
              <AccordionTrigger>
                <span className="prose prose-base prose-slate">
                  <ReactMarkdown>{item.trigger || "Title"}</ReactMarkdown>
                </span>
              </AccordionTrigger>
              <AccordionContent>
                <div className="prose prose-base prose-slate max-w-none">
                  <ReactMarkdown>{item.content || "Content"}</ReactMarkdown>
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      );
    }
    
    if (el.type === 'card') {
      return (
        <Card key={el.id} className="w-full h-full hover:shadow-md transition-shadow">
          <CardHeader>
            <CardTitle className="prose prose-base prose-slate text-lg">
              <ReactMarkdown>{el.props.title || "Card Title"}</ReactMarkdown>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="prose prose-base prose-slate max-w-none text-slate-600">
              <ReactMarkdown>{el.props.content || "Card Content"}</ReactMarkdown>
            </div>
          </CardContent>
        </Card>
      );
    }

    if (el.type === 'alert') {
      return (
        <Alert key={el.id} className="bg-white h-full hover:shadow-md transition-shadow">
          <AlertTitle className="prose prose-base prose-slate text-base font-semibold">
            <ReactMarkdown>{el.props.title || "Heads up!"}</ReactMarkdown>
          </AlertTitle>
          <AlertDescription>
            <div className="prose prose-base prose-slate max-w-none">
              <ReactMarkdown>{el.props.description || "Description goes here."}</ReactMarkdown>
            </div>
          </AlertDescription>
        </Alert>
      );
    }

    // Table component
    if (el.type === 'table') {
      let columns: string[] = [];
      let data: Record<string, string>[] = [];
      const caption = el.props.caption || '';
      
      // Parse columns - can be JSON array or pipe-separated
      try {
        if (el.props.columns) {
          if (el.props.columns.startsWith('[')) {
            columns = JSON.parse(el.props.columns);
          } else {
            columns = el.props.columns.split('|').map((c: string) => c.trim());
          }
        }
      } catch (e) {
        columns = el.props.columns?.split('|').map((c: string) => c.trim()) || [];
      }
      
      // Parse data - JSON array of objects or arrays
      try {
        if (el.props.data) {
          const parsed = JSON.parse(el.props.data);
          if (Array.isArray(parsed)) {
            data = parsed.map((row: any) => {
              if (Array.isArray(row)) {
                // Convert array to object using column names as keys
                const obj: Record<string, string> = {};
                columns.forEach((col, i) => {
                  obj[col] = row[i] || '';
                });
                return obj;
              }
              return row;
            });
          }
        }
      } catch (e) {
        console.error('Failed to parse table data:', e);
      }
      
      return (
        <div key={el.id} className="w-full">
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-gradient-to-r from-slate-50 to-slate-100 border-b-2 border-slate-200">
                  {columns.map((col, i) => (
                    <TableHead 
                      key={i} 
                      className={`text-slate-700 font-semibold text-sm uppercase tracking-wide py-4 ${i === columns.length - 1 ? "text-right" : ""}`}
                    >
                      {col}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((row, rowIndex) => (
                  <TableRow 
                    key={rowIndex} 
                    className={`${rowIndex % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'} hover:bg-indigo-50/50 transition-colors`}
                  >
                    {columns.map((col, colIndex) => (
                      <TableCell 
                        key={colIndex} 
                        className={`py-4 text-slate-700 ${colIndex === 0 ? "font-medium text-slate-900" : ""} ${colIndex === columns.length - 1 ? "text-right" : ""}`}
                      >
                        {row[col] || ''}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {caption && (
            <p className="text-center text-sm text-slate-500 mt-3 italic">{caption}</p>
          )}
        </div>
      );
    }

    // TYPE 4: VISUAL
    if (el.type === 'line-chart') {
      return (
        <LineChartNuggt 
          key={el.id}
          id={el.inputId}
          dataStr={el.props.data}
          xData={el.props['x-data']}
          yData={el.props['y-data']}
          labelX={el.props.label_x}
          labelY={el.props.label_y}
          colour={el.props.colour}
          title={el.props.title}
        />
      );
    }

    // TYPE 2: USER INPUT
    if (el.type === 'calendar') {
      return <CalendarNuggt key={el.id} id={el.inputId} />;
    }
    if (el.type === 'range-calendar') {
      return <RangeCalendarNuggt key={el.id} id={el.inputId} />;
    }
    if (el.type === 'date-picker') {
      return <DatePickerNuggt key={el.id} label={el.props.label} id={el.inputId} />;
    }
    if (el.type === 'time-picker') {
      return <TimePickerNuggt key={el.id} label={el.props.label} id={el.inputId} />;
    }
    if (el.type === 'input') {
      return <InputTextNuggt key={el.id} label={el.props.label} placeholder={el.props.placeholder} type={el.props.type} id={el.inputId} />;
    }

    // TYPE 3: ACTION
    if (el.type === 'button') {
      return (
        <div key={el.id} className="flex h-full items-center">
          <Button 
            variant={(el.props.variant as any) || 'default'}
            actionPrompt={el.actionPrompt}
            className="w-full shadow-sm hover:shadow transition-all"
          >
            {el.props.label || "Button"}
          </Button>
        </div>
      );
    }

    if (el.type === 'alert-dialog') {
      return (
        <div key={el.id} className="flex h-full items-center">
          <PreviewAlertDialog 
            trigger={el.props.trigger || "Open"}
            title={el.props.title || "Are you sure?"}
            description={el.props.description || "This action cannot be undone."}
            cancelText={el.props.cancel}
            actionText={el.props.action}
            actionPrompt={el.actionPrompt}
          />
        </div>
      );
    }

    // TYPE 5: IMAGE
    if (el.type === 'image') {
      return (
        <ImageNuggt
          key={el.id}
          src={el.props.src || ''}
          alt={el.props.alt || 'Image'}
          caption={el.props.caption}
          rounded={(el.props.rounded as any) || 'lg'}
          objectFit={(el.props['object-fit'] as any) || 'cover'}
        />
      );
    }

    return <div key={el.id} className="p-4 border border-dashed border-slate-300 text-slate-400 text-sm rounded-lg bg-slate-50/50">Unknown Nuggt: {el.type}</div>;
  };

  const wrapWithSelection = (nodeId: string, content: React.ReactNode, key?: string) => {
    if (!selectable) return <div key={key}>{content}</div>;
    
    const isSelected = selectedIds.has(nodeId);
    return (
      <div
        key={key}
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect(nodeId);
        }}
        className={`cursor-pointer transition-all duration-200 rounded-lg ${
          isSelected 
            ? 'ring-2 ring-indigo-500 ring-offset-2 bg-indigo-50/30' 
            : 'hover:ring-2 hover:ring-slate-300 hover:ring-offset-1'
        }`}
      >
        {content}
      </div>
    );
  };

  return (
    <div className="w-full space-y-6">
      {nodes.map((node) => {
        if (node.type === 'grid') {
          const gridNode = node as ParsedGrid;
          // Render the grid - but make each CELL selectable, not the whole grid
          return (
            <div 
              key={gridNode.id} 
              className="grid gap-4 w-full mb-6"
              style={{ gridTemplateColumns: `repeat(${gridNode.columns}, minmax(0, 1fr))` }}
            >
              {gridNode.cells.map((cell) => {
                if (cell.type === 'space') {
                  return (
                    <div 
                      key={cell.id} 
                      style={{ gridColumn: `span ${cell.colSpan}`, gridRow: `span ${cell.rowSpan}` }} 
                    />
                  );
                }
                if (cell.type === 'nuggt' && cell.content) {
                  // Use the cell.content.id for selection (the actual component ID)
                  const componentId = cell.content.id;
                  return (
                    <div 
                      key={cell.id} 
                      style={{ gridColumn: `span ${cell.colSpan}`, gridRow: `span ${cell.rowSpan}` }}
                    >
                      {wrapWithSelection(componentId, renderElement(cell.content), componentId)}
                    </div>
                  );
                }
                return null;
              })}
            </div>
          );
        } else {
          return wrapWithSelection(
            node.id,
            <div className="mb-4">{renderElement(node as ParsedElement)}</div>,
            node.id
          );
        }
      })}
    </div>
  );
};

// Non-selectable version for preview
const NuggtRenderer = ({ nodes }: { nodes: ParsedNode[] }) => {
  return <SelectableNuggtRenderer nodes={nodes} selectedIds={new Set()} onToggleSelect={() => {}} selectable={false} />;
};


type PreviewState = {
  nodes: ParsedNode[];
  uiNodes: ParsedNode[];
  markdownNodes: ParsedNode[];
  canvasableNodes: ParsedNode[];  // Display + Visual types only
  interactiveNodes: ParsedNode[]; // Input + Action types
};

// Writing phrases for the loading state
const WRITING_PHRASES = [
  'Crafting your response...',
  'Putting thoughts together...',
  'Composing the answer...',
  'Building something great...',
  'Working on it...',
  'Almost there...',
  'Generating content...',
  'Creating magic...',
  'Polishing the details...',
  'Bringing ideas to life...'
];

// Helper to collect all elements with highlights from canvas nodes
const collectHighlightedElements = (nodes: ParsedNode[]): Array<{ element: ParsedElement; nodeIndex: number; cellIndex?: number }> => {
  const elements: Array<{ element: ParsedElement; nodeIndex: number; cellIndex?: number }> = [];
  
  nodes.forEach((node, nodeIndex) => {
    if (node.type === 'grid') {
      const gridNode = node as ParsedGrid;
      gridNode.cells.forEach((cell, cellIndex) => {
        if (cell.content && cell.content.highlight) {
          elements.push({ element: cell.content, nodeIndex, cellIndex });
        }
      });
    } else {
      const el = node as ParsedElement;
      if (el.highlight) {
        elements.push({ element: el, nodeIndex });
      }
    }
  });
  
  return elements;
};

export default function App({ onNavigateToLearn }: { onNavigateToLearn?: () => void } = {}) {
  const [history, setHistory] = useState<{ role: 'user' | 'system'; content: string }[]>([]);
  const [canvasNodes, setCanvasNodes] = useState<ParsedNode[]>([]);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewVisible, setPreviewVisible] = useState(true);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [showConfetti, setShowConfetti] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [commandBarVisible, setCommandBarVisible] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState<{ status: string; detail?: string } | null>(null);
  const [loadingComplete, setLoadingComplete] = useState(false);
  const [thinkingHistory, setThinkingHistory] = useState<Array<{ status: string; detail: string; id: number }>>([]);
  const [writingPhraseIndex, setWritingPhraseIndex] = useState(0);
  const thinkingIdRef = useRef(0);
  
  // Model selection state
  const [selectedModel, setSelectedModel] = useState<ModelId>('claude-opus-4.5');
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [toolCallingMode, setToolCallingMode] = useState(false); // For OpenRouter Pilot System
  const [useOrchestrator, setUseOrchestrator] = useState(true); // Enable/disable Query Orchestrator
  
  // Developer mode state
  const [devMode, setDevMode] = useState(false);
  const [devDslInput, setDevDslInput] = useState('');
  const [devParsedNodes, setDevParsedNodes] = useState<ParsedNode[]>([]);
  
  // Debug panel state (for OpenRouter multi-agent system)
  const [debugPanelOpen, setDebugPanelOpen] = useState(false);
  const [debugLogs, setDebugLogs] = useState<Array<{
    timestamp: Date;
    agent: string;
    step: number;
    action: string;
    details: any;
  }>>([]);
  
  // Tool-calling agent state
  const [toolCallingEvents, setToolCallingEvents] = useState<ToolCallingEvent[]>([]);
  const [toolCallingHistory, setToolCallingHistory] = useState<{ role: string; content: string }[]>([]);
  
  // Agent prompts modal state
  const [showAgentPrompts, setShowAgentPrompts] = useState(false);
  const [agentPromptsData, setAgentPromptsData] = useState<any>(null);
  const [loadingAgentPrompts, setLoadingAgentPrompts] = useState(false);
  
  // Walkthrough mode state
  const [walkthroughActive, setWalkthroughActive] = useState(false);
  const [walkthroughIndex, setWalkthroughIndex] = useState(0);
  const [highlightedElements, setHighlightedElements] = useState<Array<{ element: ParsedElement; nodeIndex: number; cellIndex?: number }>>([]);
  
  // Dev mode: parse DSL input in real-time
  useEffect(() => {
    if (!devMode) return;
    try {
      const nodes = parseDSL(devDslInput);
      // Filter to only canvasable nodes
      const canvasable = nodes.filter(node => !isMarkdownNode(node));
      const prefix = `dev-${Date.now()}`;
      const clones = canvasable.map(node => cloneNode(node, prefix));
      setDevParsedNodes(clones);
    } catch (e) {
      // Keep showing last valid parse on error
      console.error('DSL parse error:', e);
    }
  }, [devDslInput, devMode]);
  
  // Start walkthrough
  const startWalkthrough = () => {
    const elements = collectHighlightedElements(canvasNodes);
    if (elements.length === 0) return;
    
    setHighlightedElements(elements);
    setWalkthroughIndex(0);
    setWalkthroughActive(true);
    setCommandBarVisible(false);
  };
  
  // Navigate walkthrough
  const nextWalkthrough = () => {
    if (walkthroughIndex < highlightedElements.length - 1) {
      setWalkthroughIndex(prev => prev + 1);
    } else {
      // End walkthrough
      setWalkthroughActive(false);
      setWalkthroughIndex(0);
      setHighlightedElements([]);
    }
  };
  
  const exitWalkthrough = () => {
    setWalkthroughActive(false);
    setWalkthroughIndex(0);
    setHighlightedElements([]);
  };
  
  // Rotate writing phrases
  useEffect(() => {
    if (!isLoading) return;
    const interval = setInterval(() => {
      setWritingPhraseIndex(prev => (prev + 1) % WRITING_PHRASES.length);
    }, 2500);
    return () => clearInterval(interval);
  }, [isLoading]);
  
  // Clear thinking history when loading starts
  useEffect(() => {
    if (isLoading) {
      setThinkingHistory([]);
      thinkingIdRef.current = 0;
    }
  }, [isLoading]);
  
  // Accumulate thinking snippets
  useEffect(() => {
    if (loadingStatus?.detail && (loadingStatus.status === 'thinking' || loadingStatus.status === 'tool')) {
      setThinkingHistory(prev => {
        // Avoid duplicates
        const lastItem = prev[prev.length - 1];
        if (lastItem?.detail === loadingStatus.detail) return prev;
        thinkingIdRef.current += 1;
        return [...prev, { status: loadingStatus.status, detail: loadingStatus.detail, id: thinkingIdRef.current }];
      });
    }
  }, [loadingStatus]);
  
  // Detect OS for keyboard shortcut display
  const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const shortcutKey = isMac ? '⌘' : 'Ctrl';

  // Global keyboard listener for Cmd/Ctrl + Enter
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        setCommandBarVisible(true);
        setLoadingComplete(false); // Reset the green indicator when opening
        // Focus the input after a brief delay to ensure it's rendered
        setTimeout(() => {
          inputRef.current?.focus();
        }, 50);
      }
      // Escape to close
      if (e.key === 'Escape' && commandBarVisible) {
        setCommandBarVisible(false);
      }
    };
    
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [commandBarVisible]);

  // Close command bar when clicking on canvas
  const handleCanvasClick = (e: React.MouseEvent) => {
    // Only close if clicking directly on the canvas background, not on components
    if (e.target === e.currentTarget) {
      setCommandBarVisible(false);
    }
  };

  const toggleSelection = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
  };

  // Helper to find a component by ID (could be inside a grid cell)
  const findComponentById = (id: string): { element: ParsedElement; gridIndex: number; cellIndex: number } | null => {
    for (let gridIndex = 0; gridIndex < canvasNodes.length; gridIndex++) {
      const node = canvasNodes[gridIndex];
      if (node.type === 'grid') {
        const gridNode = node as ParsedGrid;
        for (let cellIndex = 0; cellIndex < gridNode.cells.length; cellIndex++) {
          const cell = gridNode.cells[cellIndex];
          if (cell.content && cell.content.id === id) {
            return { element: cell.content, gridIndex, cellIndex };
          }
        }
      } else {
        const el = node as ParsedElement;
        if (el.id === id) {
          return { element: el, gridIndex, cellIndex: -1 };
        }
      }
    }
    return null;
  };

  // Get selected component labels for display
  const getSelectedLabels = (): string[] => {
    const labels: string[] = [];
    selectedIds.forEach(id => {
      const found = findComponentById(id);
      if (found) {
        const el = found.element;
        labels.push(el.props.title || el.props.label || el.type);
      }
    });
    return labels;
  };

  // Get selected components with their location info
  const getSelectedComponents = (): Array<{ id: string; element: ParsedElement; gridIndex: number; cellIndex: number }> => {
    const components: Array<{ id: string; element: ParsedElement; gridIndex: number; cellIndex: number }> = [];
    selectedIds.forEach(id => {
      const found = findComponentById(id);
      if (found) {
        components.push({ id, ...found });
      }
    });
    return components;
  };

  // Handle action button submissions (from interactive UI elements)
  const handleActionSubmit = async (detail: { prompt: string; rawPrompt: string; inputValues: Record<string, string>; allInputs: Record<string, string> }) => {
    if (isLoading) return;
    
    // Build context from all input values
    const inputContext = Object.entries(detail.allInputs)
      .map(([id, value]) => `- ${id}: ${value}`)
      .join('\n');
    
    const fullPrompt = `
The user has answered your questions using the interactive UI elements.

User's inputs:
${inputContext}

Action triggered: "${detail.prompt}"

Based on the user's responses, continue with the next step of the task. 
Remember to:
1. Use Display/Visual nuggts for showing results or dashboards
2. Use Input nuggts (input, date-picker, etc.) to ask the user questions
3. Use Action nuggts (button) with a descriptive prompt to let the user submit their answers
4. Use markdown text to explain what you're doing and guide the user

Continue the conversation and help the user accomplish their goal.
`;

    setIsLoading(true);
    setPreviewVisible(true);

    try {
      const aiResponseText = await generateUI(fullPrompt, history, undefined, selectedModel);
      const nodes = parseDSL(aiResponseText);
      const systemMsg = { role: 'system' as const, content: aiResponseText };
      setHistory(prev => [...prev, { role: 'user', content: detail.prompt }, systemMsg]);

      const { ui, markdown } = splitNodes(nodes);
      const { canvasable, interactive } = splitUINodes(ui);
      setPreview({ nodes, uiNodes: ui, markdownNodes: markdown, canvasableNodes: canvasable, interactiveNodes: interactive });
      setPreviewVisible(true);
      
      // Auto-add canvasable content to canvas
      if (canvasable.length > 0) {
        const prefix = `canvas-action-${Date.now()}`;
        const clones = canvasable.map(node => cloneNode(node, prefix));
        setCanvasNodes(prev => [...prev, ...clones]);
        // No toast - feedback box shows "Response ready" instead
      }
    } catch (error) {
      console.error('Failed to generate UI', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const handleToast = (detail: any) => {
      const newToast = {
        id: Math.random().toString(36),
        message: detail.message,
        type: detail.type || 'default'
      };
      setToasts(prev => [...prev, newToast]);
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== newToast.id));
      }, 3000);
    };

    const handleConfetti = () => setShowConfetti(true);
    
    const handleAction = (detail: any) => {
      handleActionSubmit(detail);
    };

    eventBus.on('toast', handleToast);
    eventBus.on('confetti', handleConfetti);
    eventBus.on('actionSubmit', handleAction);

    return () => {
      eventBus.off('toast', handleToast);
      eventBus.off('confetti', handleConfetti);
      eventBus.off('actionSubmit', handleAction);
    };
  }, [history, isLoading]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = async () => {
    if (!inputValue.trim() || isLoading) return;

    const hasCanvasContext = canvasNodes.length > 0;
    const hasSelection = selectedIds.size > 0;
    
    // Build the prompt with canvas context if needed
    let fullPrompt = inputValue.trim();
    
    // Get selected components with their locations
    const selectedComponents = getSelectedComponents();
    
    if (hasCanvasContext && hasSelection && selectedComponents.length > 0) {
      // Create numbered references for selected components
      const selectedComponentsDSL = selectedComponents
        .map((comp, i) => `[Component ${i + 1}] (${comp.element.type}):\n${serializeElement(comp.element)}`)
        .join('\n\n');
      
      fullPrompt = `
The user has selected ${selectedComponents.length} component(s) on their canvas for modification.

Selected components:
${selectedComponentsDSL}

User's request: "${inputValue.trim()}"

IMPORTANT INSTRUCTIONS:
1. Output ONLY the modified version(s) of the selected component(s)
2. Output them in the SAME ORDER as listed above (Component 1 first, then Component 2, etc.)
3. Do NOT output any other components - just the modified selected ones
4. Each modified component should be a complete valid Nuggt DSL line
5. After the Nuggt DSL, you can add a brief explanation in markdown

Example format if 2 components were selected:
card: (title: New Title, content: Updated content)
button: (label: New Label, variant: primary)

Your helpful explanation here...
`;
    } else if (hasCanvasContext) {
      // User wants to add to or modify the entire canvas
      const canvasDSL = serializeNodes(canvasNodes);
      
      fullPrompt = `
The user has a canvas with the following UI components (in Nuggt DSL):

\`\`\`
${canvasDSL}
\`\`\`

User's request: "${inputValue.trim()}"

If the user is asking to modify existing components, re-write the ENTIRE canvas with the changes. Do not lose any components.
If the user is asking for something new, just output the new components.
`;
    }
    
    const userMsg = { role: 'user' as const, content: inputValue.trim() };
    const historyWithUser = [...history, userMsg];

    setInputValue('');
    setIsLoading(true);
    setPreviewVisible(true);
    setLoadingStatus({ status: 'thinking', detail: 'Analyzing your request...' });
    setLoadingComplete(false);

    // Clear debug logs when starting new request
    setDebugLogs([]);
    setToolCallingEvents([]);
    
    try {
      let aiResponseText: string;
      
      // Check if using tool-calling mode (OpenRouter only)
      if (toolCallingMode && selectedModel === 'gpt-oss-20b') {
        // Use the new tool-calling agent with the same model as multi-agent system
        const result = await generateWithToolCallingAgent(
          inputValue.trim(),
          toolCallingHistory,
          selectedModel, // Pass model ID, server uses MODEL_MAP to get actual model
          (status, detail) => {
            setLoadingStatus({ status, detail });
          },
          (event: ToolCallingEvent) => {
            setToolCallingEvents(prev => [...prev, event]);
          },
          useOrchestrator
        );
        
        // Combine DSL and message
        const dslPart = result.dsl.join('\n');
        const messagePart = result.message;
        aiResponseText = dslPart + (messagePart ? '\n\n' + messagePart : '');
        
        // Update tool-calling history
        setToolCallingHistory(result.history);
      } else {
        // Use standard generateUI
        aiResponseText = await generateUI(
          fullPrompt, 
          historyWithUser, 
          (status, detail) => {
            setLoadingStatus({ status, detail });
          }, 
          selectedModel,
          // Debug callback for multi-agent system (OpenRouter models)
          (debugEvent: DebugEvent) => {
            setDebugLogs(prev => [...prev, debugEvent]);
          }
        );
      }
      
    const nodes = parseDSL(aiResponseText);
      const systemMsg = { role: 'system' as const, content: aiResponseText };
      setHistory([...historyWithUser, systemMsg]);

      const { ui, markdown } = splitNodes(nodes);
      const { canvasable, interactive } = splitUINodes(ui);
      setPreview({ nodes, uiNodes: ui, markdownNodes: markdown, canvasableNodes: canvasable, interactiveNodes: interactive });
      setPreviewVisible(true);
      
      // Handle canvas updates
      if (hasCanvasContext && hasSelection && selectedComponents.length > 0) {
        // EDIT MODE: Replace only the selected components in place
        // Extract canvasable elements from the response
        const newElements: ParsedElement[] = [];
        canvasable.forEach(uiNode => {
          if (uiNode.type === 'grid') {
            const gridNode = uiNode as ParsedGrid;
            gridNode.cells.forEach(cell => {
              if (cell.content && isCanvasableElement(cell.content)) {
                newElements.push(cell.content);
              }
            });
          } else {
            const el = uiNode as ParsedElement;
            if (isCanvasableElement(el)) {
              newElements.push(el);
            }
          }
        });
        
        if (newElements.length > 0) {
          setCanvasNodes(prev => {
            // Deep clone the canvas
            const newCanvas = prev.map(node => {
              if (node.type === 'grid') {
                const gridNode = node as ParsedGrid;
                return {
                  ...gridNode,
                  cells: gridNode.cells.map(cell => ({
                    ...cell,
                    content: cell.content ? { ...cell.content, props: { ...cell.content.props } } : undefined
                  }))
                };
              }
              return { ...node, props: { ...(node as ParsedElement).props } } as ParsedNode;
            });
            
            // Replace each selected component with the corresponding new element
            selectedComponents.forEach((comp, responseIndex) => {
              if (responseIndex < newElements.length) {
                const newElement = newElements[responseIndex];
                const targetNode = newCanvas[comp.gridIndex];
                
                if (targetNode.type === 'grid' && comp.cellIndex >= 0) {
                  // Replace the cell content within the grid
                  const gridNode = targetNode as ParsedGrid;
                  if (gridNode.cells[comp.cellIndex]) {
                    gridNode.cells[comp.cellIndex].content = {
                      ...newElement,
                      id: `updated-${Date.now()}-${responseIndex}`
                    };
                  }
                } else {
                  // Replace the entire node (non-grid element)
                  newCanvas[comp.gridIndex] = {
                    ...newElement,
                    id: `updated-${Date.now()}-${responseIndex}`
                  } as ParsedNode;
                }
              }
            });
            
            return newCanvas;
          });
          
          clearSelection();
          // No toast - feedback box shows status instead
        }
      } else if (canvasable.length > 0) {
        // ADD MODE: Auto-add new canvasable content to canvas
        const prefix = `canvas-${Date.now()}`;
        const clones = canvasable.map(node => cloneNode(node, prefix));
        setCanvasNodes(prev => [...prev, ...clones]);
        // No toast - feedback box shows "Response ready" instead
      }
    } catch (error) {
      console.error('Failed to generate UI', error);
    } finally {
    setIsLoading(false);
      setLoadingStatus(null);
      setLoadingComplete(true);
      // Don't auto-reset - only reset when user opens the command bar
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Note: We no longer auto-show the command bar - user controls when to view it
  // The feedback box at bottom-right will indicate when response is ready

  // Check if there's content to show in the answer box (interactive + markdown)
  const hasAnswerContent = preview && (preview.interactiveNodes.length > 0 || preview.markdownNodes.length > 0);

  const hasCanvasContent = canvasNodes.length > 0;
  const showHero = !hasCanvasContent && !commandBarVisible;

  // Dev mode render
  if (devMode) {
  return (
      <div className="flex h-screen bg-slate-900 text-slate-100 font-mono">
        {/* Dev mode toggle */}
        <button
          onClick={() => setDevMode(false)}
          className="fixed top-4 right-4 z-50 flex items-center gap-2 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition shadow-lg"
        >
          <Eye className="w-4 h-4" />
          Exit Dev Mode
        </button>
        
        {/* DSL Input Panel */}
        <div className="w-1/2 border-r border-slate-700 flex flex-col">
          <div className="px-4 py-3 border-b border-slate-700 bg-slate-800/50">
            <h2 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
              <Code2 className="w-4 h-4 text-indigo-400" />
              Nuggt DSL Input
            </h2>
            <p className="text-xs text-slate-500 mt-1">Enter your DSL syntax below. Changes render in real-time.</p>
          </div>
          <textarea
            value={devDslInput}
            onChange={(e) => setDevDslInput(e.target.value)}
            placeholder={`Enter Nuggt DSL here...

Example:
[2]: {
  card: (title: "Hello", content: "World", highlight: "A simple card"),
  alert: (title: "Notice", description: "This is an alert", variant: info, highlight: "An info alert")
}

[1]: {
  text: (content: "## Markdown Text\\n\\nThis supports **bold** and *italic*.", highlight: "A text block")
}`}
            className="flex-1 w-full p-4 bg-slate-900 text-slate-100 font-mono text-sm resize-none outline-none placeholder:text-slate-600 leading-relaxed"
            spellCheck={false}
          />
        </div>
        
        {/* Canvas Preview Panel */}
        <div className="w-1/2 bg-slate-50 text-slate-900 overflow-auto">
          <div className="px-4 py-3 border-b border-slate-200 bg-white sticky top-0 z-10">
            <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <Eye className="w-4 h-4 text-indigo-500" />
              Canvas Preview
            </h2>
            <p className="text-xs text-slate-400 mt-1">{devParsedNodes.length} component(s) rendered</p>
          </div>
          <div className="p-6">
            {devParsedNodes.length > 0 ? (
              <NuggtRenderer nodes={devParsedNodes} />
            ) : (
              <div className="flex flex-col items-center justify-center h-64 text-slate-400">
                <Code2 className="w-12 h-12 mb-4 text-slate-300" />
                <p className="text-sm">Enter DSL on the left to see preview</p>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Get agent color for debug panel
  const getAgentColor = (agent: string) => {
    const agentLower = agent?.toLowerCase() || '';
    if (agentLower === 'planner') return 'bg-purple-100 text-purple-800 border-purple-200';
    if (agentLower === 'tool') return 'bg-blue-100 text-blue-800 border-blue-200';
    if (agentLower === 'ui') return 'bg-emerald-100 text-emerald-800 border-emerald-200';
    if (agentLower === 'system') return 'bg-slate-100 text-slate-800 border-slate-200';
    return 'bg-gray-100 text-gray-800 border-gray-200';
  };
  
  const getActionIcon = (action: string) => {
    switch (action) {
      case 'START': return '🚀';
      case 'STEP': return '👣';
      case 'THINKING': return '🧠';
      case 'DECIDED': return '✅';
      case 'DELEGATING': return '📤';
      case 'CALLING': return '📞';
      case 'CALLING_SUBTOOL': return '🔧';
      case 'VARIABLE_CREATED': return '📦';
      case 'CREATING': return '🎨';
      case 'SUCCESS': return '✅';
      case 'COMPLETE': return '🎉';
      case 'FAILED': return '❌';
      case 'ERROR': return '⚠️';
      case 'WAITING': return '⏳';
      case 'INFORMED': return '💬';
      case 'MAX_STEPS': return '🛑';
      case 'PAUSED': return '⏸️';
      default: return '•';
    }
  };
  
  // Fetch agent prompts
  const fetchAgentPrompts = async () => {
    setLoadingAgentPrompts(true);
    try {
      const response = await fetch('/api/agent-prompts');
      const data = await response.json();
      setAgentPromptsData(data);
      setShowAgentPrompts(true);
    } catch (error) {
      console.error('Failed to fetch agent prompts:', error);
    } finally {
      setLoadingAgentPrompts(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-slate-50 text-slate-900 font-sans">
      {/* Dev mode and Debug panel toggle buttons - fixed position */}
      <div className="fixed top-4 right-4 z-50 flex items-center gap-2">
        {/* Agent Prompts Button */}
        <button
          onClick={fetchAgentPrompts}
          disabled={loadingAgentPrompts}
          className="flex items-center gap-2 px-3 py-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-lg text-sm font-medium transition shadow-lg disabled:opacity-50"
          title="View Agent Prompts - See what each agent sees"
        >
          {loadingAgentPrompts ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <FileText className="w-4 h-4" />
          )}
          Prompts
        </button>
        
        {/* Debug Panel Toggle */}
        <button
          onClick={() => setDebugPanelOpen(!debugPanelOpen)}
          className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition shadow-lg ${
            debugPanelOpen 
              ? 'bg-indigo-600 hover:bg-indigo-700 text-white' 
              : 'bg-white hover:bg-slate-50 text-slate-700 border border-slate-200'
          }`}
          title="Debug Panel - View multi-agent activity"
        >
          <Eye className="w-4 h-4" />
          Debug
          {debugLogs.length > 0 && (
            <span className={`px-1.5 py-0.5 rounded-full text-xs font-bold ${
              debugPanelOpen ? 'bg-white/20 text-white' : 'bg-indigo-100 text-indigo-700'
            }`}>
              {debugLogs.length}
            </span>
          )}
        </button>
        
        {/* Dev Mode Toggle */}
        <button
          onClick={() => setDevMode(true)}
          className="flex items-center gap-2 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition shadow-lg"
          title="Developer Mode - Enter DSL directly"
        >
          <Code2 className="w-4 h-4" />
          Dev Mode
        </button>
        
        {/* Learn MCPs Button */}
        {onNavigateToLearn && (
          <button
            onClick={onNavigateToLearn}
            className="flex items-center gap-2 px-3 py-2 bg-amber-500 hover:bg-amber-600 text-white rounded-lg text-sm font-medium transition shadow-lg"
            title="Learn MCPs - Teach AI to master your tools"
          >
            <GraduationCap className="w-4 h-4" />
            Learn MCPs
          </button>
        )}
      </div>
      
      {/* Debug Panel - Slide in from right */}
      {debugPanelOpen && (
        <div className="fixed top-16 right-4 z-40 w-96 max-h-[80vh] bg-white border border-slate-200 rounded-xl shadow-2xl flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 bg-slate-50">
            <div className="flex items-center gap-2">
              <Eye className="w-4 h-4 text-indigo-600" />
              <span className="font-semibold text-slate-800">
                {toolCallingMode ? '🚀 Pilot System' : 'Multi-Agent Debug'}
              </span>
        </div>
        <div className="flex items-center gap-2">
           <button 
                onClick={() => {
                  setDebugLogs([]);
                  setToolCallingEvents([]);
                }}
                className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1 rounded hover:bg-slate-100"
              >
                Clear Log
              </button>
              {toolCallingMode && (
                <button
                  onClick={() => {
                    setToolCallingEvents([]);
                    setToolCallingHistory([]);
                  }}
                  className="text-xs text-amber-600 hover:text-amber-800 px-2 py-1 rounded hover:bg-amber-50"
                >
                  New Chat
                </button>
              )}
              <button
                onClick={() => setDebugPanelOpen(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="w-4 h-4" />
          </button>
        </div>
          </div>
          
          {/* Content - Tool-Calling Mode */}
          {toolCallingMode ? (
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {toolCallingEvents.length === 0 ? (
                <div className="text-center py-8 text-slate-400">
                  <Eye className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No events yet</p>
                  <p className="text-xs mt-1">Send a message to see tool calls</p>
                </div>
              ) : (
                toolCallingEvents.map((event, index) => {
                  const getEventColor = () => {
                    switch (event.type) {
                      // Pilot events - purple/indigo theme
                      case 'pilot_system_started': return 'bg-indigo-100 border-indigo-300';
                      case 'pilot_turn': return 'bg-indigo-50 border-indigo-200';
                      case 'pilot_thinking': return 'bg-purple-50 border-purple-200';
                      case 'pilot_llm_request': return 'bg-purple-100 border-purple-300';
                      case 'pilot_response': return 'bg-purple-50 border-purple-200';
                      case 'pilot_instructing_executor': return 'bg-indigo-50 border-indigo-200';
                      case 'pilot_replying': return 'bg-green-100 border-green-300';
                      case 'pilot_error': return 'bg-red-50 border-red-200';
                      case 'pilot_system_complete': return 'bg-green-100 border-green-300';
                      
                      // Executor events - blue/cyan theme
                      case 'executor_started': return 'bg-blue-100 border-blue-300';
                      case 'executor_thinking': return 'bg-blue-50 border-blue-200';
                      case 'executor_response': return 'bg-cyan-50 border-cyan-200';
                      case 'executor_calling_tool': return 'bg-sky-50 border-sky-200';
                      case 'executor_tool_result': return 'bg-teal-50 border-teal-200';
                      case 'executor_done': return 'bg-blue-100 border-blue-300';
                      case 'executor_error': return 'bg-red-50 border-red-200';
                      
                      // Tool events
                      case 'tool_calling': return 'bg-cyan-50 border-cyan-200';
                      case 'tool_success': return 'bg-green-50 border-green-200';
                      case 'tool_error': return 'bg-red-50 border-red-200';
                      case 'ui_created': return 'bg-emerald-50 border-emerald-200';
                      case 'llm_calling': return 'bg-violet-50 border-violet-200';
                      case 'llm_response': return 'bg-violet-50 border-violet-200';
                      
                      // Analysis events - purple/violet theme
                      case 'analysis_started': return 'bg-violet-100 border-violet-300';
                      case 'analysis_thinking': return 'bg-violet-50 border-violet-200';
                      case 'analysis_step': return 'bg-fuchsia-50 border-fuchsia-200';
                      case 'analysis_operation_result': return 'bg-violet-50 border-violet-200';
                      case 'analysis_report_generated': return 'bg-purple-100 border-purple-300';
                      case 'analysis_phase': return 'bg-indigo-50 border-indigo-200';
                      case 'analysis_complete': return 'bg-emerald-100 border-emerald-300';
                      
                      default: return 'bg-slate-50 border-slate-200';
                    }
                  };
                  
                  const getEventIcon = () => {
                    switch (event.type) {
                      // Pilot
                      case 'pilot_system_started': return '🚀';
                      case 'pilot_turn': return '🎯';
                      case 'pilot_thinking': return '🧠';
                      case 'pilot_llm_request': return '📤';
                      case 'pilot_response': return '💭';
                      case 'pilot_instructing_executor': return '📋';
                      case 'pilot_replying': return '💬';
                      case 'pilot_error': return '❌';
                      case 'pilot_system_complete': return '🎉';
                      
                      // Executor
                      case 'executor_started': return '⚡';
                      case 'executor_thinking': return '⚙️';
                      case 'executor_response': return '🔧';
                      case 'executor_calling_tool': return '📡';
                      case 'executor_tool_result': return '✅';
                      case 'executor_done': return '✓';
                      case 'executor_error': return '❌';
                      
                      // Tool
                      case 'tool_calling': return '📡';
                      case 'tool_success': return '✅';
                      case 'tool_error': return '❌';
                      case 'ui_created': return '✨';
                      case 'llm_calling': return '🤖';
                      case 'llm_response': return '💬';
                      
                      // Analysis
                      case 'analysis_started': return '📊';
                      case 'analysis_thinking': return '🔬';
                      case 'analysis_step': return '📈';
                      case 'analysis_operation_result': return '✓';
                      case 'analysis_report_generated': return '📝';
                      case 'analysis_phase': return '⚡';
                      case 'analysis_complete': return '✅';
                      
                      default: return '📌';
                    }
                  };
                  
                  const getAgentLabel = () => {
                    if (event.type.startsWith('pilot_')) return 'PILOT';
                    if (event.type.startsWith('executor_')) return 'EXECUTOR';
                    return '';
                  };
                  
                  // Pilot response - show the full response
                  if (event.type === 'pilot_response') {
                    return (
                      <div key={index} className={`rounded-lg border-2 p-3 ${getEventColor()}`}>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="px-2 py-0.5 bg-purple-600 text-white text-[10px] font-bold rounded">PILOT</span>
                          <span className="text-lg">{getEventIcon()}</span>
                          <span className="font-semibold text-sm">Response</span>
                        </div>
                        <div className="rounded p-2 bg-white border border-purple-200">
                          <pre className="text-xs whitespace-pre-wrap break-all font-mono text-slate-700">
                            {(event as any).response}
                          </pre>
                        </div>
                      </div>
                    );
                  }
                  
                  // Executor response - show the tool call
                  if (event.type === 'executor_response') {
                    return (
                      <div key={index} className={`rounded-lg border p-3 ${getEventColor()}`}>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="px-2 py-0.5 bg-blue-600 text-white text-[10px] font-bold rounded">EXECUTOR</span>
                          <span className="text-lg">{getEventIcon()}</span>
                          <span className="font-semibold text-sm">Step {(event as any).iteration}</span>
                        </div>
                        <div className="rounded p-2 bg-white border border-blue-200 font-mono text-xs">
                          <pre className="whitespace-pre-wrap break-all text-slate-700">
                            {(event as any).response}
                          </pre>
                        </div>
                      </div>
                    );
                  }
                  
                  // Executor tool result
                  if (event.type === 'executor_tool_result') {
                    return (
                      <div key={index} className={`rounded-lg border p-2 ${getEventColor()}`}>
                        <div className="flex items-center gap-2">
                          <span className="px-1.5 py-0.5 bg-teal-600 text-white text-[9px] font-bold rounded">RESULT</span>
                          <span className="text-sm">{getEventIcon()}</span>
                          <span className="text-xs font-mono text-slate-600">{(event as any).tool}</span>
                        </div>
                        <div className="mt-1 text-xs font-mono text-teal-700 pl-4">
                          {(event as any).result}
                        </div>
                      </div>
                    );
                  }
                  
                  // Pilot instructing executor
                  if (event.type === 'pilot_instructing_executor') {
                    return (
                      <div key={index} className={`rounded-lg border-2 border-dashed p-3 ${getEventColor()}`}>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="px-2 py-0.5 bg-indigo-600 text-white text-[10px] font-bold rounded">PILOT → EXECUTOR</span>
                          <span className="text-lg">{getEventIcon()}</span>
                        </div>
                        <div className="text-xs text-indigo-800 italic">
                          "{(event as any).instructions}"
                        </div>
                      </div>
                    );
                  }
                  
                  // Executor started
                  if (event.type === 'executor_started') {
                    return (
                      <div key={index} className={`rounded-lg border-2 p-3 ${getEventColor()}`}>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="px-2 py-0.5 bg-blue-600 text-white text-[10px] font-bold rounded">EXECUTOR</span>
                          <span className="text-lg">{getEventIcon()}</span>
                          <span className="font-semibold text-sm">Starting Task</span>
                        </div>
                        <div className="text-xs text-blue-700">
                          <div className="mb-1"><strong>Tools:</strong> {((event as any).tools || []).join(', ')}</div>
                          <div className="italic text-blue-600">"{(event as any).task}"</div>
                        </div>
                      </div>
                    );
                  }
                  
                  // Executor done
                  if (event.type === 'executor_done') {
                    return (
                      <div key={index} className={`rounded-lg border-2 p-3 ${getEventColor()}`}>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="px-2 py-0.5 bg-blue-600 text-white text-[10px] font-bold rounded">EXECUTOR</span>
                          <span className="text-lg">{getEventIcon()}</span>
                          <span className="font-semibold text-sm">Task Complete</span>
                        </div>
                        <div className="text-xs text-blue-700">
                          <div className="p-2 bg-white rounded border border-blue-200">
                            {(event as any).report}
                          </div>
                          {(event as any).newVariables?.length > 0 && (
                            <div className="mt-1 text-blue-600">
                              New variables: {(event as any).newVariables.join(', ')}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  }
                  
                  // Analysis started
                  if (event.type === 'analysis_started') {
                    return (
                      <div key={index} className={`rounded-lg border-2 p-3 ${getEventColor()}`}>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="px-2 py-0.5 bg-violet-600 text-white text-[10px] font-bold rounded">ANALYSIS</span>
                          <span className="text-lg">{getEventIcon()}</span>
                          <span className="font-semibold text-sm">Data Analysis Started</span>
                        </div>
                        <div className="text-xs text-violet-700">
                          <div><strong>Question:</strong> {(event as any).question}</div>
                          <div className="mt-1"><strong>Variables:</strong> {((event as any).variables || []).join(', ')}</div>
                        </div>
                      </div>
                    );
                  }
                  
                  // Analysis step
                  if (event.type === 'analysis_step') {
                    const thought = (event as any).thought;
                    const execute = (event as any).execute;
                    return (
                      <div key={index} className={`rounded-lg border p-2 ${getEventColor()}`}>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="px-1.5 py-0.5 bg-fuchsia-600 text-white text-[9px] font-bold rounded">STEP {(event as any).iteration}</span>
                          <span className="text-sm">{getEventIcon()}</span>
                        </div>
                        <div className="text-xs text-fuchsia-700">
                          {thought ? (
                            <div className="italic mb-1">{thought.slice(0, 150)}{thought.length > 150 ? '...' : ''}</div>
                          ) : (
                            <div className="italic mb-1 text-fuchsia-400">(processing...)</div>
                          )}
                          {execute && (
                            <div className="font-mono bg-white p-1 rounded text-[10px]">{execute}</div>
                          )}
                        </div>
                      </div>
                    );
                  }
                  
                  // Analysis phase
                  if (event.type === 'analysis_phase') {
                    return (
                      <div key={index} className={`rounded-lg border p-2 ${getEventColor()}`}>
                        <div className="flex items-center gap-2">
                          <span className="px-1.5 py-0.5 bg-indigo-600 text-white text-[9px] font-bold rounded">PHASE</span>
                          <span className="text-sm">{getEventIcon()}</span>
                          <span className="text-xs text-indigo-700 capitalize">{(event as any).phase}</span>
                          {(event as any).visualCount && <span className="text-xs text-indigo-500">({(event as any).visualCount} visuals)</span>}
                        </div>
                      </div>
                    );
                  }
                  
                  // Analysis complete
                  if (event.type === 'analysis_complete') {
                    return (
                      <div key={index} className={`rounded-lg border-2 p-3 ${getEventColor()}`}>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="px-2 py-0.5 bg-emerald-600 text-white text-[10px] font-bold rounded">ANALYSIS</span>
                          <span className="text-lg">{getEventIcon()}</span>
                          <span className="font-semibold text-sm">Analysis Complete</span>
                        </div>
                        <div className="text-xs text-emerald-700 p-2 bg-white rounded border border-emerald-200">
                          {(event as any).summary}
                        </div>
                      </div>
                    );
                  }
                  
                  // Pilot replying (final response)
                  if (event.type === 'pilot_replying') {
                    return (
                      <div key={index} className={`rounded-lg border-2 p-3 ${getEventColor()}`}>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="px-2 py-0.5 bg-green-600 text-white text-[10px] font-bold rounded">FINAL REPLY</span>
                          <span className="text-lg">{getEventIcon()}</span>
                        </div>
                        <div className="text-xs text-green-800 p-2 bg-white rounded border border-green-200">
                          {(event as any).message?.slice(0, 300)}...
                        </div>
                      </div>
                    );
                  }
                  
                  // System complete
                  if (event.type === 'pilot_system_complete') {
                    return (
                      <div key={index} className={`rounded-lg border-2 p-3 ${getEventColor()}`}>
                        <div className="flex items-center gap-2">
                          <span className="text-lg">{getEventIcon()}</span>
                          <span className="font-semibold text-sm text-green-700">Pilot System Complete</span>
                        </div>
                        <div className="mt-1 text-xs text-green-600">
                          Variables: {(event as any).variableCount} | DSL Components: {(event as any).dslCount}
                        </div>
                      </div>
                    );
                  }
                  
                  // Default rendering for other events
                  const agentLabel = getAgentLabel();
                  return (
                    <div key={index} className={`rounded-lg border p-3 ${getEventColor()}`}>
                      <div className="flex items-center gap-2 mb-2">
                        {agentLabel && (
                          <span className={`px-2 py-0.5 text-white text-[10px] font-bold rounded ${
                            agentLabel === 'PILOT' ? 'bg-purple-600' : 'bg-blue-600'
                          }`}>{agentLabel}</span>
                        )}
                        <span className="text-lg">{getEventIcon()}</span>
                        <span className="font-semibold text-sm">{event.type.replace(/_/g, ' ').replace('pilot ', '').replace('executor ', '')}</span>
                      </div>
                      <div className="text-xs font-mono space-y-1">
                        {Object.entries(event).filter(([k]) => k !== 'type').map(([key, value]) => (
                          <div key={key} className="flex gap-2">
                            <span className="text-slate-500 flex-shrink-0">{key}:</span>
                            <span className="text-slate-700 break-all">
                              {typeof value === 'object' 
                                ? JSON.stringify(value, null, 2).slice(0, 200) 
                                : String(value).slice(0, 200)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          ) : (
            /* Content - Multi-Agent Mode */
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {debugLogs.length === 0 ? (
                <div className="text-center py-8 text-slate-400">
                  <Eye className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No debug events yet</p>
                  <p className="text-xs mt-1">Use an OpenRouter model to see multi-agent activity</p>
                </div>
              ) : (
                debugLogs.map((log, index) => (
                  <div 
                    key={index} 
                    className={`rounded-lg border p-3 ${getAgentColor(log.agent)}`}
                  >
                    {/* Header row */}
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-lg">{getActionIcon(log.action)}</span>
                        <span className="font-semibold text-sm">{log.agent}</span>
                        <span className="text-xs opacity-70">Step {log.step}</span>
                </div>
                      <span className="text-[10px] opacity-60">
                        {log.timestamp.toLocaleTimeString()}
                      </span>
                    </div>
                    
                    {/* Action */}
                    <div className="text-xs font-medium mb-1">{log.action}</div>
                    
                    {/* Details */}
                    {log.details && Object.keys(log.details).length > 0 && (
                      <div className="mt-2 p-2 bg-white/50 rounded text-xs space-y-1 font-mono">
                        {Object.entries(log.details).map(([key, value]) => {
                          // Only truncate raw tool responses
                          const isRawResponse = key.toLowerCase().includes('raw') || key.toLowerCase().includes('response') || key.toLowerCase().includes('result');
                          const stringValue = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
                          const shouldTruncate = isRawResponse && stringValue.length > 500;
                          
                          return (
                            <div key={key} className="flex gap-2">
                              <span className="text-slate-500 flex-shrink-0">{key}:</span>
                              <span className="text-slate-700 break-all whitespace-pre-wrap">
                                {shouldTruncate ? stringValue.slice(0, 500) + '...' : stringValue}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
          
          {/* Footer with legend */}
          <div className="px-4 py-2 border-t border-slate-100 bg-slate-50">
            <div className="flex flex-wrap gap-2 text-[10px]">
              <span className="px-1.5 py-0.5 rounded bg-slate-200 text-slate-700">SYSTEM</span>
              <span className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">PLANNER</span>
              <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">TOOL</span>
              <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">UI</span>
            </div>
          </div>
        </div>
      )}
      
      {/* Agent Prompts Modal */}
      {showAgentPrompts && agentPromptsData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50">
              <div className="flex items-center gap-3">
                <FileText className="w-5 h-5 text-indigo-600" />
                <div>
                  <h2 className="font-semibold text-slate-800 text-lg">Agent Prompts</h2>
                  <p className="text-xs text-slate-500">
                    {agentPromptsData.usingSubTools 
                      ? `Using ${agentPromptsData.subToolCount} learned sub-tools and ${agentPromptsData.workflowCount} workflows`
                      : 'Using original MCP tool schemas'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowAgentPrompts(false)}
                className="p-2 hover:bg-slate-200 rounded-lg transition"
              >
                <X className="w-5 h-5 text-slate-500" />
              </button>
            </div>
            
            {/* Modal Body */}
            <div className="flex-1 overflow-auto p-6 space-y-6">
              {/* Mode indicator */}
              <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium ${
                agentPromptsData.usingSubTools 
                  ? 'bg-green-100 text-green-700' 
                  : 'bg-amber-100 text-amber-700'
              }`}>
                {agentPromptsData.usingSubTools ? '✅ Learned Sub-Tools Active' : '⚙️ Original MCP Tools'}
              </div>
              
              {/* Planner Prompt */}
              <div className="border border-purple-200 rounded-xl overflow-hidden">
                <div className="bg-purple-50 px-4 py-3 border-b border-purple-200">
                  <h3 className="font-semibold text-purple-800">🧠 {agentPromptsData.prompts.planner.name}</h3>
                  <p className="text-xs text-purple-600">{agentPromptsData.prompts.planner.description}</p>
                </div>
                <pre className="p-4 text-xs text-slate-700 bg-white overflow-auto max-h-64 whitespace-pre-wrap font-mono">
                  {agentPromptsData.prompts.planner.prompt}
                </pre>
              </div>
              
              {/* Tool Agent Prompt */}
              <div className="border border-blue-200 rounded-xl overflow-hidden">
                <div className="bg-blue-50 px-4 py-3 border-b border-blue-200">
                  <h3 className="font-semibold text-blue-800">🔧 {agentPromptsData.prompts.toolAgent.name}</h3>
                  <p className="text-xs text-blue-600">{agentPromptsData.prompts.toolAgent.description}</p>
                </div>
                <div className="p-4 space-y-4">
                  <div>
                    <h4 className="text-xs font-semibold text-slate-500 mb-2 uppercase tracking-wide">Args Inference Prompt</h4>
                    <pre className="text-xs text-slate-700 bg-slate-50 rounded-lg p-3 overflow-auto max-h-48 whitespace-pre-wrap font-mono">
                      {agentPromptsData.prompts.toolAgent.argsPrompt}
                    </pre>
                  </div>
                  <div>
                    <h4 className="text-xs font-semibold text-slate-500 mb-2 uppercase tracking-wide">Full Tool Documentation</h4>
                    <pre className="text-xs text-slate-700 bg-slate-50 rounded-lg p-3 overflow-auto max-h-48 whitespace-pre-wrap font-mono">
                      {agentPromptsData.prompts.toolAgent.fullToolDocs}
                    </pre>
                  </div>
                </div>
              </div>
              
              {/* Current Variables */}
              {agentPromptsData.currentVariables && agentPromptsData.currentVariables.length > 0 && (
                <div className="border border-amber-200 rounded-xl overflow-hidden">
                  <div className="bg-amber-50 px-4 py-3 border-b border-amber-200">
                    <h3 className="font-semibold text-amber-800">📦 Stored Variables</h3>
                    <p className="text-xs text-amber-600">Variables created by Tool Agent (Planner sees names, UI Agent sees values)</p>
                  </div>
                  <div className="p-4 space-y-2">
                    {agentPromptsData.currentVariables.map((v: any, i: number) => (
                      <div key={i} className="flex items-center justify-between p-2 bg-amber-50 rounded-lg">
                        <div>
                          <span className="font-mono text-sm text-amber-800">{v.name}</span>
                          <p className="text-xs text-slate-600">{v.description}</p>
                        </div>
                        <span className="text-xs text-slate-500 bg-white px-2 py-1 rounded">{v.dataType}</span>
                      </div>
                    ))}
              </div>
            </div>
          )}

              {/* UI Agent Prompts (Component-Specific) */}
              <div className="border border-emerald-200 rounded-xl overflow-hidden">
                <div className="bg-emerald-50 px-4 py-3 border-b border-emerald-200">
                  <h3 className="font-semibold text-emerald-800">🎨 {agentPromptsData.prompts.ui.name}</h3>
                  <p className="text-xs text-emerald-600">{agentPromptsData.prompts.ui.description}</p>
                </div>
                <div className="p-4 bg-white max-h-64 overflow-auto">
                  {agentPromptsData.prompts.ui.componentPrompts ? (
                    <div className="space-y-3">
                      {Object.entries(agentPromptsData.prompts.ui.componentPrompts).map(([name, prompt]: [string, any]) => (
                        <details key={name} className="group">
                          <summary className="cursor-pointer px-3 py-2 bg-emerald-50 rounded-lg text-sm font-medium text-emerald-800 hover:bg-emerald-100 transition">
                            📦 {name.toUpperCase()}
                          </summary>
                          <pre className="mt-2 p-3 text-xs text-slate-700 bg-slate-50 rounded-lg overflow-auto max-h-40 whitespace-pre-wrap font-mono">
                            {prompt}
                          </pre>
                        </details>
                      ))}
                    </div>
                  ) : (
                    <pre className="text-xs text-slate-700 whitespace-pre-wrap font-mono">
                      {agentPromptsData.prompts.ui.prompt || '(No prompts available)'}
                    </pre>
                  )}
                </div>
              </div>
              
              {/* Pilot System (Toggle Mode) */}
              {agentPromptsData.prompts.pilotSystem && (
                <div className="border-2 border-indigo-300 rounded-xl overflow-hidden">
                  <div className="bg-gradient-to-r from-indigo-100 to-purple-100 px-4 py-3 border-b border-indigo-200">
                    <h3 className="font-semibold text-indigo-800">🚀 {agentPromptsData.prompts.pilotSystem.name}</h3>
                    <p className="text-xs text-indigo-600">{agentPromptsData.prompts.pilotSystem.description}</p>
                  </div>
                  <div className="p-4 bg-white space-y-4">
                    {/* Tool Summaries for Pilot */}
                    <details className="group" open>
                      <summary className="cursor-pointer px-3 py-2 bg-purple-100 rounded-lg text-sm font-medium text-purple-800 hover:bg-purple-200 transition">
                        📋 Tool Summaries (what Pilot sees)
                      </summary>
                      <pre className="mt-2 p-3 text-xs text-slate-700 bg-slate-50 rounded-lg overflow-auto max-h-48 whitespace-pre-wrap font-mono">
                        {agentPromptsData.prompts.pilotSystem.toolSummaries}
                      </pre>
                    </details>
                    
                    {/* Pilot Prompt */}
                    <details className="group">
                      <summary className="cursor-pointer px-3 py-2 bg-purple-100 rounded-lg text-sm font-medium text-purple-800 hover:bg-purple-200 transition">
                        🧠 Pilot Agent Prompt
                      </summary>
                      <pre className="mt-2 p-3 text-xs text-slate-700 bg-slate-50 rounded-lg overflow-auto max-h-64 whitespace-pre-wrap font-mono">
                        {agentPromptsData.prompts.pilotSystem.pilotPrompt}
                      </pre>
                    </details>
                    
                    {/* Executor Prompt */}
                    <details className="group">
                      <summary className="cursor-pointer px-3 py-2 bg-blue-100 rounded-lg text-sm font-medium text-blue-800 hover:bg-blue-200 transition">
                        ⚡ Executor Agent Prompt
                      </summary>
                      <pre className="mt-2 p-3 text-xs text-slate-700 bg-slate-50 rounded-lg overflow-auto max-h-64 whitespace-pre-wrap font-mono">
                        {agentPromptsData.prompts.pilotSystem.executorPrompt}
                      </pre>
                    </details>
                  </div>
                    </div>
                  )}
            </div>
            
            {/* Modal Footer */}
            <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex justify-end">
              <button
                onClick={() => setShowAgentPrompts(false)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      
      <ToastContainer toasts={toasts} removeToast={(id) => setToasts(prev => prev.filter(t => t.id !== id))} />
      <Confetti active={showConfetti} onComplete={() => setShowConfetti(false)} />

      {/* Hero screen - shown when canvas is empty and command bar is hidden */}
      {showHero && (
        <div 
          className="flex-1 flex flex-col items-center justify-center text-center space-y-8 px-6 cursor-pointer"
          onClick={() => setCommandBarVisible(true)}
        >
          <div className="w-20 h-20 rounded-[30px] bg-indigo-100 text-indigo-600 flex items-center justify-center shadow-inner">
            <Sparkles className="w-8 h-8" />
          </div>
          <div className="space-y-4">
            <h1 className="text-4xl font-semibold text-slate-900 tracking-tight">
              Describe your UI, and we'll paint it together.
            </h1>
            <p className="text-slate-500 text-lg max-w-2xl mx-auto">
              Press <kbd className="px-2 py-1 bg-slate-100 rounded-md text-slate-700 font-mono text-sm border border-slate-200">{shortcutKey} + Enter</kbd> to summon the AI
            </p>
            
            {/* Tool-Calling Mode Toggle - always visible on hero */}
            {selectedModel === 'gpt-oss-20b' && (
              <div 
                className="flex flex-col items-center justify-center gap-3 mt-6"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-3">
                  <span className="text-sm text-slate-500">Mode:</span>
                  <button
                    onClick={() => setToolCallingMode(!toolCallingMode)}
                    className={`px-4 py-2 rounded-xl text-sm font-medium transition shadow-sm ${
                      toolCallingMode 
                        ? 'bg-emerald-500 text-white ring-2 ring-emerald-300 shadow-emerald-200' 
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {toolCallingMode ? '🚀 Pilot System ON' : '🚀 Enable Pilot System'}
                  </button>
                </div>
                {/* Orchestrator Toggle - only visible when Pilot System is ON */}
                {toolCallingMode && (
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-slate-500">Orchestrator:</span>
                    <button
                      onClick={() => setUseOrchestrator(!useOrchestrator)}
                      className={`px-4 py-2 rounded-xl text-sm font-medium transition shadow-sm ${
                        useOrchestrator 
                          ? 'bg-indigo-500 text-white ring-2 ring-indigo-300 shadow-indigo-200' 
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      {useOrchestrator ? '🎯 Orchestrator ON' : '🎯 Orchestrator OFF'}
                    </button>
                  </div>
                )}
              </div>
            )}
        </div>
        </div>
      )}

      {/* Canvas area - shown when there's content */}
      {hasCanvasContent && (
        <div 
          className="flex-1 overflow-auto pb-20"
          onClick={handleCanvasClick}
        >
          <div className="max-w-6xl mx-auto px-6 py-10">
            {selectedIds.size > 0 && (
              <div className="mb-4 flex items-center gap-2 text-sm text-slate-600">
                <span className="bg-indigo-100 text-indigo-700 px-2 py-1 rounded-full text-xs font-medium">
                  {selectedIds.size} selected
                </span>
                <span className="text-slate-400">|</span>
                <span>{getSelectedLabels().join(', ')}</span>
                <button 
                  onClick={clearSelection}
                  className="ml-2 text-xs text-slate-500 hover:text-slate-700 underline"
                >
                  Clear selection
                </button>
              </div>
            )}
            <SelectableNuggtRenderer 
              nodes={canvasNodes} 
              selectedIds={selectedIds}
              onToggleSelect={toggleSelection}
              selectable={true}
            />
          </div>
        </div>
      )}

      {/* Feedback box at bottom center - with loading/complete/walkthrough states */}
      {hasCanvasContent && !commandBarVisible && (
        <div className="fixed bottom-4 inset-x-0 flex justify-center pointer-events-none">
          {walkthroughActive ? (
            <div className="flex items-center gap-2.5 text-xs bg-rose-50 text-rose-700 backdrop-blur-sm px-4 py-2.5 rounded-xl border border-rose-200/80 shadow-sm max-w-sm">
              <Play className="w-3.5 h-3.5 flex-shrink-0 text-rose-600" />
              <span className="font-medium">Explaining changes ({walkthroughIndex + 1}/{highlightedElements.length})</span>
            </div>
          ) : isLoading ? (
            <div className="flex items-center gap-2.5 text-xs bg-yellow-50 text-yellow-800 backdrop-blur-sm px-4 py-2.5 rounded-xl border border-yellow-200/80 shadow-sm max-w-sm">
              <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0 text-yellow-600" />
              <span className="font-medium truncate">
                {loadingStatus?.status === 'tool' 
                  ? loadingStatus.detail || 'Using tool...'
                  : loadingStatus?.status === 'thinking' 
                  ? (loadingStatus.detail && loadingStatus.detail.length > 50 
                      ? loadingStatus.detail.slice(0, 50) + '...' 
                      : loadingStatus.detail || 'Thinking...')
                  : loadingStatus?.status === 'generating' 
                  ? WRITING_PHRASES[writingPhraseIndex]
                  : 'Processing...'}
              </span>
            </div>
          ) : loadingComplete ? (
            <div 
              className="flex items-center gap-2.5 text-xs bg-green-50 text-green-700 backdrop-blur-sm px-4 py-2.5 rounded-xl border border-green-200/80 shadow-lg shadow-green-300/40 cursor-pointer pointer-events-auto transition-all hover:shadow-green-400/50 hover:bg-green-100/80"
              onClick={() => {
                setCommandBarVisible(true);
                setLoadingComplete(false);
              }}
            >
              <Sparkles className="w-3.5 h-3.5 text-green-600" />
              <span className="font-medium">Response ready</span>
              <span className="text-green-500 text-[10px]">• Click to view</span>
                      </div>
                    ) : (
            <div className="text-xs text-slate-400 bg-white/90 backdrop-blur-sm px-4 py-2.5 rounded-xl border border-slate-200/60 shadow-sm">
              Press <kbd className="px-1.5 py-0.5 bg-slate-100 rounded text-slate-600 font-mono text-[10px] border border-slate-200">{shortcutKey} + Enter</kbd> to summon AI
            </div>
          )}
        </div>
      )}

      {/* Command bar overlay - centered on screen */}
      {commandBarVisible && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setCommandBarVisible(false);
            }
          }}
        >
          {/* Semi-transparent backdrop */}
          <div className="absolute inset-0 bg-slate-900/10 backdrop-blur-sm" />
          
          {/* Command bar container */}
          <div className="relative flex flex-col items-center" style={{ width: '48rem', maxWidth: 'calc(100% - 2rem)' }}>
            {/* Answer container with input embedded inside */}
            {(hasAnswerContent || isLoading) && previewVisible ? (
              <div className="w-full bg-white/95 backdrop-blur-2xl border border-slate-200/60 shadow-2xl rounded-[18px] flex flex-col" style={{ maxHeight: '75vh' }}>
                {/* Scrollable content area */}
                <div className="flex-1 overflow-y-auto p-6 space-y-4">
                  {isLoading ? (
                    <div className="space-y-4">
                      {/* Clean status bar */}
                      <div className="flex items-center gap-3 pb-3 border-b border-slate-100">
                        <div className="flex items-center gap-2">
                          <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
                          <span className="text-sm text-slate-500">
                            {loadingStatus?.status === 'tool' ? 'Using tool' : 
                             loadingStatus?.status === 'thinking' ? 'Thinking' :
                             loadingStatus?.status === 'generating' ? WRITING_PHRASES[writingPhraseIndex] :
                             'Processing'}
                          </span>
                        </div>
                      </div>
                      
                      {/* Thinking history - show all snippets */}
                      {thinkingHistory.length > 0 && (
                      <div className="space-y-2">
                          {thinkingHistory.map((item) => (
                            <div 
                              key={item.id}
                              className={`text-sm px-3 py-2 rounded-lg border-l-2 ${
                                item.status === 'thinking' 
                                  ? 'bg-indigo-50/50 border-indigo-300 text-indigo-700' 
                                  : item.status === 'tool'
                                  ? 'bg-amber-50/50 border-amber-300 text-amber-700'
                                  : 'bg-slate-50 border-slate-300 text-slate-600'
                              }`}
                            >
                              {item.detail}
                            </div>
                          ))}
                      </div>
                    )}
                      
                      {/* Streaming response content */}
                      {loadingStatus?.status === 'generating' && loadingStatus?.detail && (
                        <div className="prose prose-base prose-slate max-w-none">
                          <ReactMarkdown>{loadingStatus.detail}</ReactMarkdown>
                        </div>
                      )}
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between">
                        <div className="text-sm uppercase tracking-[0.15em] text-slate-400 font-medium">
                          {preview?.canvasableNodes.length ? 'Added to canvas' : 'Assistant'}
                        </div>
                        <div className="flex items-center gap-2">
                          {/* Play button for walkthrough - only show if there are highlighted elements */}
                          {collectHighlightedElements(canvasNodes).length > 0 && (
                            <Button 
                              variant="outline" 
                              className="text-sm gap-1.5"
                              onClick={startWalkthrough}
                            >
                              <Play className="w-3.5 h-3.5" />
                              Explain
                            </Button>
                          )}
                          <Button variant="outline" className="text-sm" onClick={() => setPreviewVisible(false)}>
                            Hide
                          </Button>
                        </div>
                  </div>

                      <div className="space-y-4">
                        {/* Pilot System Conversation - show full flow */}
                        {toolCallingMode && toolCallingEvents.length > 0 && (
                          <div className="bg-slate-900 rounded-xl p-4 font-mono text-sm overflow-x-auto max-h-[400px] overflow-y-auto">
                            <div className="text-xs text-slate-500 mb-3 uppercase tracking-wider">Pilot System</div>
                            <div className="space-y-3">
                              {toolCallingEvents.map((event, idx) => {
                                // Pilot System started
                                if (event.type === 'pilot_system_started') {
                                  return (
                                    <div key={idx} className="text-indigo-400">
                                      <span className="text-indigo-500">🚀</span> Pilot System Started
                    </div>
                                  );
                                }
                                // Pilot turn
                                if (event.type === 'pilot_turn') {
                                  return (
                                    <div key={idx} className="text-purple-400 mt-4 border-t border-slate-700 pt-3">
                                      <span className="px-2 py-0.5 bg-purple-600 text-white text-[10px] rounded">PILOT</span>
                                      <span className="ml-2">Turn {event.turn}</span>
                                    </div>
                                  );
                                }
                                // Pilot thinking
                                if (event.type === 'pilot_thinking') {
                                  return (
                                    <div key={idx} className="text-purple-400">
                                      <span className="text-purple-500">🧠</span> Pilot thinking...
                                    </div>
                                  );
                                }
                                // Pilot response
                                if (event.type === 'pilot_response') {
                                  return (
                                    <div key={idx} className="border-l-2 border-purple-500 pl-3">
                                      <div className="text-purple-400 text-xs mb-1">Pilot Decision:</div>
                                      <pre className="text-purple-300 whitespace-pre-wrap">{event.response}</pre>
                                    </div>
                                  );
                                }
                                // Pilot instructing executor
                                if (event.type === 'pilot_instructing_executor') {
                                  return (
                                    <div key={idx} className="border-l-2 border-indigo-500 pl-3 bg-indigo-950/30 p-2 rounded-r">
                                      <div className="text-indigo-400 text-xs mb-1">📋 Pilot → Executor:</div>
                                      <pre className="text-indigo-300 whitespace-pre-wrap text-xs italic">"{event.instructions}"</pre>
                                    </div>
                                  );
                                }
                                // Executor started
                                if (event.type === 'executor_started') {
                                  return (
                                    <div key={idx} className="text-blue-400 mt-3">
                                      <span className="px-2 py-0.5 bg-blue-600 text-white text-[10px] rounded">EXECUTOR</span>
                                      <span className="ml-2">⚡ Starting task with tools: {(event.tools || []).join(', ')}</span>
                                    </div>
                                  );
                                }
                                // Executor thinking
                                if (event.type === 'executor_thinking') {
                                  return (
                                    <div key={idx} className="text-blue-400 text-xs pl-4">
                                      ⚙️ Step {event.iteration}...
                                    </div>
                                  );
                                }
                                // Executor response (tool call)
                                if (event.type === 'executor_response') {
                                  return (
                                    <div key={idx} className="border-l-2 border-cyan-500 pl-3">
                                      <div className="text-cyan-400 text-xs mb-1">Tool Call:</div>
                                      <pre className="text-cyan-300 whitespace-pre-wrap">{event.response}</pre>
                                    </div>
                                  );
                                }
                                // Executor calling tool
                                if (event.type === 'executor_calling_tool') {
                                  return (
                                    <div key={idx} className="text-sky-400 pl-4">
                                      <span className="text-sky-600">📡</span> {event.raw}
                                    </div>
                                  );
                                }
                                // Executor tool result
                                if (event.type === 'executor_tool_result') {
                                  return (
                                    <div key={idx} className="border-l-2 border-teal-500 pl-3 text-xs">
                                      <span className="text-teal-400">{event.result}</span>
                                    </div>
                                  );
                                }
                                // Executor done
                                if (event.type === 'executor_done') {
                                  return (
                                    <div key={idx} className="border-l-2 border-blue-500 pl-3 bg-blue-950/30 p-2 rounded-r">
                                      <div className="text-blue-400 text-xs mb-1">✓ Executor Report:</div>
                                      <pre className="text-blue-300 whitespace-pre-wrap text-xs">{event.report}</pre>
                                      {event.newVariables?.length > 0 && (
                                        <div className="text-blue-400 text-xs mt-1">New: {event.newVariables.join(', ')}</div>
                  )}
                </div>
                                  );
                                }
                                // Pilot replying to user
                                if (event.type === 'pilot_replying') {
                                  return (
                                    <div key={idx} className="border-l-2 border-green-500 pl-3 bg-green-950/30 p-2 rounded-r mt-3">
                                      <div className="text-green-400 text-xs mb-1">💬 Final Reply:</div>
                                      <pre className="text-green-300 whitespace-pre-wrap text-xs">{event.message?.slice(0, 300)}...</pre>
                                    </div>
                                  );
                                }
                                // System complete
                                if (event.type === 'pilot_system_complete') {
                                  return (
                                    <div key={idx} className="text-green-400 mt-3 border-t border-slate-700 pt-3">
                                      <span className="text-green-500">🎉</span> Complete | Variables: {event.variableCount} | Components: {event.dslCount}
                                    </div>
                                  );
                                }
                                // Tool calling parent
                                if (event.type === 'tool_calling') {
                                  return (
                                    <div key={idx} className="text-slate-500 text-xs pl-4">
                                      ↳ Parent tool: {event.parentTool}
                                    </div>
                                  );
                                }
                                // Tool success
                                if (event.type === 'tool_success') {
                                  return (
                                    <div key={idx} className="text-emerald-400 text-xs pl-4">
                                      ✓ Got: {(event.schemaKeys || []).join(', ')}
                                    </div>
                                  );
                                }
                                // Tool error
                                if (event.type === 'tool_error') {
                                  return (
                                    <div key={idx} className="text-red-400">
                                      ✗ Error: {event.error}
                                    </div>
                                  );
                                }
                                // LLM assistant call
                                if (event.type === 'llm_calling') {
                                  return (
                                    <div key={idx} className="text-violet-400 pl-4">
                                      <span className="text-violet-600">🤖</span> Asking: "{event.question}"
                                    </div>
                                  );
                                }
                                // LLM response
                                if (event.type === 'llm_response') {
                                  return (
                                    <div key={idx} className="border-l-2 border-violet-500 pl-3 text-xs">
                                      <span className="text-violet-300">{event.answer}</span>
                                    </div>
                                  );
                                }
                                // UI created
                                if (event.type === 'ui_created') {
                                  return (
                                    <div key={idx} className="text-emerald-400 pl-4">
                                      <span className="text-emerald-600">✨</span> {event.tool} displayed
                                    </div>
                                  );
                                }
                                // Old agent events for backward compatibility
                                if (event.type === 'agent_thinking') {
                                  return (
                                    <div key={idx} className="text-purple-400">
                                      <span className="text-purple-500">⟨thinking⟩</span> Iteration {event.iteration}...
                                    </div>
                                  );
                                }
                                if (event.type === 'agent_response') {
                                  return (
                                    <div key={idx} className="border-l-2 border-indigo-500 pl-3">
                                      <div className="text-indigo-400 text-xs mb-1">Agent Output:</div>
                                      <pre className="text-indigo-300 whitespace-pre-wrap">{event.response}</pre>
                                    </div>
                                  );
                                }
                                // Agent complete
                                if (event.type === 'agent_complete') {
                                  return (
                                    <div key={idx} className="border-t border-slate-700 pt-3 mt-3">
                                      <div className="text-green-400 text-xs mb-1">🎉 Agent Complete</div>
                                      <pre className="text-green-300 whitespace-pre-wrap">{event.message}</pre>
                                    </div>
                                  );
                                }
                                return null;
                              })}
                            </div>
                          </div>
                        )}
                        
                        {/* Markdown explanations - shown first as context */}
                        {preview?.markdownNodes.length ? (
                          <div>
                            <NuggtRenderer nodes={preview.markdownNodes} />
                    </div>
                        ) : null}
                        
                        {/* Interactive content (Input + Action) - for user questions */}
                        {preview?.interactiveNodes.length ? (
                          <div className="bg-slate-50/80 rounded-xl p-5 border border-slate-200/50">
                            <div className="text-sm uppercase tracking-[0.15em] text-slate-400 mb-4 font-medium">Your Input</div>
                            <NuggtRenderer nodes={preview.interactiveNodes} />
                    </div>
                        ) : null}
                 </div>
                    </>
                  )}
                </div>

                {/* Input area inside the container */}
                <div className="border-t border-slate-200/60 p-4">
                  {/* Model selector above input */}
                  <div className="mb-3 relative">
                    <button
                      onClick={() => setModelDropdownOpen(!modelDropdownOpen)}
                      className="flex items-center gap-2 text-sm text-slate-600 hover:text-slate-800 bg-white/90 hover:bg-white px-4 py-2 rounded-xl border border-slate-200 shadow-sm transition"
                    >
                      <span className="font-medium">{AI_MODELS.find(m => m.id === selectedModel)?.name}</span>
                      <ChevronDown className={`w-4 h-4 transition-transform ${modelDropdownOpen ? 'rotate-180' : ''}`} />
                    </button>
                    {modelDropdownOpen && (
                      <div className="absolute bottom-full left-0 mb-2 bg-white rounded-xl shadow-xl border border-slate-200 py-2 z-50 min-w-[200px]">
                        {AI_MODELS.map(model => (
                          <button
                            key={model.id}
                            onClick={() => {
                              setSelectedModel(model.id);
                              setModelDropdownOpen(false);
                            }}
                            className={`w-full text-left px-4 py-2.5 text-sm hover:bg-slate-50 transition flex items-center justify-between ${
                              selectedModel === model.id ? 'text-indigo-600 bg-indigo-50' : 'text-slate-700'
                            }`}
                          >
                            <span>{model.name}</span>
                            {selectedModel === model.id && <span className="text-indigo-500">✓</span>}
                          </button>
                        ))}
            </div>
          )}
        </div>

                  {/* Tool-Calling Mode Toggle (only for OpenRouter) */}
                  {selectedModel === 'gpt-oss-20b' && (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setToolCallingMode(!toolCallingMode)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                          toolCallingMode 
                            ? 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-300' 
                            : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                        }`}
                        title="Pilot System: Two-agent architecture (Pilot + Executor)"
                      >
                        {toolCallingMode ? '🚀 Pilot ON' : '🚀 Pilot'}
                      </button>
                      {/* Orchestrator Toggle */}
                      {toolCallingMode && (
                        <button
                          onClick={() => setUseOrchestrator(!useOrchestrator)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                            useOrchestrator 
                              ? 'bg-indigo-100 text-indigo-700 ring-1 ring-indigo-300' 
                              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                          }`}
                          title="Query Orchestrator: Analyzes request and creates task plan"
                        >
                          {useOrchestrator ? '🎯 Orch' : '🎯 Orch OFF'}
                        </button>
                      )}
                    </div>
                  )}
                  
                  <div className="relative rounded-[14px] overflow-hidden bg-slate-50 ring-1 ring-slate-200 focus-within:ring-indigo-200 transition-all">
                      
                      {selectedIds.size > 0 && (
                        <div className="flex items-center gap-2 text-xs text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-lg mx-4 mt-3">
                          <span className="font-medium">{selectedIds.size} selected</span>
                        </div>
                      )}
                    
              <textarea
                ref={inputRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                      placeholder={selectedIds.size > 0 ? `Describe changes for ${selectedIds.size} selected component(s)...` : "Describe what you want to build..."}
                      className="w-full max-h-48 min-h-[60px] py-3 pl-5 pr-14 resize-none outline-none text-slate-800 placeholder:text-slate-400 bg-transparent text-base leading-relaxed"
                disabled={isLoading}
              />
                    <div className="absolute right-3 bottom-3">
                      <Button
                  onClick={handleSend}
                  disabled={!inputValue.trim() || isLoading}
                        className="rounded-xl p-2.5 h-10 w-10 flex items-center justify-center"
                >
                  <Send className="w-4 h-4" />
                      </Button>
              </div>
            </div>
                    </div>
                 </div>
            ) : (
              /* Standalone input when no preview */
              <div className="flex flex-col items-center gap-4 w-full">
                {!previewVisible && hasAnswerContent && !isLoading && (
                  <button
                    className="text-sm text-indigo-600 bg-white/95 backdrop-blur px-5 py-2 rounded-full border border-indigo-100 shadow-sm font-medium hover:bg-white transition"
                    onClick={() => setPreviewVisible(true)}
                  >
                    Show latest response
                  </button>
                )}

                {/* Model selector above input */}
                <div className="mb-3 relative">
                  <button
                    onClick={() => setModelDropdownOpen(!modelDropdownOpen)}
                    className="flex items-center gap-2 text-sm text-slate-600 hover:text-slate-800 bg-white/90 hover:bg-white px-4 py-2 rounded-xl border border-slate-200 shadow-sm transition"
                  >
                    <span className="font-medium">{AI_MODELS.find(m => m.id === selectedModel)?.name}</span>
                    <ChevronDown className={`w-4 h-4 transition-transform ${modelDropdownOpen ? 'rotate-180' : ''}`} />
                </button>
                  {modelDropdownOpen && (
                    <div className="absolute bottom-full left-0 mb-2 bg-white rounded-xl shadow-xl border border-slate-200 py-2 z-50 min-w-[200px]">
                      {AI_MODELS.map(model => (
                        <button
                          key={model.id}
                          onClick={() => {
                            setSelectedModel(model.id);
                            setModelDropdownOpen(false);
                          }}
                          className={`w-full text-left px-4 py-2.5 text-sm hover:bg-slate-50 transition flex items-center justify-between ${
                            selectedModel === model.id ? 'text-indigo-600 bg-indigo-50' : 'text-slate-700'
                          }`}
                        >
                          <span>{model.name}</span>
                          {selectedModel === model.id && <span className="text-indigo-500">✓</span>}
                </button>
                      ))}
                    </div>
                  )}
                </div>
                
                {/* Tool-Calling Mode Toggle (standalone input) */}
                {selectedModel === 'gpt-oss-20b' && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setToolCallingMode(!toolCallingMode)}
                      className={`px-4 py-2 rounded-xl text-sm font-medium transition shadow-sm ${
                        toolCallingMode 
                          ? 'bg-emerald-500 text-white ring-2 ring-emerald-300' 
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      {toolCallingMode ? '🚀 Pilot ON' : '🚀 Pilot'}
                    </button>
                    {/* Orchestrator Toggle - only when Pilot is ON */}
                    {toolCallingMode && (
                      <button
                        onClick={() => setUseOrchestrator(!useOrchestrator)}
                        className={`px-4 py-2 rounded-xl text-sm font-medium transition shadow-sm ${
                          useOrchestrator 
                            ? 'bg-indigo-500 text-white ring-2 ring-indigo-300' 
                            : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                        }`}
                        title="Query Orchestrator: Analyzes request and creates task plan for Pilot"
                      >
                        {useOrchestrator ? '🎯 Orch ON' : '🎯 Orch OFF'}
                      </button>
                    )}
                  </div>
                )}
                
                <div className="w-full relative shadow-2xl rounded-[18px] overflow-hidden bg-white ring-1 ring-slate-200 focus-within:ring-indigo-200 transition-all">
                    
                    {/* Selected components indicator */}
                    {selectedIds.size > 0 && (
                      <div className="flex items-center gap-2 text-xs text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-lg mx-4 mt-3">
                        <span className="font-medium">{selectedIds.size} selected:</span>
                        <span className="text-indigo-500">{getSelectedLabels().slice(0, 2).join(', ')}{selectedIds.size > 2 ? '...' : ''}</span>
              </div>
            )}
                  
              <textarea
                ref={inputRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                    placeholder={selectedIds.size > 0 ? `Describe changes for selected component(s)...` : "Describe what you want to build..."}
                    className="w-full max-h-48 min-h-[70px] py-4 pl-5 pr-14 resize-none outline-none text-slate-800 placeholder:text-slate-400 bg-transparent text-base leading-relaxed"
                disabled={isLoading}
              />
                  <div className="absolute right-4 bottom-4">
                    <Button
                  onClick={handleSend}
                  disabled={!inputValue.trim() || isLoading}
                      className="rounded-xl p-2.5 h-10 w-10 flex items-center justify-center"
                >
                  <Send className="w-4 h-4" />
                    </Button>
          </div>
        </div>
            
                {/* Quick prompts - only show before conversation starts */}
                {history.length === 0 && (
                  <div className="flex flex-wrap gap-2 text-sm justify-center">
                    {['Design a revenue dashboard', 'Build a booking wizard', 'Plan a marketing cockpit'].map((prompt) => (
                      <button
                        key={prompt}
                        className="px-4 py-2 rounded-full bg-white/80 hover:bg-white border border-slate-200/50 transition text-slate-600 text-sm shadow-sm"
                        onClick={() => setInputValue(prompt)}
                      >
                        {prompt}
                      </button>
                    ))}
      </div>
                )}

                {/* Hint to close */}
                <p className="text-xs text-slate-400 mt-2">
                  Press <kbd className="px-1 py-0.5 bg-slate-100 rounded text-slate-500 font-mono text-xs border border-slate-200">Esc</kbd> or click outside to close
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Walkthrough overlay */}
      {walkthroughActive && highlightedElements.length > 0 && (
        <div className="fixed inset-0 z-50 pointer-events-none">
          {/* Semi-transparent backdrop */}
          <div className="absolute inset-0 bg-slate-900/20" />
          
          {/* Explanation card - positioned near the highlighted element */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-auto">
            <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 max-w-md w-full mx-4 overflow-hidden">
              {/* Header */}
              <div className="bg-gradient-to-r from-rose-50 to-pink-50 px-5 py-4 border-b border-rose-100">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center text-xs font-semibold">
                      {walkthroughIndex + 1}
                    </div>
                    <span className="text-sm font-medium text-rose-700">
                      {highlightedElements[walkthroughIndex]?.element.type.charAt(0).toUpperCase() + highlightedElements[walkthroughIndex]?.element.type.slice(1)}
                    </span>
                  </div>
                  <button 
                    onClick={exitWalkthrough}
                    className="text-slate-400 hover:text-slate-600 transition"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
              
              {/* Content */}
              <div className="p-5">
                <div className="prose prose-sm prose-slate max-w-none">
                  <ReactMarkdown>
                    {highlightedElements[walkthroughIndex]?.element.highlight || 'No explanation available.'}
                  </ReactMarkdown>
                </div>
              </div>
              
              {/* Footer */}
              <div className="px-5 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
                <span className="text-xs text-slate-400">
                  {walkthroughIndex + 1} of {highlightedElements.length}
                </span>
                <Button 
                  onClick={nextWalkthrough}
                  className="gap-1.5"
                >
                  {walkthroughIndex < highlightedElements.length - 1 ? (
                    <>
                      Next
                      <ChevronRight className="w-4 h-4" />
                    </>
                  ) : (
                    'Done'
                  )}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
