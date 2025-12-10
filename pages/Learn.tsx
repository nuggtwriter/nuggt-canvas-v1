import React, { useState, useEffect, useRef } from 'react';
import { 
  GraduationCap, 
  Play, 
  CheckCircle2, 
  Circle, 
  Loader2, 
  ArrowLeft,
  Globe,
  Wrench,
  GitBranch,
  FileJson,
  AlertCircle,
  RefreshCw,
  Eye,
  X,
  Copy,
  Check
} from 'lucide-react';

interface MCPInfo {
  name: string;
  toolCount: number;
  hasLearning: boolean;
  learnedAt?: string;
  subToolCount?: number;
  workflowCount?: number;
}

interface LearningLog {
  id: string;
  timestamp: Date;
  type: 'info' | 'tool_call' | 'tool_response' | 'learning' | 'subtool' | 'error' | 'web_browse';
  message: string;
  details?: any;
}

interface LearningProgress {
  phase: 'idle' | 'exploring' | 'analyzing' | 'creating_subtools' | 'complete' | 'error';
  currentTool: string;
  toolIndex: number;
  totalTools: number;
  subToolsCreated: number;
  inputsDocumented: number;
}

export default function Learn({ onBack }: { onBack: () => void }) {
  const [mcps, setMcps] = useState<MCPInfo[]>([]);
  const [selectedMcps, setSelectedMcps] = useState<Set<string>>(new Set());
  const [isLearning, setIsLearning] = useState(false);
  const [logs, setLogs] = useState<LearningLog[]>([]);
  const [progress, setProgress] = useState<LearningProgress>({
    phase: 'idle',
    currentTool: '',
    toolIndex: 0,
    totalTools: 0,
    subToolsCreated: 0,
    inputsDocumented: 0
  });
  const logsEndRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  
  // Preview modal state
  const [previewMcp, setPreviewMcp] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string>('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // Fetch available MCPs on mount
  useEffect(() => {
    fetchMCPs();
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Cleanup EventSource on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  const fetchMCPs = async () => {
    try {
      const response = await fetch('/api/mcps');
      const data = await response.json();
      setMcps(data.mcps || []);
    } catch (error) {
      console.error('Failed to fetch MCPs:', error);
    }
  };

  const fetchPreview = async (mcpName: string) => {
    setPreviewMcp(mcpName);
    setPreviewLoading(true);
    setPreviewContent('');
    setCopied(false);
    
    try {
      const response = await fetch(`/api/mcp-learning-preview?mcp=${encodeURIComponent(mcpName)}`);
      const data = await response.json();
      if (data.error) {
        setPreviewContent(`Error: ${data.error}`);
      } else {
        setPreviewContent(data.prompt);
      }
    } catch (error) {
      setPreviewContent(`Failed to load preview: ${error}`);
    } finally {
      setPreviewLoading(false);
    }
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(previewContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  };

  const toggleMcp = (mcpName: string) => {
    setSelectedMcps(prev => {
      const next = new Set(prev);
      if (next.has(mcpName)) {
        next.delete(mcpName);
      } else {
        next.add(mcpName);
      }
      return next;
    });
  };

  const addLog = (type: LearningLog['type'], message: string, details?: any) => {
    setLogs(prev => [...prev, {
      id: `log-${Date.now()}-${Math.random()}`,
      timestamp: new Date(),
      type,
      message,
      details
    }]);
  };

  const startLearning = async () => {
    if (selectedMcps.size === 0) return;
    
    setIsLearning(true);
    setLogs([]);
    setProgress({
      phase: 'exploring',
      currentTool: '',
      toolIndex: 0,
      totalTools: 0,
      subToolsCreated: 0,
      inputsDocumented: 0
    });

    addLog('info', `Starting learning for ${selectedMcps.size} MCP(s): ${Array.from(selectedMcps).join(', ')}`);

    try {
      // Use EventSource for SSE
      const mcpList = Array.from(selectedMcps).join(',');
      const url = `/api/learn-mcp?mcps=${encodeURIComponent(mcpList)}&model=claude-opus-4.5`;
      
      eventSourceRef.current = new EventSource(url);
      
      eventSourceRef.current.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleLearningEvent(data);
        } catch (e) {
          console.error('Failed to parse event:', e);
        }
      };

      eventSourceRef.current.onerror = (error) => {
        console.error('EventSource error:', error);
        addLog('error', 'Connection lost. Learning may be incomplete.');
        setIsLearning(false);
        eventSourceRef.current?.close();
      };

    } catch (error) {
      addLog('error', `Failed to start learning: ${error}`);
      setIsLearning(false);
    }
  };

  const handleLearningEvent = (data: any) => {
    switch (data.type) {
      case 'progress':
        setProgress(prev => ({
          ...prev,
          ...data.progress
        }));
        break;
      
      case 'log':
        addLog(data.logType || 'info', data.message, data.details);
        break;
      
      case 'tool_call':
        addLog('tool_call', `Calling: ${data.tool}`, data.args);
        break;
      
      case 'tool_response':
        addLog('tool_response', `Response received from ${data.tool}`, 
          data.preview ? { preview: data.preview } : undefined);
        break;
      
      case 'web_browse':
        addLog('web_browse', `Browsing: ${data.url}`, data.reason);
        break;
      
      case 'subtool_created':
        addLog('subtool', `Created sub-tool: ${data.name}`, data.details);
        setProgress(prev => ({
          ...prev,
          subToolsCreated: prev.subToolsCreated + 1
        }));
        break;
      
      case 'input_documented':
        addLog('learning', `Documented input: ${data.inputName} for ${data.tool}`, data.details);
        setProgress(prev => ({
          ...prev,
          inputsDocumented: prev.inputsDocumented + 1
        }));
        break;
      
      case 'complete':
        addLog('info', `✅ Learning complete! Created ${data.subToolsCount} sub-tools.`);
        setProgress(prev => ({ ...prev, phase: 'complete' }));
        setIsLearning(false);
        eventSourceRef.current?.close();
        fetchMCPs(); // Refresh to show learned status
        break;
      
      case 'error':
        addLog('error', data.message);
        setProgress(prev => ({ ...prev, phase: 'error' }));
        setIsLearning(false);
        eventSourceRef.current?.close();
        break;
    }
  };

  const getLogIcon = (type: LearningLog['type']) => {
    switch (type) {
      case 'tool_call': return <Wrench className="w-4 h-4 text-blue-500" />;
      case 'tool_response': return <FileJson className="w-4 h-4 text-green-500" />;
      case 'subtool': return <GitBranch className="w-4 h-4 text-purple-500" />;
      case 'learning': return <GraduationCap className="w-4 h-4 text-amber-500" />;
      case 'web_browse': return <Globe className="w-4 h-4 text-cyan-500" />;
      case 'error': return <AlertCircle className="w-4 h-4 text-red-500" />;
      default: return <Circle className="w-4 h-4 text-slate-400" />;
    }
  };

  const getLogColor = (type: LearningLog['type']) => {
    switch (type) {
      case 'tool_call': return 'bg-blue-50 border-blue-200';
      case 'tool_response': return 'bg-green-50 border-green-200';
      case 'subtool': return 'bg-purple-50 border-purple-200';
      case 'learning': return 'bg-amber-50 border-amber-200';
      case 'web_browse': return 'bg-cyan-50 border-cyan-200';
      case 'error': return 'bg-red-50 border-red-200';
      default: return 'bg-slate-50 border-slate-200';
    }
  };

  const getPhaseLabel = (phase: string) => {
    switch (phase) {
      case 'idle': return 'Ready';
      case 'exploring': return 'Exploring Tools';
      case 'analyzing': return 'Analyzing Responses';
      case 'creating_subtools': return 'Creating Sub-tools';
      case 'complete': return 'Complete';
      case 'error': return 'Error';
      default: return phase;
    }
  };

  const progressPercentage = progress.totalTools > 0 
    ? Math.round((progress.toolIndex / progress.totalTools) * 100) 
    : 0;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-indigo-50">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button 
              onClick={onBack}
              className="p-2 hover:bg-slate-100 rounded-lg transition"
            >
              <ArrowLeft className="w-5 h-5 text-slate-600" />
            </button>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-100 flex items-center justify-center">
                <GraduationCap className="w-5 h-5 text-indigo-600" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-slate-900">MCP Learning Studio</h1>
                <p className="text-sm text-slate-500">Teach AI to master your tools</p>
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <span className="px-3 py-1.5 bg-slate-100 rounded-lg font-medium">
              Model: Claude Opus 4.5
            </span>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="grid grid-cols-3 gap-6">
          {/* Left Panel - MCP Selection */}
          <div className="col-span-1 space-y-4">
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 bg-slate-50">
                <h2 className="font-semibold text-slate-800">Select MCPs to Learn</h2>
              </div>
              
              <div className="p-4 space-y-2">
                {mcps.length === 0 ? (
                  <div className="text-center py-8 text-slate-500">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
                    <p className="text-sm">Loading MCPs...</p>
                  </div>
                ) : (
                  mcps.map(mcp => (
                    <div 
                      key={mcp.name}
                      className={`flex items-center gap-3 p-3 rounded-xl border transition ${
                        selectedMcps.has(mcp.name) 
                          ? 'bg-indigo-50 border-indigo-300' 
                          : 'bg-white border-slate-200 hover:border-slate-300'
                      } ${isLearning ? 'opacity-50' : ''}`}
                    >
                      <label className="flex items-center gap-3 flex-1 cursor-pointer">
                        <input 
                          type="checkbox"
                          checked={selectedMcps.has(mcp.name)}
                          onChange={() => !isLearning && toggleMcp(mcp.name)}
                          disabled={isLearning}
                          className="w-4 h-4 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-slate-800 truncate">{mcp.name}</span>
                            {mcp.hasLearning && (
                              <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-xs text-slate-500 mt-0.5">
                            <span>{mcp.toolCount} tools</span>
                            {mcp.hasLearning && (
                              <>
                                <span>•</span>
                                <span className="text-green-600">Learned</span>
                                {mcp.subToolCount && (
                                  <>
                                    <span>•</span>
                                    <span className="text-purple-600">{mcp.subToolCount} sub-tools</span>
                                  </>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                      </label>
                      {mcp.hasLearning && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            fetchPreview(mcp.name);
                          }}
                          className="p-2 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition"
                          title="Preview LLM Prompt"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>

              <div className="p-4 border-t border-slate-100">
                <button
                  onClick={startLearning}
                  disabled={selectedMcps.size === 0 || isLearning}
                  className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-medium transition ${
                    selectedMcps.size === 0 || isLearning
                      ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                      : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-lg shadow-indigo-200'
                  }`}
                >
                  {isLearning ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Learning...
                    </>
                  ) : (
                    <>
                      <Play className="w-5 h-5" />
                      {selectedMcps.size > 0 && Array.from(selectedMcps).some(m => mcps.find(x => x.name === m)?.hasLearning) 
                        ? 'Re-learn Selected' 
                        : 'Start Learning'}
                    </>
                  )}
                </button>
                
                {selectedMcps.size > 0 && Array.from(selectedMcps).some(m => mcps.find(x => x.name === m)?.hasLearning) && (
                  <p className="text-xs text-amber-600 mt-2 flex items-center gap-1">
                    <RefreshCw className="w-3 h-3" />
                    This will replace existing learnings
                  </p>
                )}
              </div>
            </div>

            {/* Progress Panel */}
            {(isLearning || progress.phase === 'complete') && (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100 bg-slate-50">
                  <h2 className="font-semibold text-slate-800">Progress</h2>
                </div>
                
                <div className="p-4 space-y-4">
                  {/* Phase indicator */}
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${
                      progress.phase === 'complete' ? 'bg-green-500' :
                      progress.phase === 'error' ? 'bg-red-500' :
                      'bg-indigo-500 animate-pulse'
                    }`} />
                    <span className="text-sm font-medium text-slate-700">
                      {getPhaseLabel(progress.phase)}
                    </span>
                  </div>

                  {/* Progress bar */}
                  {progress.totalTools > 0 && (
                    <div>
                      <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
                        <span>Tool {progress.toolIndex}/{progress.totalTools}</span>
                        <span>{progressPercentage}%</span>
                      </div>
                      <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-indigo-500 transition-all duration-300"
                          style={{ width: `${progressPercentage}%` }}
                        />
                      </div>
                      {progress.currentTool && (
                        <p className="text-xs text-slate-500 mt-1 truncate">
                          Current: {progress.currentTool}
                        </p>
                      )}
                    </div>
                  )}

                  {/* Stats */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-purple-50 rounded-lg p-3">
                      <div className="text-2xl font-bold text-purple-600">{progress.subToolsCreated}</div>
                      <div className="text-xs text-purple-600">Sub-tools Created</div>
                    </div>
                    <div className="bg-amber-50 rounded-lg p-3">
                      <div className="text-2xl font-bold text-amber-600">{progress.inputsDocumented}</div>
                      <div className="text-xs text-amber-600">Inputs Documented</div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Right Panel - Learning Log */}
          <div className="col-span-2">
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden h-[calc(100vh-12rem)]">
              <div className="px-4 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                <h2 className="font-semibold text-slate-800">Learning Log</h2>
                {logs.length > 0 && (
                  <span className="text-xs text-slate-500">{logs.length} events</span>
                )}
              </div>
              
              <div className="p-4 overflow-y-auto h-[calc(100%-3.5rem)] space-y-2">
                {logs.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-slate-400">
                    <GraduationCap className="w-12 h-12 mb-3 opacity-50" />
                    <p className="text-sm">Select MCPs and start learning to see activity here</p>
                  </div>
                ) : (
                  logs.map(log => (
                    <div 
                      key={log.id}
                      className={`rounded-lg border p-3 ${getLogColor(log.type)}`}
                    >
                      <div className="flex items-start gap-2">
                        {getLogIcon(log.type)}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm text-slate-800">{log.message}</span>
                            <span className="text-[10px] text-slate-400 flex-shrink-0">
                              {log.timestamp.toLocaleTimeString()}
                            </span>
                          </div>
                          {log.details && (
                            <pre className="mt-2 text-xs text-slate-600 bg-white/50 rounded p-2 overflow-x-auto max-h-32 overflow-y-auto">
                              {typeof log.details === 'object' 
                                ? JSON.stringify(log.details, null, 2)
                                : log.details}
                            </pre>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                )}
                <div ref={logsEndRef} />
              </div>
            </div>
          </div>
        </div>

        {/* Legend */}
        <div className="mt-6 flex items-center justify-center gap-4 text-xs text-slate-500">
          <div className="flex items-center gap-1">
            <Wrench className="w-3 h-3 text-blue-500" />
            <span>Tool Call</span>
          </div>
          <div className="flex items-center gap-1">
            <FileJson className="w-3 h-3 text-green-500" />
            <span>Response</span>
          </div>
          <div className="flex items-center gap-1">
            <Globe className="w-3 h-3 text-cyan-500" />
            <span>Web Browse</span>
          </div>
          <div className="flex items-center gap-1">
            <GraduationCap className="w-3 h-3 text-amber-500" />
            <span>Learning</span>
          </div>
          <div className="flex items-center gap-1">
            <GitBranch className="w-3 h-3 text-purple-500" />
            <span>Sub-tool</span>
          </div>
        </div>
      </div>

      {/* Preview Modal */}
      {previewMcp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-[90vw] max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-slate-800">
                  LLM Prompt Preview: {previewMcp}
                </h2>
                <p className="text-sm text-slate-500">
                  This is the exact prompt section that will be given to LLMs to use this MCP
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={copyToClipboard}
                  disabled={previewLoading || !previewContent}
                  className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-slate-600 hover:text-slate-800 bg-white hover:bg-slate-100 rounded-lg border border-slate-200 transition disabled:opacity-50"
                >
                  {copied ? (
                    <>
                      <Check className="w-4 h-4 text-green-500" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4" />
                      Copy
                    </>
                  )}
                </button>
                <button
                  onClick={() => setPreviewMcp(null)}
                  className="p-2 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            
            {/* Modal Content */}
            <div className="flex-1 overflow-auto p-6">
              {previewLoading ? (
                <div className="flex flex-col items-center justify-center h-64 text-slate-500">
                  <Loader2 className="w-8 h-8 animate-spin mb-3" />
                  <p>Loading preview...</p>
                </div>
              ) : (
                <pre className="text-sm text-slate-700 font-mono whitespace-pre-wrap bg-slate-50 rounded-xl p-4 border border-slate-200 overflow-x-auto">
                  {previewContent}
                </pre>
              )}
            </div>
            
            {/* Modal Footer */}
            <div className="px-6 py-3 border-t border-slate-200 bg-slate-50 text-xs text-slate-500">
              <p>
                💡 This prompt is automatically injected into the system message when using learned MCPs.
                Sub-tools are called through the standard tool calling mechanism, with JSONPath extraction applied automatically.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

