export type ProgressCallback = (status: string, detail?: string) => void;

// Debug event type for multi-agent system
export interface DebugEvent {
  timestamp: Date;
  agent: string;
  step: number;
  action: string;
  details: any;
}

export type DebugCallback = (event: DebugEvent) => void;

export const generateUI = async (
  prompt: string, 
  history: { role: string, content: string }[],
  onProgress?: ProgressCallback,
  model?: string,
  onDebug?: DebugCallback
) => {
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: prompt,
        history: history,
        model: model || 'claude-opus-4.5'
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Server error: ${errorText}`);
    }

    // Handle SSE stream
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let result = '';
    let buffer = '';

    if (!reader) {
      throw new Error('No response body');
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Append new data to buffer
      buffer += decoder.decode(value, { stream: true });
      
      // Process complete lines from buffer
      const lines = buffer.split('\n');
      // Keep the last potentially incomplete line in the buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('data: ')) {
          const jsonStr = trimmedLine.slice(6);
          if (jsonStr) {
            try {
              const data = JSON.parse(jsonStr);
              
              if (data.type === 'progress' && onProgress) {
                onProgress(data.status, data.detail);
              } else if (data.type === 'debug' && onDebug) {
                // Handle debug events from multi-agent system
                onDebug({
                  timestamp: new Date(),
                  agent: data.agent,
                  step: data.step,
                  action: data.action,
                  details: data.details
                });
              } else if (data.type === 'result') {
                result = data.text;
              } else if (data.type === 'error') {
                throw new Error(data.error);
              }
            } catch (parseError) {
              // Log but don't fail on parse errors - might be incomplete JSON
              console.debug('SSE parse skip:', jsonStr);
            }
          }
        }
      }
    }

    // Process any remaining data in buffer
    if (buffer.trim().startsWith('data: ')) {
      const jsonStr = buffer.trim().slice(6);
      if (jsonStr) {
        try {
          const data = JSON.parse(jsonStr);
          if (data.type === 'result') {
            result = data.text;
          }
        } catch (e) {
          // Ignore final parse errors
        }
      }
    }

    return result || 'alert: (title: No Response, description: The AI did not generate a response.)';

  } catch (error: any) {
    console.error("API Error:", error);
    return `alert: (title: Generation Error, description: "${error.message}")\n\nI'm sorry, I couldn't process that request properly.`;
  }
};

// Tool-calling agent event types
export interface ToolCallingEvent {
  type: string;
  [key: string]: any;
}

export type ToolCallingCallback = (event: ToolCallingEvent) => void;

// Tool-calling agent API
export const generateWithToolCallingAgent = async (
  message: string,
  history: { role: string; content: string }[],
  model: string,
  onProgress?: ProgressCallback,
  onEvent?: ToolCallingCallback
): Promise<{ dsl: string[]; message: string; history: { role: string; content: string }[] }> => {
  try {
    const response = await fetch('/api/tool-calling-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history, model })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Server error: ${errorText}`);
    }

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResult: { dsl: string[]; message: string; history: any[] } = { dsl: [], message: '', history: [] };

    if (!reader) throw new Error('No response body');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          try {
            const data = JSON.parse(trimmed.slice(6));
            
            // Send all events to callback
            if (onEvent) onEvent(data);
            
            // Update progress
            if (data.type === 'agent_thinking' && onProgress) {
              onProgress('thinking', `Iteration ${data.iteration}...`);
            } else if (data.type === 'executing_tool' && onProgress) {
              onProgress('generating', `Calling ${data.tool}...`);
            } else if (data.type === 'ui_creating' && onProgress) {
              onProgress('generating', `Creating ${data.tool}...`);
            } else if (data.type === 'complete') {
              finalResult = { 
                dsl: data.dsl || [], 
                message: data.message || '', 
                history: data.history || [] 
              };
            } else if (data.type === 'error') {
              throw new Error(data.message);
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      }
    }

    return finalResult;
  } catch (error: any) {
    console.error('Tool-calling agent error:', error);
    return { 
      dsl: [`alert: (title: Error, description: "${error.message}")`], 
      message: error.message, 
      history 
    };
  }
};
