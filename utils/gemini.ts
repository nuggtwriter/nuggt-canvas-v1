export type ProgressCallback = (status: string, detail?: string) => void;

export const generateUI = async (
  prompt: string, 
  history: { role: string, content: string }[],
  onProgress?: ProgressCallback
) => {
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: prompt,
        history: history
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
