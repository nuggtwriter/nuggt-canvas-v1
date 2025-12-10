
import { eventBus } from './events';
import { InputStore } from './store';

// Process Action Prompts and trigger LLM generation

export const executeAction = (prompt: string): void => {
  if (!prompt) return;

  // Pattern to find variables like <myId>
  // Global flag 'g' to replace all occurrences
  const regex = /<([^>]+)>/g;

  // Collect all input values with their context
  const inputValues: Record<string, string> = {};
  
  // Replace <id> with actual values and collect them
  const processedMessage = prompt.replace(regex, (match, id) => {
    const trimmedId = id.trim();
    // 1. Check if ID exists in User Input Store
    const storedValue = InputStore.getValue(trimmedId);
    
    if (storedValue !== undefined) {
      // It is a user input, use the value
      inputValues[trimmedId] = storedValue;
      return storedValue;
    } else {
      // It is a visual ID or static ID, just print the ID itself (stripped of <>)
      return trimmedId;
    }
  });

  // Emit an event to trigger LLM generation with the collected inputs
  eventBus.emit('actionSubmit', { 
    prompt: processedMessage, 
    rawPrompt: prompt,
    inputValues,
    allInputs: InputStore.getAll()
  });
};
