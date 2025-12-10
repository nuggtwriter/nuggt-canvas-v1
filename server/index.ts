import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EventSource } from 'eventsource';
import { getComponentPrompt, AVAILABLE_COMPONENTS, NUGGT_PROMPTS } from './nuggt-prompts.js';

// Polyfill EventSource for Node.js
(global as any).EventSource = EventSource;

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Create OpenRouter client (OpenAI-compatible)
function createOpenRouterClient(): OpenAI {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OpenRouter API key not configured');
  }
  return new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: OPENROUTER_API_KEY,
    defaultHeaders: {
      'HTTP-Referer': 'https://nuggt.app',
      'X-Title': 'Nuggt'
    }
  });
}

// At least one API key should be present
if (!GEMINI_API_KEY && !ANTHROPIC_API_KEY && !OPENAI_API_KEY && !OPENROUTER_API_KEY) {
  console.error("Missing API keys. Please provide at least one of GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY in environment variables");
  process.exit(1);
}

// --- MCP CLIENT MANAGER ---

// Sanitize tool name to fit within 64 character limit and be valid for all providers
// OpenAI/Gemini require: alphanumeric, underscores, dots, colons, dashes, max 64 chars
const sanitizeToolName = (serverName: string, toolName: string): string => {
  // Create namespaced name
  let name = `${serverName}__${toolName}`;
  
  // Replace any invalid characters with underscores
  name = name.replace(/[^a-zA-Z0-9_.\-:]/g, '_');
  
  // Ensure it starts with a letter or underscore
  if (!/^[a-zA-Z_]/.test(name)) {
    name = '_' + name;
  }
  
  // Truncate to 64 characters if needed
  if (name.length > 64) {
    // Keep the first part and add a hash suffix for uniqueness
    const hash = name.split('').reduce((a, b) => {
      a = ((a << 5) - a) + b.charCodeAt(0);
      return a & a;
    }, 0).toString(16).slice(-6);
    name = name.slice(0, 57) + '_' + hash;
  }
  
  return name;
};

class MCPManager {
  private clients: Map<string, Client> = new Map();
  private tools: any[] = [];
  private nameMapping: Map<string, { serverName: string; originalName: string }> = new Map();

  async loadConfig() {
    try {
      const configPath = path.resolve(process.cwd(), 'mcp-config.json');
      if (!fs.existsSync(configPath)) {
        console.log("No mcp-config.json found. Skipping MCP initialization.");
        return;
      }
      
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const servers = config.mcpServers || {};

      for (const [name, serverConfig] of Object.entries(servers) as [string, any][]) {
        console.log(`Connecting to MCP server: ${name}...`);
        try {
          let transport;
          if (serverConfig.command) {
             transport = new StdioClientTransport({
              command: serverConfig.command,
              args: serverConfig.args || [],
              env: { ...process.env, ...serverConfig.env }
            });
          } else if (serverConfig.transport === 'streamable-http' && serverConfig.url) {
             transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
               requestInit: serverConfig.requestInit
             });
          } else if (serverConfig.url) {
             transport = new SSEClientTransport(new URL(serverConfig.url), {
               requestInit: serverConfig.requestInit
             });
          } else {
             console.error(`Server ${name} has no command or url configured.`);
             continue;
          }

          const client = new Client({
            name: "nuggt-client",
            version: "1.0.0",
          }, {
            capabilities: {}
          });

          await client.connect(transport);
          this.clients.set(name, client);
          
          // Fetch tools
          const listToolsResult = await client.listTools();
          if (listToolsResult && listToolsResult.tools) {
             const serverTools = listToolsResult.tools.map(t => {
               const sanitizedName = sanitizeToolName(name, t.name);
               // Store the mapping for later lookup
               this.nameMapping.set(sanitizedName, { serverName: name, originalName: t.name });
               return {
                 ...t,
                 name: sanitizedName,
                 originalName: t.name,
                 serverName: name
               };
             });
             this.tools.push(...serverTools);
             console.log(`  Loaded ${serverTools.length} tools from ${name}`);
          }

        } catch (err) {
          console.error(`  Failed to connect to ${name}:`, err);
        }
      }
    } catch (e) {
      console.error("Error loading MCP config:", e);
    }
  }

  getToolsForGemini() {
    if (!this.tools.length) return [];
    return [{
      functionDeclarations: this.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
      }))
    }];
  }
  
  getToolsForClaude(): Anthropic.Tool[] {
    if (!this.tools.length) return [];
    return this.tools.map(tool => ({
      name: tool.name,
      description: tool.description || '',
      input_schema: tool.inputSchema || { type: 'object', properties: {} }
    }));
  }
  
  getToolsForOpenAI(): OpenAI.Chat.Completions.ChatCompletionTool[] {
    if (!this.tools.length) return [];
    // OpenAI has a limit of 128 tools
    const limitedTools = this.tools.slice(0, 128);
    return limitedTools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.inputSchema || { type: 'object', properties: {} }
      }
    }));
  }

  // Get raw tools for learning/inspection
  getTools(): any[] {
    return this.tools;
  }
  
  async callTool(name: string, args: any) {
    // First try to find by sanitized name
    let tool = this.tools.find(t => t.name === name);
    
    // If not found, try the name mapping
    if (!tool) {
      const mapping = this.nameMapping.get(name);
      if (mapping) {
        tool = this.tools.find(t => t.serverName === mapping.serverName && t.originalName === mapping.originalName);
      }
    }
    
    if (!tool) throw new Error(`Tool ${name} not found`);
    
    const client = this.clients.get(tool.serverName);
    if (!client) throw new Error(`Client for ${tool.serverName} not found`);
    
    return await client.callTool({
      name: tool.originalName,
      arguments: args
    });
  }
}

const mcpManager = new MCPManager();

// Load MCP config in background (non-blocking)
mcpManager.loadConfig().catch(err => {
  console.error("Failed to load MCP config:", err);
});

// ============================================================================
// SUB-TOOL SYSTEM FOR LEARNED MCPs
// ============================================================================
// When MCPs have been learned, we use sub-tools instead of original tools.
// Sub-tools are more focused and include JSONPath extraction.
// ============================================================================

interface SubToolInput {
  name: string;
  type: string;
  required: boolean;
  description: string;
  mapToParentArg?: string;
  options?: Array<{ value: string; description?: string }>;
  format?: string;
  source?: { tool: string; fromPath: string };
  default?: any;
}

interface SubTool {
  id: string;
  name: string;
  description: string;
  parentTool: string;
  parentToolDefaultArgs?: Record<string, any>;
  requiresFirst?: Array<{
    subTool: string;
    reason: string;
    extractField: string;
    fromPath: string;
  }>;
  inputs: SubToolInput[];
  jsonPath: string;
  outputFields: Array<{
    name: string;
    path: string;
    type: string;
    description: string;
  }>;
  outputExample?: any;
}

interface Workflow {
  id: string;
  userTask: string;
  category: string;
  steps: any[];
  answerTemplate?: string;
  decisionPoints?: string[];
}

interface MCPLearning {
  mcpName: string;
  subTools: SubTool[];
  workflows: Workflow[];
  insights: string;
}

// Cache for loaded learnings
const learningsCache: Map<string, MCPLearning> = new Map();

// Load learnings for all MCPs that have learning files
function loadAllLearnings(): void {
  const learningsDir = path.join(process.cwd(), 'mcp-learnings');
  
  if (!fs.existsSync(learningsDir)) {
    console.log('[SubTools] No mcp-learnings directory found');
    return;
  }
  
  const files = fs.readdirSync(learningsDir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
  
  for (const file of files) {
    try {
      const filePath = path.join(learningsDir, file);
      const learning = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as MCPLearning;
      learningsCache.set(learning.mcpName, learning);
      console.log(`[SubTools] Loaded ${learning.subTools?.length || 0} sub-tools from ${file}`);
    } catch (e) {
      console.error(`[SubTools] Failed to load ${file}:`, e);
    }
  }
}

// Check if we have learnings for any loaded MCPs
function hasAnyLearnings(): boolean {
  return learningsCache.size > 0;
}

// Get all sub-tools from all learned MCPs
function getAllSubTools(): SubTool[] {
  const allSubTools: SubTool[] = [];
  for (const learning of learningsCache.values()) {
    if (learning.subTools) {
      allSubTools.push(...learning.subTools);
    }
  }
  return allSubTools;
}

// Get all workflows from all learned MCPs
function getAllWorkflows(): Workflow[] {
  const allWorkflows: Workflow[] = [];
  for (const learning of learningsCache.values()) {
    if (learning.workflows) {
      allWorkflows.push(...learning.workflows);
    }
  }
  return allWorkflows;
}

// Build sub-tool descriptions for PLANNER (summaries only)
function buildSubToolDescriptionsForPlanner(): string {
  const subTools = getAllSubTools();
  const workflows = getAllWorkflows();
  
  if (subTools.length === 0) {
    return '(No learned sub-tools available)';
  }
  
  let result = '## AVAILABLE SUB-TOOLS\n\n';
  
  for (const st of subTools) {
    const reqInputs = st.inputs.filter(i => i.required).map(i => i.name).join(', ');
    const optInputs = st.inputs.filter(i => !i.required).map(i => i.name).join(', ');
    
    result += `**${st.name}** (ID: ${st.id})\n`;
    result += `${st.description}\n`;
    if (reqInputs) result += `Required: ${reqInputs}\n`;
    if (optInputs) result += `Optional: ${optInputs}\n`;
    if (st.requiresFirst && st.requiresFirst.length > 0) {
      result += `⚠️ Must call first: ${st.requiresFirst.map(r => r.subTool).join(', ')}\n`;
    }
    result += '\n';
  }
  
  if (workflows.length > 0) {
    result += '\n## EXAMPLE WORKFLOWS\n';
    result += 'For complex tasks, consider these patterns:\n\n';
    for (const wf of workflows.slice(0, 5)) {
      result += `• **${wf.userTask}** (${wf.category})\n`;
    }
  }
  
  return result;
}

// Build FULL sub-tool documentation for TOOL AGENT
function buildSubToolDocsForToolAgent(): string {
  const subTools = getAllSubTools();
  
  if (subTools.length === 0) {
    return '(No learned sub-tools available)';
  }
  
  let result = '## COMPLETE SUB-TOOL DOCUMENTATION\n\n';
  
  for (const st of subTools) {
    result += `### ${st.name}\n`;
    result += `**ID:** ${st.id}\n`;
    result += `**Description:** ${st.description}\n`;
    result += `**Parent MCP Tool:** ${st.parentTool}\n`;
    
    if (st.requiresFirst && st.requiresFirst.length > 0) {
      result += '\n**⚠️ DEPENDENCIES - Must call these first:**\n';
      for (const dep of st.requiresFirst) {
        result += `  - Call \`${dep.subTool}\` first to get \`${dep.extractField}\`\n`;
        result += `    Reason: ${dep.reason}\n`;
      }
    }
    
    if (st.inputs.length > 0) {
      result += '\n**INPUTS:**\n';
      for (const inp of st.inputs) {
        const req = inp.required ? '(REQUIRED)' : '(optional)';
        result += `  - \`${inp.name}\` ${req}: ${inp.description || inp.type}\n`;
        
        if (inp.type === 'enum' && inp.options) {
          result += '    Valid values:\n';
          for (const opt of inp.options.slice(0, 8)) {
            result += `      - "${opt.value}"${opt.description ? `: ${opt.description}` : ''}\n`;
          }
          if (inp.options.length > 8) {
            result += `      - ... and ${inp.options.length - 8} more\n`;
          }
        }
        
        if (inp.format) {
          result += `    Format: ${inp.format}\n`;
        }
        
        if (inp.source) {
          result += `    Get value from: Call ${inp.source.tool} first, extract with ${inp.source.fromPath}\n`;
        }
        
        if (inp.default !== undefined) {
          result += `    Default: ${inp.default}\n`;
        }
      }
    } else {
      result += '\n**INPUTS:** None required\n';
    }
    
    if (st.outputFields && st.outputFields.length > 0) {
      result += '\n**RETURNS:**\n';
      for (const field of st.outputFields) {
        result += `  - \`${field.name}\` (${field.type}): ${field.description}\n`;
      }
    }
    
    if (st.outputExample) {
      result += '\n**Example output:**\n```json\n';
      result += JSON.stringify(st.outputExample, null, 2).slice(0, 500);
      result += '\n```\n';
    }
    
    result += '\n---\n\n';
  }
  
  return result;
}

// Build sub-tool docs in CALL SYNTAX format for tool-calling agent
function buildSubToolDocsForToolCallingAgent(): string {
  const subTools = getAllSubTools();
  
  if (subTools.length === 0) {
    return '(No learned sub-tools available)';
  }
  
  let result = '';
  
  for (const st of subTools) {
    // Build the call signature
    let callSignature = st.id + '(';
    const argParts: string[] = [];
    
    for (const inp of st.inputs || []) {
      let argStr = inp.name + ': ';
      
      if (inp.required) {
        argStr += '<required';
      } else {
        argStr += '<optional';
      }
      
      // Add type info or options
      if (inp.type === 'enum' && inp.options && inp.options.length > 0) {
        const optionValues = inp.options.slice(0, 5).map((o: any) => `"${o.value || o}"`).join(' | ');
        argStr += ': ' + optionValues;
        if (inp.options.length > 5) {
          argStr += ' | ...';
        }
      } else if (inp.format) {
        argStr += ': ' + inp.format;
      } else if (inp.type) {
        argStr += ': ' + inp.type;
      }
      
      argStr += '>';
      argParts.push(argStr);
    }
    
    callSignature += argParts.join(', ') + ')';
    
    // Build the output fields list
    const outputFields = (st.outputFields || []).map((f: any) => f.name);
    const outputFieldsStr = outputFields.length > 0 ? outputFields.join(', ') : 'raw data';
    
    // Build access examples
    const accessExamples = outputFields.length > 0
      ? outputFields.map((f: string) => `<variable>[${f}]`).join(', ')
      : '<variable>';
    
    // Start building the entry
    result += `${callSignature}\n`;
    result += `  ${st.description}\n`;
    
    // Add dependencies if any
    if (st.requiresFirst && st.requiresFirst.length > 0) {
      for (const dep of st.requiresFirst) {
        result += `  REQUIRES: ${dep.extractField} from ${dep.subTool}()\n`;
      }
    }
    
    // Add returns info
    result += `  RETURNS: ${outputFieldsStr}\n`;
    
    // Add access syntax
    result += `  ACCESS: ${accessExamples}\n`;
    
    // Add input details if there are options or special formats
    for (const inp of st.inputs || []) {
      if (inp.type === 'enum' && inp.options && inp.options.length > 0) {
        const allOptions = inp.options.map((o: any) => `"${o.value || o}"`).join(', ');
        result += `  ${inp.name} options: ${allOptions}\n`;
      }
      if (inp.description && inp.description.length > 0) {
        result += `  ${inp.name}: ${inp.description}\n`;
      }
    }
    
    result += '\n';
  }
  
  return result;
}

// Find a sub-tool by ID or name
function findSubTool(idOrName: string): SubTool | undefined {
  const allSubTools = getAllSubTools();
  return allSubTools.find(st => st.id === idOrName || st.name === idOrName || st.name.toLowerCase() === idOrName.toLowerCase());
}

// Set a nested value in an object using a path like "date_ranges[0].start_date"
// This handles:
// - Simple properties: "property_id" → obj.property_id = value
// - Array indices: "date_ranges[0]" → obj.date_ranges[0] = value
// - Nested paths: "date_ranges[0].start_date" → obj.date_ranges[0].start_date = value
function setNestedValue(obj: any, path: string, value: any): void {
  // Parse the path into parts: "date_ranges[0].start_date" → ["date_ranges", "0", "start_date"]
  const parts = path.match(/([^.\[\]]+)/g) || [];
  
  if (parts.length === 0) return;
  
  let current = obj;
  
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const nextPart = parts[i + 1];
    const isCurrentNumeric = /^\d+$/.test(part);
    const isNextNumeric = /^\d+$/.test(nextPart);
    
    if (isCurrentNumeric) {
      // Current part is array index
      const index = parseInt(part, 10);
      // Ensure array exists and has enough elements
      while (current.length <= index) {
        current.push(isNextNumeric ? [] : {});
      }
      if (!current[index]) {
        current[index] = isNextNumeric ? [] : {};
      }
      current = current[index];
    } else {
      // Current part is property name
      if (!current[part]) {
        current[part] = isNextNumeric ? [] : {};
      }
      current = current[part];
    }
  }
  
  // Set the final value
  const lastPart = parts[parts.length - 1];
  if (/^\d+$/.test(lastPart)) {
    const index = parseInt(lastPart, 10);
    while (current.length <= index) {
      current.push(null);
    }
    current[index] = value;
  } else {
    current[lastPart] = value;
  }
}

// Execute a sub-tool call: maps to parent tool + extracts via JSONPath
async function executeSubTool(
  subToolIdOrName: string,
  args: Record<string, any>
): Promise<{ success: boolean; data?: any; error?: string; rawResponse?: any }> {
  const subTool = findSubTool(subToolIdOrName);
  
  if (!subTool) {
    return { success: false, error: `Sub-tool not found: ${subToolIdOrName}` };
  }
  
  console.log(`[SubTool] Executing ${subTool.name} (parent: ${subTool.parentTool})`);
  
  // Build parent tool arguments - start with deep copy of defaults
  const parentArgs: Record<string, any> = JSON.parse(JSON.stringify(subTool.parentToolDefaultArgs || {}));
  
  // Map sub-tool inputs to parent tool args
  // Handle nested paths like "date_ranges[0].start_date"
  for (const input of subTool.inputs) {
    if (args[input.name] !== undefined) {
      const targetPath = input.mapToParentArg || input.name;
      setNestedValue(parentArgs, targetPath, args[input.name]);
    }
  }
  
  console.log(`[SubTool] Parent tool args: ${JSON.stringify(parentArgs, null, 2)}`);
  
  try {
    // Call the parent MCP tool
    const rawResult = await mcpManager.callTool(subTool.parentTool, parentArgs);
    
    // First, unwrap the MCP response format to get the actual data
    const unwrappedData = unwrapMCPResponse(rawResult);
    
    console.log(`[SubTool] Unwrapped MCP response. Type: ${typeof unwrappedData}, IsArray: ${Array.isArray(unwrappedData)}`);
    
    // Extract data using JSONPath on the unwrapped data
    let extractedData: any;
    if (subTool.jsonPath) {
      try {
        // Apply JSONPath to the unwrapped data (not the raw MCP response)
        extractedData = extractByPath(unwrappedData, subTool.jsonPath);
      } catch (e) {
        console.error(`[SubTool] JSONPath extraction failed:`, e);
        extractedData = unwrappedData;
      }
    } else {
      extractedData = unwrappedData;
    }
    
    console.log(`[SubTool] Extracted ${Array.isArray(extractedData) ? extractedData.length + ' items' : 'data'}`);
    
    return { 
      success: true, 
      data: extractedData,
      rawResponse: unwrappedData  // Return unwrapped data for debugging (not the MCP wrapper)
    };
    
  } catch (error: any) {
    console.error(`[SubTool] Execution failed:`, error);
    return { success: false, error: error.message };
  }
}

// Unwrap MCP response format to get the actual tool data
// MCP tools return: { content: [{ type: "text", text: "{ JSON string }" }, ...] }
// We need to extract and parse the actual data from ALL content items
function unwrapMCPResponse(response: any): any {
  if (!response) return response;
  
  // Check if this is the standard MCP format with content array
  if (response.content && Array.isArray(response.content) && response.content.length > 0) {
    console.log(`[MCP Unwrap] Found MCP content array with ${response.content.length} items`);
    
    // Process ALL content items, not just the first one
    const results: any[] = [];
    
    for (const contentItem of response.content) {
      // Check if it's a text type with a text field
      if (contentItem.type === 'text' && typeof contentItem.text === 'string') {
        try {
          // Parse the JSON string inside the text field
          const parsed = JSON.parse(contentItem.text);
          results.push(parsed);
        } catch (e) {
          // Not valid JSON, add the text as-is
          results.push(contentItem.text);
        }
      } else if (contentItem.text) {
        // Has text but not type: "text"
        try {
          results.push(JSON.parse(contentItem.text));
        } catch (e) {
          results.push(contentItem.text);
        }
      } else if (contentItem.data) {
        // Some content types have data field
        results.push(contentItem.data);
      }
    }
    
    // If we got results, return them
    if (results.length > 0) {
      // If only one result, return it directly (not wrapped in array)
      // If multiple results, return as array
      const finalResult = results.length === 1 ? results[0] : results;
      console.log(`[MCP Unwrap] Extracted ${results.length} item(s). Type: ${Array.isArray(finalResult) ? 'array' : typeof finalResult}`);
      return finalResult;
    }
  }
  
  // Check if response itself is a string that needs parsing
  if (typeof response === 'string') {
    try {
      return JSON.parse(response);
    } catch (e) {
      return response;
    }
  }
  
  // Already unwrapped or different format, return as-is
  console.log(`[MCP Unwrap] Response not in standard MCP format, using as-is`);
  return response;
}

// Simple JSONPath-like extraction (handles common patterns)
function extractByPath(data: any, jsonPath: string): any {
  if (!jsonPath || jsonPath === '$') return data;
  if (data === undefined || data === null) return undefined;
  
  console.log(`[JSONPath] Original path: ${jsonPath}`);
  console.log(`[JSONPath] Data structure keys:`, data && typeof data === 'object' ? Object.keys(data) : typeof data);
  
  // Remove leading $. if present
  let path = jsonPath.replace(/^\$\.?/, '');
  
  // ALWAYS strip "result[*]." from the beginning of paths
  // This was an artifact from the learning process where LLM saw MCP wrapper
  if (path.startsWith('result[*].')) {
    path = path.replace('result[*].', '');
    console.log(`[JSONPath] Stripped result[*]. from path. New path: ${path}`);
  } else if (path.startsWith('result.')) {
    path = path.replace('result.', '');
    console.log(`[JSONPath] Stripped result. from path. New path: ${path}`);
  } else if (path === 'result[*]' || path === 'result') {
    // If the entire path is just "result[*]" or "result", return the data as-is
    console.log(`[JSONPath] Path was just "result", returning data as-is`);
    return data;
  }
  
  // Now extract with the cleaned path
  let result = tryExtractPath(data, path);
  
  // If extraction didn't work and data is an array, try extracting from each element
  if (result === undefined && Array.isArray(data)) {
    console.log(`[JSONPath] Data is array with ${data.length} items, extracting from each`);
    const extracted = data.map(item => tryExtractPath(item, path)).flat().filter(x => x !== undefined);
    if (extracted.length > 0) {
      result = extracted;
    }
  }
  
  console.log(`[JSONPath] Extraction result: ${result === undefined ? 'undefined' : (Array.isArray(result) ? result.length + ' items' : typeof result)}`);
  return result;
}

// Helper to try extracting a path
function tryExtractPath(data: any, path: string): any {
  if (!path) return data;
  if (data === undefined || data === null) return undefined;
  
  // Handle the nested [*] pattern like: property_summaries[*]
  if (path.includes('[*]')) {
    return extractWithWildcards(data, path);
  }
  
  // Simple property path without wildcards
  const parts = path.split('.');
  let current = data;
  
  for (const part of parts) {
    if (current === undefined || current === null) {
      return undefined;
    }
    current = current[part];
  }
  
  return current;
}

// Handle paths with [*] wildcards
function extractWithWildcards(data: any, path: string): any {
  if (data === undefined || data === null) return undefined;
  
  // Split on [*] to get segments
  const segments = path.split('[*]');
  
  let current: any = data;
  
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    
    // Remove leading dot if present
    const cleanSegment = segment.replace(/^\./, '');
    
    if (cleanSegment) {
      // Navigate to the property
      const props = cleanSegment.split('.');
      for (const prop of props) {
        if (prop && current !== undefined && current !== null) {
          current = current[prop];
        }
      }
    }
    
    // If not the last segment and current is an array, we need to flatten
    if (i < segments.length - 1 && Array.isArray(current)) {
      // Get the next segment's property path
      const nextSegment = segments[i + 1]?.replace(/^\./, '');
      
      if (nextSegment) {
        // For each array item, get the nested property and flatten
        const results: any[] = [];
        for (const item of current) {
          let nested = item;
          const nestedProps = nextSegment.split('.');
          for (const prop of nestedProps) {
            if (prop && nested !== undefined && nested !== null) {
              nested = nested[prop];
            }
          }
          if (Array.isArray(nested)) {
            results.push(...nested);
          } else if (nested !== undefined) {
            results.push(nested);
          }
        }
        current = results;
        i++; // Skip the next segment since we already processed it
      } else {
        // No next segment, just flatten the array
        current = current.flat();
      }
    }
  }
  
  console.log(`[JSONPath] Extraction result: ${Array.isArray(current) ? current.length + ' items' : typeof current}`);
  return current;
}

// Load learnings on startup
loadAllLearnings();

const formatToolResponse = (result: any) => {
  if (result === undefined || result === null) return {};
  if (typeof result === 'string') {
    try {
      const parsed = JSON.parse(result);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed;
      }
    } catch {
      // ignore parse errors, fall back to text wrapper
    }
    return { text: result };
  }
  if (typeof result === 'object') {
    return result;
  }
  return { text: String(result) };
};

// --- GEMINI LOGIC ---

const SYSTEM_INSTRUCTION = `
You are an expert UI generator that converts natural language requests into a specific shortcode DSL called "Nuggt". 
Your goal is to generate the UI components (Nuggts) first, followed by a polite and helpful response in Markdown.

### CRITICAL RULES
1. **Order**: Always output the Nuggt DSL lines FIRST. Then output your conversational response.
2. **Formatting**: Do NOT use markdown code blocks (like \`\`\` or \`\`\`nuggt\`) for the DSL lines. Output the raw lines directly.
3. **Syntax**: Follow the syntax exactly. Do not add extra spaces or characters inside the bracket structures that are not defined.
4. **Markdown**: Any text that is NOT a valid Nuggt shortcode will be rendered as Markdown text. Use this for your explanations and guidance.

### AUTO-CANVAS BEHAVIOR
- **Display components** (card, alert, accordion) and **Visual components** (line-chart) are AUTOMATICALLY added to the user's canvas
- **Input components** and **Action components** (buttons) appear in the answer box for user interaction
- When you create Display/Visual components, mention in your markdown that you've added them to the canvas and explain their purpose
- Example: "I've added a revenue chart to your canvas showing the monthly trends. This will help you track performance over time."

### COLLABORATIVE WORKFLOW
1. Break every request into clear sequential steps. Only tackle the current step in detail, then wait for confirmation before moving forward.
2. In every reply remind the user of the broader plan so they know how the current step fits into the end goal.
3. **IMPORTANT**: When you need to ask the user questions, USE INPUT NUGGTS instead of plain text questions!
   - Use \`input\` for text/email/password questions
   - Use \`date-picker\` or \`calendar\` for date questions  
   - Use \`time-picker\` for time questions
   - Always include a \`button\` with a descriptive prompt so the user can submit their answers
   - The button's prompt should describe what happens with the collected values using \`<id>\` references
4. Use markdown text to EXPLAIN why you're asking the questions, what you've added to the canvas, and to provide context.

### NUGGT DSL SYNTAX

#### TEXT QUOTING RULES
- Text values that contain special characters (commas, colons, parentheses, newlines) must be wrapped in quotes
- Use double quotes for simple text: \`title: "Hello, World"\`
- For newlines, use \\n inside the quotes: \`content: "Line 1\\nLine 2"\`
- All text fields support **Markdown formatting** - use **bold**, *italic*, lists, headers, etc.
- **DO NOT** include angle brackets < > in your text content - just use regular quotes

#### 1. DISPLAY COMPONENTS (Type 1)
All text fields render as Markdown. **IMPORTANT**: Every display component MUST include a \`highlight\` property.

**The \`highlight\` property** is a markdown explanation of:
- What this component shows and why you added it
- Any assumptions you made that the user should confirm
- Questions about potential changes or customizations
- Suggestions for improvements

This allows the user to walk through each component and understand your reasoning.

- **Text**: \`text: (content: "Your markdown content", highlight: "Your explanation here")\`
  - Example: \`text: (content: "## Overview\\n\\nKey metrics for your business.", highlight: "I added this overview section to introduce the dashboard. Would you like me to include more context about the data sources?")\`
- **Table**: \`table: (columns: ["Col1","Col2"], data: [...], caption: "Caption", highlight: "Explanation")\`
  - Example: \`table: (columns: ["Name","Status"], data: [{"Name":"Item 1","Status":"Active"}], highlight: "This table shows your active items. Should I add more columns like date or priority?")\`
- **Accordion**: \`accordion: (trigger: "Title", content: "Content", highlight: "Explanation")\`
- **Card**: \`card: (title: "Title", content: "Content", highlight: "Explanation")\`
  - Example: \`card: (title: "Revenue", content: "$12,500", highlight: "I'm showing total revenue here. Would you prefer to see this as a percentage change or include a comparison to last month?")\`
- **Alert**: \`alert: (title: "Title", description: "Description", highlight: "Explanation")\`
- **Image**: \`image: (src: "https://url-to-image.jpg", alt: "Description of image", caption: "Optional caption", rounded: none|sm|md|lg|xl|full, object-fit: cover|contain|fill|none, highlight: "Explanation")\`
  - The image will automatically fit the layout column it's placed in
  - Use \`rounded\` to control corner rounding (default: \`lg\`)
  - Use \`object-fit\` to control how the image fills its container (default: \`cover\`)
  - Example: \`image: (src: "https://example.com/chart.png", alt: "Sales chart", caption: "Q4 2024 Performance", highlight: "I added this chart image to visualize the data.")\`

#### 2. USER INPUT COMPONENTS (Type 2)
You MUST assign a unique ID at the end.
- **Input**: \`input: [(label: "Label Text", placeholder: "Placeholder text", type: text|email|password), myInputId]\`
- **Calendar**: \`calendar: [(mode: single), calendarId]\`
- **Range Calendar**: \`range-calendar: [(), rangeCalId]\`
- **Date Picker**: \`date-picker: [(label: "Select Date"), dateId]\`
- **Time Picker**: \`time-picker: [(label: "Select Time"), timeId]\`

#### 3. ACTION COMPONENTS (Type 3)
You MUST define a "prompt" action. Use \`<inputId>\` to reference input values.
- **Button**: \`button: [(label: "Button Text", variant: default|destructive|outline|secondary|ghost|link), prompt: Action with <inputId>]\`
- **Alert Dialog**: \`alert-dialog: [(trigger: "Open", title: "Confirm", description: "Are you sure?", cancel: "Cancel", action: "Confirm"), prompt: Confirmed action]\`

**Variable Resolution**: 
In the \`prompt:\`, reference Input IDs using angle brackets \`<id>\` - these are the ONLY place where angle brackets should be used.
Example: \`button: [(label: Submit, variant: default), prompt: Sending email to <emailId>]\`

#### 4. VISUAL COMPONENTS (Type 4)
- **Line Chart**: \`line-chart: [(data: JSON_Array, x-data: key, y-data: key|key2|key3, colour: #hex|#hex2|#hex3, title: "Chart Title", label_x: "X Label", label_y: "Y Label"), chartId]\`
  - **IMPORTANT**: The \`data\` prop must be a valid, minified JSON array string. 
  - Do NOT use single quotes inside the JSON. Use double quotes for keys and string values.
  - **MULTIPLE LINES**: Use pipe \`|\` to separate multiple y-data keys and their corresponding colors
  - Single line example: \`line-chart: [(data: [{"month":"Jan","val":10}, {"month":"Feb","val":20}], x-data: month, y-data: val, colour: #2563eb, title: "Monthly Trend"), chart1]\`
  - Multi-line example: \`line-chart: [(data: [{"month":"Jan","sales":100,"revenue":80}, {"month":"Feb","sales":150,"revenue":120}], x-data: month, y-data: sales|revenue, colour: #2563eb|#10b981, title: "Sales vs Revenue"), chart1]\`

#### 5. LAYOUT SYSTEM
Arrange components in a grid.
Syntax: \`[<total_columns>]: { [<span_cols>]: <nuggt>, ... }\`

- **Examples**:
  - 2 Columns equal: \`[2]: { card: (...), card: (...) }\`
  - Spanning: \`[3]: { [2]: card: (...), [1]: button: (...) }\`
  - Row Span: \`[3]: { [2]: continue, [1]: alert: (...) }\` (Uses 'continue' to fill space from row above, must be the same number of columns as the previous nuggt's column that you want to continue)
  - Space: \`[3]: { [1]: space, [2]: card: (...) }\`

### INTERACTION EXAMPLES

**Example 1: Asking questions with Input Nuggts**
User: "Help me plan a marketing campaign"
Response:
[2]: { input: [(label: "Campaign Name", placeholder: "Enter campaign name", type: text), campaignName], input: [(label: "Target Audience", placeholder: "e.g. Young professionals", type: text), audience] }
[2]: { input: [(label: "Budget", placeholder: "Enter budget amount", type: text), budget], date-picker: [(label: "Launch Date"), launchDate] }
button: [(label: "Continue Planning", variant: default), prompt: Planning campaign <campaignName> for <audience> with budget <budget> launching on <launchDate>]

**Step 1 of 3: Campaign Basics**

I'll help you plan your marketing campaign step by step. First, let me gather some basic information.

Please fill in the details above and click "Continue Planning" when ready. In the next step, we'll work on the campaign channels and messaging strategy.

**Example 2: Showing results with Markdown in cards (with highlights)**
User: "Show me a sales dashboard with a chart"
Response:
alert: (title: "**Performance Alert**", description: "Sales are **trending up** by *15%* this week!", highlight: "I added this alert to immediately draw attention to the positive trend. Would you like me to change the threshold for when alerts appear?")
line-chart: [(data: [{"d":"Mon","v":100},{"d":"Tue","v":150},{"d":"Wed","v":120}], x-data: d, y-data: v, colour: #10b981, title: "Weekly Revenue"), chart1]
[2]: { card: (title: "**Total Revenue**", content: "$370", highlight: "This shows your total revenue for the week. Should I add a comparison to last week or show it as a percentage change?"), card: (title: "**Visitors**", content: "450 unique visitors", highlight: "Displaying unique visitor count. Would you prefer to see page views instead, or both metrics?") }

I've added your sales dashboard to the canvas. Click the **Explain** button to walk through each component and provide feedback.

**Example 3: Using text component for detailed content (with highlights)**
User: "Show me an analysis with a chart"
Response:
[2]: { text: (content: "## Sales Analysis\\n\\nThis quarter shows **strong growth**.", highlight: "I created this summary to provide context for the chart. Should I include more detailed breakdowns by region or product category?"), line-chart: [(data: [{"m":"Jan","v":100},{"m":"Feb","v":120},{"m":"Mar","v":150}], x-data: m, y-data: v, colour: #2563eb, title: "Quarterly Trend"), chart1] }

I've added an analysis view. Use the **Explain** button to review my assumptions and suggest changes.

**Example 4: Using table for structured data (with highlights)**
User: "Show me a list of recent invoices"
Response:
table: (columns: ["Invoice","Status","Method","Amount"], data: [{"Invoice":"INV001","Status":"Paid","Method":"Credit Card","Amount":"$250.00"},{"Invoice":"INV002","Status":"Pending","Method":"PayPal","Amount":"$150.00"}], caption: "Recent invoices", highlight: "I'm showing the most recent invoices with key details. Would you like me to add more columns like due date or customer name? Should I filter by status?")

I've added your invoice table. Click **Explain** to review and customize.

**Example 5: Mixed workflow with rich text (with highlights)**
User: (After submitting inputs) "Planning campaign Summer Sale for Young professionals with budget $5000 launching on 2024-06-01"
Response:
card: (title: "**Summer Sale Campaign**", content: "**Target:** Young professionals\\n**Budget:** $5,000\\n**Launch:** June 1, 2024", highlight: "This card summarizes your campaign details. I assumed a single target audience - should we segment this further by age group or interests?")
[3]: { card: (title: "Social Media", content: "*Instagram*, *TikTok*", highlight: "I chose Instagram and TikTok based on the young professional demographic. Would you like to add LinkedIn for B2B reach?"), card: (title: "Email", content: "Newsletter blast", highlight: "Planning a single newsletter blast. Should this be a drip campaign with multiple emails instead?"), card: (title: "Paid Ads", content: "Google and Meta", highlight: "Standard paid channels selected. What's your expected CPC budget split between these platforms?") }
input: [(label: "Primary Message", placeholder: "What is your main campaign message?", type: text), mainMessage]
button: [(label: "Finalize Campaign", variant: default), prompt: Finalizing campaign with message: <mainMessage>]

**Step 2 of 3: Campaign Channels**

I've added your campaign summary and channel strategy. Click **Explain** to walk through each component and provide feedback on my assumptions.

Now, what's the primary message you want to convey? Enter it above and click "Finalize Campaign".
`;

// Model ID to actual model name mapping
const MODEL_MAP: Record<string, { provider: 'anthropic' | 'google' | 'openai' | 'openrouter'; model: string }> = {
  'claude-opus-4.5': { provider: 'anthropic', model: 'claude-opus-4-5-20251101' },
  'claude-sonnet-4': { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
  'gemini-3-pro': { provider: 'google', model: 'gemini-3-pro-preview' },
  'gpt-5.1': { provider: 'openai', model: 'gpt-5.1' },
  'gpt-oss-20b': { provider: 'openrouter', model: 'openai/gpt-oss-20b' },
};

app.post('/api/chat', async (req, res) => {
  const { message, history, model: modelId = 'claude-opus-4.5' } = req.body;
  
  const modelConfig = MODEL_MAP[modelId] || MODEL_MAP['claude-opus-4.5'];
  const isAnthropic = modelConfig.provider === 'anthropic';
  const isOpenAI = modelConfig.provider === 'openai';
  const isOpenRouter = modelConfig.provider === 'openrouter';

  // Set up SSE headers for streaming progress
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    sendEvent({ type: 'progress', status: 'thinking', detail: 'Starting...' });
    
    // Prepare tools from MCP for all providers
    const mcpToolsForGemini = mcpManager.getToolsForGemini();
    const mcpToolsForClaude = mcpManager.getToolsForClaude();
    const mcpToolsForOpenAI = mcpManager.getToolsForOpenAI();
    
    if (isAnthropic) {
      // --- CLAUDE/ANTHROPIC PATH ---
      await handleClaudeRequest(res, sendEvent, message, history, modelConfig.model, mcpToolsForClaude);
    } else if (isOpenAI) {
      // --- OPENAI/GPT PATH ---
      await handleOpenAIRequest(res, sendEvent, message, history, modelConfig.model, mcpToolsForOpenAI);
    } else if (isOpenRouter) {
      // --- OPENROUTER PATH (GPT-OSS-20B, etc.) ---
      await handleOpenRouterRequest(res, sendEvent, message, history, modelConfig.model, mcpToolsForOpenAI);
    } else {
      // --- GEMINI/GOOGLE PATH ---
      await handleGeminiRequest(res, sendEvent, message, history, modelConfig.model, mcpToolsForGemini);
    }
  } catch (error: any) {
    console.error("Error in chat endpoint:", error);
    sendEvent({ type: 'error', error: error.message });
    res.end();
  }
});

// Handle Claude/Anthropic requests
async function handleClaudeRequest(
  res: express.Response,
  sendEvent: (data: any) => void,
  message: string,
  history: any[],
  model: string,
  tools: any[]
) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('Anthropic API key not configured');
  }
  
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  
  // Convert history to Claude format
  const messages: Anthropic.MessageParam[] = history.map((msg: any) => ({
    role: msg.role === 'system' ? 'assistant' : 'user',
    content: msg.content
  }));
  
  messages.push({
    role: 'user',
    content: message
  });
  
  let currentMessages = [...messages];
  let turns = 0;
  const MAX_TURNS = 5;
  let finalText = '';
  
  // Stream generation with tool use support
  while (turns < MAX_TURNS) {
    turns++;
    
    const stream = anthropic.messages.stream({
      model: model,
      max_tokens: 16000,
      system: SYSTEM_INSTRUCTION,
      messages: currentMessages,
      tools: tools.length > 0 ? tools : undefined,
    });
    
    let collectedText = '';
    let toolUseBlocks: any[] = [];
    let currentToolUse: any = null;
    
    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'thinking') {
          // Extended thinking started
        } else if (event.content_block.type === 'text') {
          // Text block started
        } else if (event.content_block.type === 'tool_use') {
          currentToolUse = {
            id: event.content_block.id,
            name: event.content_block.name,
            input: ''
          };
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'thinking_delta') {
          // Stream thinking
          sendEvent({ type: 'progress', status: 'thinking', detail: event.delta.thinking });
        } else if (event.delta.type === 'text_delta') {
          // Stream text
          collectedText += event.delta.text;
          sendEvent({ type: 'progress', status: 'generating', detail: collectedText });
        } else if (event.delta.type === 'input_json_delta') {
          // Accumulate tool input
          if (currentToolUse) {
            currentToolUse.input += event.delta.partial_json;
          }
        }
      } else if (event.type === 'content_block_stop') {
        if (currentToolUse) {
          try {
            currentToolUse.input = JSON.parse(currentToolUse.input || '{}');
          } catch {
            currentToolUse.input = {};
          }
          toolUseBlocks.push(currentToolUse);
          currentToolUse = null;
        }
      }
    }
    
    finalText = collectedText;
    
    // If no tool use, we're done
    if (toolUseBlocks.length === 0) {
      break;
    }
    
    // Process tool calls
    const assistantContent: any[] = [];
    if (collectedText) {
      assistantContent.push({ type: 'text', text: collectedText });
    }
    toolUseBlocks.forEach(tool => {
      assistantContent.push({
        type: 'tool_use',
        id: tool.id,
        name: tool.name,
        input: tool.input
      });
    });
    
    currentMessages.push({
      role: 'assistant',
      content: assistantContent
    });
    
    // Execute tools and get results
    const toolResults: any[] = [];
    for (const tool of toolUseBlocks) {
      console.log(`Calling tool: ${tool.name}`);
      sendEvent({ type: 'progress', status: 'tool', detail: `Calling ${tool.name}...` });
      
      try {
        const result = await mcpManager.callTool(tool.name, tool.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: typeof result === 'string' ? result : JSON.stringify(result)
        });
      } catch (err: any) {
        console.error(`Tool execution failed: ${err.message}`);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: `Error: ${err.message}`,
          is_error: true
        });
      }
    }
    
    currentMessages.push({
      role: 'user',
      content: toolResults
    });
  }
  
  sendEvent({ type: 'progress', status: 'complete', detail: 'Done!' });
  sendEvent({ type: 'result', text: finalText });
  res.end();
}

// Handle OpenAI/GPT requests
async function handleOpenAIRequest(
  res: express.Response,
  sendEvent: (data: any) => void,
  message: string,
  history: any[],
  model: string,
  tools: OpenAI.Chat.Completions.ChatCompletionTool[]
) {
  if (!OPENAI_API_KEY) {
    throw new Error('OpenAI API key not configured');
  }
  
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  
  // Convert history to OpenAI format
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_INSTRUCTION }
  ];
  
  for (const msg of history) {
    messages.push({
      role: msg.role === 'system' ? 'assistant' : 'user',
      content: msg.content
    });
  }
  
  messages.push({
    role: 'user',
    content: message
  });
  
  let currentMessages = [...messages];
  let turns = 0;
  const MAX_TURNS = 5;
  let finalText = '';
  
  // Stream generation with tool use support
  while (turns < MAX_TURNS) {
    turns++;
    
    const stream = await openai.chat.completions.create({
      model: model,
      messages: currentMessages,
      tools: tools.length > 0 ? tools : undefined,
      stream: true,
      reasoning_effort: 'high', // High reasoning for o3 model
    });
    
    let collectedText = '';
    let toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let currentToolCall: { id: string; name: string; arguments: string } | null = null;
    
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      
      if (delta?.content) {
        collectedText += delta.content;
        sendEvent({ type: 'progress', status: 'generating', detail: collectedText });
      }
      
      // Handle tool calls
      if (delta?.tool_calls) {
        for (const toolCallDelta of delta.tool_calls) {
          if (toolCallDelta.id) {
            // New tool call starting
            if (currentToolCall) {
              toolCalls.push(currentToolCall);
            }
            currentToolCall = {
              id: toolCallDelta.id,
              name: toolCallDelta.function?.name || '',
              arguments: toolCallDelta.function?.arguments || ''
            };
          } else if (currentToolCall) {
            // Continue accumulating arguments
            if (toolCallDelta.function?.name) {
              currentToolCall.name = toolCallDelta.function.name;
            }
            if (toolCallDelta.function?.arguments) {
              currentToolCall.arguments += toolCallDelta.function.arguments;
            }
          }
        }
      }
    }
    
    // Push final tool call if exists
    if (currentToolCall) {
      toolCalls.push(currentToolCall);
    }
    
    finalText = collectedText;
    
    // If no tool calls, we're done
    if (toolCalls.length === 0) {
      break;
    }
    
    // Add assistant message with tool calls
    const assistantMessage: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
      role: 'assistant',
      content: collectedText || null,
      tool_calls: toolCalls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: tc.arguments
        }
      }))
    };
    
    currentMessages.push(assistantMessage);
    
    // Execute tools and get results
    for (const toolCall of toolCalls) {
      console.log(`Calling tool: ${toolCall.name}`);
      sendEvent({ type: 'progress', status: 'tool', detail: `Calling ${toolCall.name}...` });
      
      let toolResult: string;
      try {
        const args = JSON.parse(toolCall.arguments || '{}');
        const result = await mcpManager.callTool(toolCall.name, args);
        toolResult = typeof result === 'string' ? result : JSON.stringify(result);
      } catch (err: any) {
        console.error(`Tool execution failed: ${err.message}`);
        toolResult = `Error: ${err.message}`;
      }
      
      currentMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: toolResult
      });
    }
  }
  
  sendEvent({ type: 'progress', status: 'complete', detail: 'Done!' });
  sendEvent({ type: 'result', text: finalText });
  res.end();
}

// ============================================================================
// PLANNER-CENTRIC MULTI-AGENT SYSTEM FOR OPENROUTER (Small Models)
// ============================================================================
// Architecture: Planner Agent is the central brain that orchestrates all other agents.
// 
// Agents:
// 1. USER AGENT - Formats messages to/from user
// 2. PLANNER AGENT - Central brain, decides what to do next (this file)
// 3. TOOL AGENT - Executes MCP tools, reports findings to Planner
// 4. EXTRACTOR AGENT - Extracts relevant data from tool results for UI
// 5. UI AGENT - Creates beautiful Nuggt DSL based on Planner instructions
//
// Flow: All agents report back to Planner. Planner decides next action.
// ============================================================================

// ============================================================================
// NEW ARCHITECTURE: Agent-Specific Persistent Contexts
// ============================================================================
// Each agent has its own conversation history that persists for the app lifetime.
// - Planner: Has tool descriptions, talks to user, receives summaries from agents
// - Tool Agent: Has raw data, returns summaries to Planner
// - UI Agent: Has generated DSL history, doesn't report back to Planner
// - No User Agent: Planner talks directly to user
// ============================================================================

// Message in an agent's conversation history
interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool_call' | 'tool_response' | 'planner_request' | 'agent_response';
  content: string;
  timestamp: Date;
  metadata?: any;
}

// Persistent context for each agent (lives for app lifetime)
interface PlannerContext {
  conversationHistory: AgentMessage[];  // User ↔ Planner conversation
  toolDescriptions: string;  // Full tool descriptions for reference
}

interface ToolAgentContext {
  conversationHistory: AgentMessage[];  // Planner requests, tool calls, raw responses
  rawDataStore: Map<string, any>;  // Store raw data by key for later reference
}

interface UIAgentContext {
  conversationHistory: AgentMessage[];  // Planner requests, generated DSL
  generatedDSL: string[];  // All DSL generated in this session
}

// Variable store - shared between Tool Agent and UI Agent
// Planner can only see variable names and descriptions, not values
interface StoredVariable {
  name: string;
  description: string;
  value: any;  // Only Tool Agent and UI Agent can see this
  createdAt: Date;
  createdBy: string;  // Which tool/sub-tool created it
}

// Global variable store
const variableStore: Map<string, StoredVariable> = new Map();

// Global persistent contexts (live for app lifetime)
let plannerContext: PlannerContext = {
  conversationHistory: [],
  toolDescriptions: ''
};

let toolAgentContext: ToolAgentContext = {
  conversationHistory: [],
  rawDataStore: new Map()
};

let uiAgentContext: UIAgentContext = {
  conversationHistory: [],
  generatedDSL: []
};

// Reset function is defined after all contexts are declared
// See resetAllAgentContexts() below

// Actions the Planner can take
type PlannerAction = 
  | { type: 'CALL_TOOL'; toolName: string; purpose: string; lookingFor: string }  // Natural language, no args
  | { type: 'CREATE_UI'; component: string; instruction: string; variables?: string[] }  // Specific component + variables
  | { type: 'RESPOND_TO_USER'; message: string; waitForReply: boolean }
  | { type: 'DONE' };

// Runtime state for current request
interface RequestState {
  model: string;
  tools: OpenAI.Chat.Completions.ChatCompletionTool[];
  currentStep: number;
  maxSteps: number;
  isComplete: boolean;
  finalDSL: string[];
  finalMessage: string;
  useSubTools: boolean;  // Whether we're using learned sub-tools
}

// Helper to send debug events with proper format
function sendDebugEvent(
  sendEvent: (data: any) => void,
  agent: string,
  action: string,
  step: number,
  details: Record<string, any> = {}
) {
  sendEvent({
    type: 'debug',
    agent: agent.toUpperCase(),
    action,
    step,
    details
  });
}

// Process Tool Agent's analysis response and store variables
// Returns a summary string for the Planner
function processToolAgentResponse(
  analysisContent: string,
  rawData: any,
  toolName: string,
  sendEvent: (data: any) => void,
  step: number
): string {
  try {
    // Parse the JSON response
    const jsonMatch = analysisContent.match(/```json\s*([\s\S]*?)\s*```/) || 
                      analysisContent.match(/\{[\s\S]*"variables"[\s\S]*\}/);
    
    if (!jsonMatch) {
      // Fallback: treat as plain text summary
      console.log('[ToolAgent] Could not parse JSON response, using as plain text');
      return analysisContent;
    }
    
    const jsonStr = jsonMatch[1] || jsonMatch[0];
    const analysis = JSON.parse(jsonStr);
    
    // Store variables if specified
    const createdVars: string[] = [];
    if (analysis.variables && Array.isArray(analysis.variables)) {
      for (const varDef of analysis.variables) {
        const varName = varDef.name;
        const varDesc = varDef.description;
        const dataKey = varDef.dataKey || 'all';
        
        // Determine what data to store
        let dataToStore: any;
        if (dataKey === 'all') {
          dataToStore = rawData;
        } else if (dataKey === 'first_item' && Array.isArray(rawData)) {
          dataToStore = rawData[0];
        } else if (dataKey === 'filtered' && Array.isArray(rawData)) {
          dataToStore = rawData; // Could add filtering logic
        } else {
          dataToStore = rawData;
        }
        
        // Store the variable
        variableStore.set(varName, {
          name: varName,
          description: varDesc,
          value: dataToStore,
          createdAt: new Date(),
          createdBy: toolName
        });
        
        createdVars.push(varName);
        
        // Send debug event for variable creation
        sendDebugEvent(sendEvent, 'tool', 'VARIABLE_CREATED', step, {
          variableName: varName,
          description: varDesc,
          dataType: Array.isArray(dataToStore) ? `array(${dataToStore.length})` : typeof dataToStore
        });
      }
    }
    
    // Build summary for Planner
    let summary = '';
    if (analysis.found === false) {
      summary = `**Found:** No\n**Summary:** ${analysis.summary || 'No data found'}\n`;
    } else {
      summary = `**Found:** Yes\n**Summary:** ${analysis.summary}\n`;
    }
    
    if (createdVars.length > 0) {
      summary += `**Variables Created:**\n`;
      for (const varDef of analysis.variables) {
        summary += `- \`${varDef.name}\`: ${varDef.description}\n`;
      }
    }
    
    if (analysis.recommendation) {
      summary += `**Recommendation:** ${analysis.recommendation}`;
    }
    
    return summary;
    
  } catch (e) {
    console.error('[ToolAgent] Error processing analysis response:', e);
    // Return original content as fallback
    return analysisContent;
  }
}

// ============================================================================
// HELPER: Build tool descriptions for Planner
// ============================================================================
function buildToolDescriptions(tools: OpenAI.Chat.Completions.ChatCompletionTool[]): string {
  if (tools.length === 0) return '(No tools available)';
  
  return tools.slice(0, 50).map(t => {
    const toolAny = t as any;
    const funcDef = toolAny.function || toolAny;
    const params = funcDef.parameters as any;
    
    let paramInfo = '';
    if (params?.properties) {
      const required = params.required || [];
      const paramList = Object.entries(params.properties).map(([name, schema]: [string, any]) => {
        const isRequired = required.includes(name);
        const type = schema.type || 'any';
        const desc = schema.description ? ` - ${schema.description.slice(0, 50)}` : '';
        return `  - ${name}${isRequired ? ' (REQUIRED)' : ''}: ${type}${desc}`;
      });
      paramInfo = '\n' + paramList.join('\n');
    }
    
    return `**${funcDef.name}**\n${(funcDef.description || 'No description').slice(0, 200)}${paramInfo}`;
  }).join('\n\n');
}

// ============================================================================
// PLANNER AGENT
// ============================================================================
// The Planner is the central brain. It:
// - Receives user messages directly
// - Has full tool descriptions (but NOT raw data)
// - Decides what action to take
// - Receives summaries from Tool Agent and UI Agent
// - Responds directly to user
// ============================================================================

const PLANNER_PROMPT = `You are the PLANNER - the central coordinator of a multi-agent system.

## YOUR ROLE
Coordinate agents to fetch data and create UI components ONE AT A TIME.

## VARIABLE SYSTEM
- Tool Agent stores data in VARIABLES
- You see variable NAMES and DESCRIPTIONS only
- Pass variable names to UI Agent

## AVAILABLE ACTIONS

### CALL_TOOL
\`\`\`json
{"action": "CALL_TOOL", "toolName": "tool_name", "purpose": "what to do", "lookingFor": "expected data"}
\`\`\`

### CREATE_UI - Choose ONE component type
\`\`\`json
{"action": "CREATE_UI", "component": "table", "instruction": "what to show", "variables": ["var_name"]}
\`\`\`
**REQUIRED**: You MUST specify "component" - choose from the list below.

### RESPOND_TO_USER
\`\`\`json
{"action": "RESPOND_TO_USER", "message": "your message", "waitForReply": true}
\`\`\`

### DONE
\`\`\`json
{"action": "DONE"}
\`\`\`

## UI COMPONENTS (choose one for CREATE_UI)
{AVAILABLE_COMPONENTS}

## RULES
1. CREATE_UI: Always specify "component" type
2. ONE component per CREATE_UI call
3. Be specific in instruction
4. Can call CREATE_UI multiple times

## AVAILABLE VARIABLES
{AVAILABLE_VARIABLES}

## AVAILABLE TOOLS
{TOOL_DESCRIPTIONS}

## CONVERSATION HISTORY
{CONVERSATION_HISTORY}

Respond with ONLY a JSON object.`;

async function runPlannerAgent(
  userMessage: string,
  agentResponse: string | null,  // Response from Tool/UI Agent, null if first call
  state: RequestState,
  sendEvent: (data: any) => void
): Promise<PlannerAction> {
  const client = createOpenRouterClient();
  
  // Build conversation history string from planner context
  let historyStr = '';
  for (const msg of plannerContext.conversationHistory.slice(-20)) {
    const label = msg.role === 'user' ? 'USER' : 
                  msg.role === 'assistant' ? 'PLANNER' :
                  msg.role === 'agent_response' ? 'AGENT_RESPONSE' : msg.role.toUpperCase();
    historyStr += `[${label}]: ${msg.content}\n\n`;
  }
  
  // Add current message to context
  if (userMessage && !agentResponse) {
    plannerContext.conversationHistory.push({
      role: 'user',
      content: userMessage,
      timestamp: new Date()
    });
    historyStr += `[USER]: ${userMessage}\n\n`;
  }
  
  if (agentResponse) {
    plannerContext.conversationHistory.push({
      role: 'agent_response',
      content: agentResponse,
      timestamp: new Date()
    });
    historyStr += `[AGENT_RESPONSE]: ${agentResponse}\n\n`;
  }
  
  // Build available variables string for Planner
  let availableVarsStr = '';
  if (variableStore.size > 0) {
    for (const [name, variable] of variableStore) {
      availableVarsStr += `- **${name}**: ${variable.description} (created by ${variable.createdBy})\n`;
    }
  } else {
    availableVarsStr = '(No variables stored yet - call CALL_TOOL first to create variables)';
  }
  
  // Build available UI components string
  const availableComponentsStr = AVAILABLE_COMPONENTS.map(c => 
    `- **${c.type}**: ${c.description}`
  ).join('\n');
  
  // Build prompt
  const prompt = PLANNER_PROMPT
    .replace('{TOOL_DESCRIPTIONS}', plannerContext.toolDescriptions || '(Loading...)')
    .replace('{CONVERSATION_HISTORY}', historyStr || '(Start of conversation)')
    .replace('{AVAILABLE_VARIABLES}', availableVarsStr)
    .replace('{AVAILABLE_COMPONENTS}', availableComponentsStr);
  
  sendDebugEvent(sendEvent, 'planner', 'THINKING', state.currentStep, {
    message: 'Analyzing situation...',
    historyLength: plannerContext.conversationHistory.length
  });
  
  try {
    const response = await client.chat.completions.create({
      model: state.model,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: agentResponse ? `Agent response: ${agentResponse}\n\nWhat's your next action?` : `User request: ${userMessage}\n\nWhat's your next action?` }
      ],
      temperature: 0.3,
      max_tokens: 1000
    });
    
    const content = response.choices[0]?.message?.content || '';
    
    // Store planner response
    plannerContext.conversationHistory.push({
      role: 'assistant',
      content: content,
      timestamp: new Date()
    });
    
    // Parse JSON action
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      sendDebugEvent(sendEvent, 'planner', 'ERROR', state.currentStep, {
        error: 'No JSON action found',
        rawResponse: content.slice(0, 200)
      });
      return { type: 'RESPOND_TO_USER', message: content, waitForReply: false };
    }
    
    const parsed = JSON.parse(jsonMatch[0]);
    const action = parsed.action?.toUpperCase() || parsed.type?.toUpperCase();
    
    sendDebugEvent(sendEvent, 'planner', 'DECIDED', state.currentStep, {
      action,
      reasoning: content.slice(0, 150)
    });
    
    switch (action) {
      case 'CALL_TOOL':
        return {
          type: 'CALL_TOOL',
          toolName: parsed.toolName || parsed.tool_name,
          purpose: parsed.purpose || '',
          lookingFor: parsed.lookingFor || parsed.looking_for || parsed.expectedResponse || parsed.expected_response || ''
        };
      case 'CREATE_UI':
        return {
          type: 'CREATE_UI',
          component: parsed.component || 'card',  // Default to card if not specified
          instruction: parsed.instruction || parsed.instructions || '',
          variables: parsed.variables || []
        };
      case 'RESPOND_TO_USER':
        return {
          type: 'RESPOND_TO_USER',
          message: parsed.message || '',
          waitForReply: parsed.waitForReply ?? parsed.wait_for_reply ?? false
        };
      case 'DONE':
        return { type: 'DONE' };
      default:
        return { type: 'RESPOND_TO_USER', message: content, waitForReply: false };
    }
  } catch (error: any) {
    console.error('[Planner] Error:', error);
    sendDebugEvent(sendEvent, 'planner', 'ERROR', state.currentStep, {
      error: error.message
    });
    return { type: 'RESPOND_TO_USER', message: `I encountered an error: ${error.message}`, waitForReply: false };
  }
}

// ============================================================================
// TOOL AGENT
// ============================================================================
// The Tool Agent:
// - Receives natural language instructions from Planner
// - Figures out the correct arguments based on tool schema (or sub-tool docs)
// - Makes the tool call (or sub-tool call with automatic JSONPath extraction)
// - Stores raw data in its context
// - Returns a SUMMARY to Planner (not raw data)
// ============================================================================

// Sub-tool specific prompt - uses full sub-tool documentation
const SUBTOOL_ARGS_PROMPT = `You are the TOOL AGENT working with LEARNED SUB-TOOLS.

## THE PLANNER'S REQUEST
Sub-tool to call: {TOOL_NAME}
Purpose: {PURPOSE}
Looking for: {LOOKING_FOR}

## COMPLETE SUB-TOOL DOCUMENTATION
{SUBTOOL_DOCS}

## YOUR CONVERSATION HISTORY
{CONVERSATION_HISTORY}

## DATA FROM PREVIOUS SUB-TOOL CALLS
Use values from here (like property_id, account_id) as arguments for this sub-tool:
{PREVIOUS_RAW_DATA}

## YOUR TASK
Determine the correct arguments for this sub-tool call.

RULES:
1. If no inputs are required, return: {}
2. **FIND IDs AND VALUES** from previous calls - these are often needed as arguments!
3. Match input names exactly as specified in the sub-tool documentation
4. Check "requiresFirst" - if this sub-tool needs data from another sub-tool, make sure you have it
5. For enum inputs, use one of the valid values listed
6. For date inputs, use the specified format (e.g., "30daysAgo", "yesterday", "YYYY-MM-DD")

EXAMPLES:
- If sub-tool needs "property_id" and previous data has properties, use the relevant property_id
- If no arguments: {}
- If missing required data: explain what's needed

Respond with ONLY a valid JSON object for the arguments, or explain what's missing.`;

// Sub-tool analysis prompt - now creates variables
const SUBTOOL_ANALYSIS_PROMPT = `You are the TOOL AGENT. Your job is to:
1. Analyze the data from the sub-tool call
2. Create VARIABLES to store the useful data
3. Report back to the Planner what variables you created

## THE PLANNER'S REQUEST
Sub-tool: {TOOL_NAME}
Purpose: {PURPOSE}
Looking for: {LOOKING_FOR}

## ARGUMENTS USED
{ARGS_USED}

## EXTRACTED DATA
{EXTRACTED_DATA}

## YOUR TASK
1. Identify what useful data is in the response
2. Create variables with descriptive names based on what the Planner is looking for
3. Report what variables you created

## RESPONSE FORMAT
You MUST respond with this exact JSON format:
\`\`\`json
{
  "found": true/false,
  "summary": "Brief description of what was found",
  "variables": [
    {
      "name": "descriptive_variable_name",
      "description": "What this variable contains (for Planner to understand)",
      "dataKey": "which part of the data to store (e.g., 'all', 'filtered', 'first_item')"
    }
  ],
  "recommendation": "What the Planner should do next"
}
\`\`\`

## VARIABLE NAMING GUIDELINES
- Use snake_case: property_list, traffic_data, user_info
- Be specific: ga_properties, monthly_revenue, top_pages
- Based on what Planner asked for: if looking for "property IDs", name it "properties" or "property_list"

## EXAMPLES
If Planner asked for "list of properties" and data has 5 properties:
{
  "found": true,
  "summary": "Found 5 GA4 properties",
  "variables": [
    { "name": "ga_properties", "description": "List of 5 GA4 properties with IDs, names, and types", "dataKey": "all" }
  ],
  "recommendation": "Can now create UI to display properties or select one for detailed analysis"
}

If data has multiple useful parts:
{
  "found": true,
  "summary": "Found traffic report with sources and metrics",
  "variables": [
    { "name": "traffic_sources", "description": "Top 10 traffic sources with sessions and users", "dataKey": "all" },
    { "name": "top_source", "description": "The highest traffic source (Google/organic)", "dataKey": "first_item" }
  ],
  "recommendation": "Ready to create traffic analysis UI"
}

ALWAYS respond with valid JSON in the format above.`;

// Prompt to figure out tool arguments
const TOOL_ARGS_PROMPT = `You are the TOOL AGENT. Your job is to figure out the correct arguments for a tool call.

## THE PLANNER'S REQUEST
Tool to call: {TOOL_NAME}
Purpose: {PURPOSE}
Looking for: {LOOKING_FOR}

## TOOL SCHEMA
{TOOL_SCHEMA}

## YOUR CONVERSATION HISTORY (summaries of past interactions)
{CONVERSATION_HISTORY}

## AVAILABLE DATA FROM PREVIOUS TOOL CALLS
These are the raw responses from previous tool calls. Use IDs, names, or other values from here as arguments.
{PREVIOUS_RAW_DATA}

## YOUR TASK
Based on the Planner's request, tool schema, and available data, determine the correct arguments to pass to this tool.

IMPORTANT RULES:
1. If the tool requires no arguments, return: {}
2. **LOOK FOR IDs AND VALUES** in the "AVAILABLE DATA" section above - use them as arguments!
3. If you have all required information from previous data, return the arguments as JSON
4. If you're missing required information that you cannot find in the available data, explain what's missing
5. Common pattern: First call lists items (gets IDs), second call uses those IDs

EXAMPLES:
- If previous data has accounts with IDs, use the relevant one
- If no arguments needed: {}

Respond with ONLY a valid JSON object for the arguments, or explain what's missing.`;

// Prompt to analyze tool results - now creates variables
const TOOL_ANALYSIS_PROMPT = `You are the TOOL AGENT. Your job is to:
1. Analyze the data from the tool call
2. Create VARIABLES to store the useful data
3. Report back to the Planner what variables you created

## THE PLANNER'S REQUEST
Tool: {TOOL_NAME}
Purpose: {PURPOSE}
Looking for: {LOOKING_FOR}

## ARGUMENTS USED
{ARGS_USED}

## RAW TOOL RESULT
{RAW_RESULT}

## YOUR TASK
1. Identify what useful data is in the response
2. Create variables with descriptive names based on what the Planner is looking for
3. Report what variables you created

## RESPONSE FORMAT
You MUST respond with this exact JSON format:
\`\`\`json
{
  "found": true/false,
  "summary": "Brief description of what was found",
  "variables": [
    {
      "name": "descriptive_variable_name",
      "description": "What this variable contains (for Planner to understand)",
      "dataKey": "which part of the data to store (e.g., 'all', 'filtered', 'first_item')"
    }
  ],
  "recommendation": "What the Planner should do next"
}
\`\`\`

## VARIABLE NAMING GUIDELINES
- Use snake_case: property_list, traffic_data, user_info
- Be specific: ga_properties, monthly_revenue, top_pages
- Based on what Planner asked for

ALWAYS respond with valid JSON in the format above.`;

// Get tool schema for a specific tool
function getToolSchema(toolName: string, tools: OpenAI.Chat.Completions.ChatCompletionTool[]): string {
  const tool = tools.find(t => {
    const toolAny = t as any;
    const funcDef = toolAny.function || toolAny;
    return funcDef.name === toolName;
  });
  
  if (!tool) return '(Tool not found)';
  
  const toolAny = tool as any;
  const funcDef = toolAny.function || toolAny;
  
  return JSON.stringify({
    name: funcDef.name,
    description: funcDef.description,
    parameters: funcDef.parameters
  }, null, 2);
}

async function runToolAgent(
  action: { toolName: string; purpose: string; lookingFor: string },
  state: RequestState,
  sendEvent: (data: any) => void
): Promise<string> {
  const client = createOpenRouterClient();
  
  // Log the request in Tool Agent's context
  toolAgentContext.conversationHistory.push({
    role: 'planner_request',
    content: `Call tool "${action.toolName}". Purpose: ${action.purpose}. Looking for: ${action.lookingFor}`,
    timestamp: new Date()
  });
  
  // Check if this is a sub-tool call
  const subTool = state.useSubTools ? findSubTool(action.toolName) : undefined;
  const isSubTool = !!subTool;
  
  sendDebugEvent(sendEvent, 'tool', 'THINKING', state.currentStep, {
    toolName: action.toolName,
    isSubTool,
    purpose: action.purpose,
    lookingFor: action.lookingFor
  });
  sendEvent({ type: 'progress', status: 'tool', detail: `Figuring out ${action.toolName} arguments...` });
  
  try {
    // Build conversation history for context (summaries only)
    let historyStr = '';
    for (const msg of toolAgentContext.conversationHistory.slice(-15)) {
      if (msg.role === 'planner_request' || msg.role === 'agent_response' || msg.role === 'tool_call') {
        historyStr += `[${msg.role}]: ${msg.content.slice(0, 300)}\n\n`;
      }
    }
    
    // Build previous raw data section - include actual data so Tool Agent can find IDs
    let previousRawData = '';
    const storedKeys = Array.from(toolAgentContext.rawDataStore.keys());
    if (storedKeys.length > 0) {
      for (const key of storedKeys.slice(-5)) { // Last 5 stored results
        if (key === 'extracted_data') continue; // Skip extracted data
        const data = toolAgentContext.rawDataStore.get(key);
        if (data) {
          const dataStr = JSON.stringify(data, null, 2);
          previousRawData += `### ${key}\n\`\`\`json\n${dataStr.slice(0, 3000)}\n\`\`\`\n\n`;
        }
      }
    }
    if (!previousRawData) {
      previousRawData = '(No previous tool calls yet)';
    }
    
    let argsPrompt: string;
    let toolArgs: Record<string, any> = {};
    
    // ======================================================================
    // SUB-TOOL PATH: Use learned sub-tool documentation
    // ======================================================================
    if (isSubTool && subTool) {
      console.log(`[ToolAgent] Using SUB-TOOL: ${subTool.name} (parent: ${subTool.parentTool})`);
      
      // Build sub-tool documentation for the LLM
      let subToolDocs = `**${subTool.name}** (ID: ${subTool.id})\n`;
      subToolDocs += `Description: ${subTool.description}\n`;
      subToolDocs += `Parent MCP Tool: ${subTool.parentTool}\n\n`;
      
      if (subTool.requiresFirst && subTool.requiresFirst.length > 0) {
        subToolDocs += '**Dependencies:**\n';
        for (const dep of subTool.requiresFirst) {
          subToolDocs += `- Must call "${dep.subTool}" first to get "${dep.extractField}"\n`;
        }
        subToolDocs += '\n';
      }
      
      if (subTool.inputs.length > 0) {
        subToolDocs += '**Inputs:**\n';
        for (const inp of subTool.inputs) {
          const req = inp.required ? '(REQUIRED)' : '(optional)';
          subToolDocs += `- ${inp.name} ${req}: ${inp.description}\n`;
          if (inp.type === 'enum' && inp.options) {
            subToolDocs += '  Valid values: ' + inp.options.slice(0, 10).map(o => `"${o.value}"`).join(', ');
            if (inp.options.length > 10) subToolDocs += ` ... and ${inp.options.length - 10} more`;
            subToolDocs += '\n';
          }
          if (inp.format) {
            subToolDocs += `  Format: ${inp.format}\n`;
          }
          if (inp.default !== undefined) {
            subToolDocs += `  Default: ${inp.default}\n`;
          }
        }
      } else {
        subToolDocs += '**Inputs:** None required\n';
      }
      
      if (subTool.outputFields && subTool.outputFields.length > 0) {
        subToolDocs += '\n**Returns:**\n';
        for (const field of subTool.outputFields) {
          subToolDocs += `- ${field.name}: ${field.description}\n`;
        }
      }
      
      argsPrompt = SUBTOOL_ARGS_PROMPT
        .replace('{TOOL_NAME}', subTool.name)
        .replace('{PURPOSE}', action.purpose)
        .replace('{LOOKING_FOR}', action.lookingFor)
        .replace('{SUBTOOL_DOCS}', subToolDocs)
        .replace('{CONVERSATION_HISTORY}', historyStr || '(No previous context)')
        .replace('{PREVIOUS_RAW_DATA}', previousRawData);
      
      console.log('\n╔══════════════════════════════════════════════════════════════════════════════');
      console.log('║ TOOL AGENT - SUBTOOL ARGS PROMPT');
      console.log('╠══════════════════════════════════════════════════════════════════════════════');
      console.log(argsPrompt);
      console.log('╚══════════════════════════════════════════════════════════════════════════════\n');
      
      const argsResponse = await client.chat.completions.create({
        model: state.model,
        messages: [{ role: 'user', content: argsPrompt }],
        temperature: 0.1,
        max_tokens: 500
      });
      
      const argsContent = argsResponse.choices[0]?.message?.content || '{}';
      
      // Try to parse the arguments
      try {
        const jsonMatch = argsContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          toolArgs = JSON.parse(jsonMatch[0]);
        }
      } catch (e) {
        sendDebugEvent(sendEvent, 'tool', 'NEEDS_INFO', state.currentStep, {
          toolName: action.toolName,
          response: argsContent.slice(0, 200)
        });
        return `**Found:** No\n**Summary:** Cannot determine sub-tool arguments.\n**Details:** ${argsContent}\n**Recommendation:** Please provide the missing information.`;
      }
      
      sendDebugEvent(sendEvent, 'tool', 'CALLING_SUBTOOL', state.currentStep, {
        subTool: subTool.name,
        parentTool: subTool.parentTool,
        args: toolArgs
      });
      sendEvent({ type: 'progress', status: 'tool', detail: `Calling sub-tool ${subTool.name}...` });
      
      console.log('\n╔══════════════════════════════════════════════════════════════════════════════');
      console.log('║ SUBTOOL CALL - EXECUTING');
      console.log('╠══════════════════════════════════════════════════════════════════════════════');
      console.log(`║ Sub-tool: ${subTool.name}`);
      console.log(`║ Parent Tool: ${subTool.parentTool}`);
      console.log(`║ Arguments: ${JSON.stringify(toolArgs, null, 2)}`);
      console.log(`║ JSONPath: ${subTool.jsonPath}`);
      console.log('╚══════════════════════════════════════════════════════════════════════════════\n');
      
      // Execute sub-tool (handles parent tool call + JSONPath extraction)
      const subToolResult = await executeSubTool(subTool.id, toolArgs);
      
      if (!subToolResult.success) {
        sendDebugEvent(sendEvent, 'tool', 'FAILED', state.currentStep, {
          toolName: action.toolName,
          error: subToolResult.error
        });
        return `**Found:** No\n**Error:** ${subToolResult.error}\n**Recommendation:** Try a different approach or ask user for clarification.`;
      }
      
      // Store the EXTRACTED data (not full raw response)
      // Handle case where JSONPath extraction returns undefined
      const extractedData = subToolResult.data;
      if (extractedData === undefined || extractedData === null) {
        console.log(`[SubTool] WARNING: JSONPath extraction returned undefined/null`);
        console.log(`[SubTool] JSONPath was: ${subTool.jsonPath}`);
        console.log(`[SubTool] Raw response was:`, JSON.stringify(subToolResult.rawResponse, null, 2).slice(0, 1000));
        
        // Fall back to raw response if extraction failed
        const fallbackData = subToolResult.rawResponse || { message: 'No data returned' };
        const extractedDataStr = JSON.stringify(fallbackData, null, 2);
        toolAgentContext.rawDataStore.set('latest_tool_result', fallbackData);
        toolAgentContext.rawDataStore.set(`${subTool.id}_result`, fallbackData);
        
        // Continue with analysis using raw data
        sendDebugEvent(sendEvent, 'tool', 'EXTRACTION_FALLBACK', state.currentStep, {
          subTool: subTool.name,
          reason: 'JSONPath returned undefined, using raw response',
          rawPreview: extractedDataStr.slice(0, 200)
        });
        
        // Log for history
        toolAgentContext.conversationHistory.push({
          role: 'tool_call',
          content: `Called sub-tool ${subTool.name} with ${JSON.stringify(toolArgs)} (extraction fallback to raw)`,
          timestamp: new Date(),
          metadata: { subTool: subTool.id, args: toolArgs, parentTool: subTool.parentTool }
        });
        
        toolAgentContext.conversationHistory.push({
          role: 'tool_response',
          content: extractedDataStr.slice(0, 5000),
          timestamp: new Date(),
          metadata: { subTool: subTool.id, fullDataKey: 'latest_tool_result', fallback: true }
        });
        
        // Analyze the raw data instead
        const analysisPrompt = SUBTOOL_ANALYSIS_PROMPT
          .replace('{TOOL_NAME}', subTool.name)
          .replace('{PURPOSE}', action.purpose)
          .replace('{LOOKING_FOR}', action.lookingFor)
          .replace('{ARGS_USED}', JSON.stringify(toolArgs))
          .replace('{EXTRACTED_DATA}', `(JSONPath extraction failed, showing raw response)\n${extractedDataStr.slice(0, 10000)}`);
        
        const analysisResponse = await client.chat.completions.create({
          model: state.model,
          messages: [{ role: 'user', content: analysisPrompt }],
          temperature: 0.2,
          max_tokens: 1000
        });
        
        const analysisContent = analysisResponse.choices[0]?.message?.content || '';
        const summary = processToolAgentResponse(analysisContent, fallbackData, subTool.name, sendEvent, state.currentStep);
        
        toolAgentContext.conversationHistory.push({
          role: 'agent_response',
          content: summary,
          timestamp: new Date()
        });
        
        sendDebugEvent(sendEvent, 'tool', 'COMPLETE', state.currentStep, {
          toolName: subTool.name,
          summary: summary.slice(0, 300),
          fallback: true,
          variablesCreated: Array.from(variableStore.keys())
        });
        
        return summary;
      }
      
      const extractedDataStr = JSON.stringify(extractedData, null, 2);
      toolAgentContext.rawDataStore.set('latest_tool_result', extractedData);
      toolAgentContext.rawDataStore.set(`${subTool.id}_result`, extractedData);
      
      // Log the call
      toolAgentContext.conversationHistory.push({
        role: 'tool_call',
        content: `Called sub-tool ${subTool.name} with ${JSON.stringify(toolArgs)}`,
        timestamp: new Date(),
        metadata: { subTool: subTool.id, args: toolArgs, parentTool: subTool.parentTool }
      });
      
      toolAgentContext.conversationHistory.push({
        role: 'tool_response',
        content: extractedDataStr.slice(0, 5000),
        timestamp: new Date(),
        metadata: { subTool: subTool.id, fullDataKey: 'latest_tool_result' }
      });
      
      sendDebugEvent(sendEvent, 'tool', 'SUCCESS', state.currentStep, {
        subTool: subTool.name,
        extractedRecords: Array.isArray(extractedData) ? extractedData.length : 1,
        resultPreview: extractedDataStr.slice(0, 200)
      });
      
      // Analyze the extracted data and create variables
      const analysisPrompt = SUBTOOL_ANALYSIS_PROMPT
        .replace('{TOOL_NAME}', subTool.name)
        .replace('{PURPOSE}', action.purpose)
        .replace('{LOOKING_FOR}', action.lookingFor)
        .replace('{ARGS_USED}', JSON.stringify(toolArgs))
        .replace('{EXTRACTED_DATA}', extractedDataStr.slice(0, 10000));
      
      const analysisResponse = await client.chat.completions.create({
        model: state.model,
        messages: [{ role: 'user', content: analysisPrompt }],
        temperature: 0.2,
        max_tokens: 1000
      });
      
      const analysisContent = analysisResponse.choices[0]?.message?.content || '';
      const summary = processToolAgentResponse(analysisContent, extractedData, subTool.name, sendEvent, state.currentStep);
      
      toolAgentContext.conversationHistory.push({
        role: 'agent_response',
        content: summary,
        timestamp: new Date()
      });
      
      sendDebugEvent(sendEvent, 'tool', 'COMPLETE', state.currentStep, {
        toolName: subTool.name,
        summary: summary.slice(0, 300),
        variablesCreated: Array.from(variableStore.keys())
      });
      
      return summary;
      
    } else {
      // ======================================================================
      // ORIGINAL TOOL PATH: Use original MCP tool schema
      // ======================================================================
      const toolSchema = getToolSchema(action.toolName, state.tools);
      
      argsPrompt = TOOL_ARGS_PROMPT
        .replace('{TOOL_NAME}', action.toolName)
        .replace('{PURPOSE}', action.purpose)
        .replace('{LOOKING_FOR}', action.lookingFor)
        .replace('{TOOL_SCHEMA}', toolSchema)
        .replace('{CONVERSATION_HISTORY}', historyStr || '(No previous context)')
        .replace('{PREVIOUS_RAW_DATA}', previousRawData);
      
      console.log('\n╔══════════════════════════════════════════════════════════════════════════════');
      console.log('║ TOOL AGENT - ARGS PROMPT (ORIGINAL MCP TOOL)');
      console.log('╠══════════════════════════════════════════════════════════════════════════════');
      console.log(argsPrompt);
      console.log('╚══════════════════════════════════════════════════════════════════════════════\n');
      
      const argsResponse = await client.chat.completions.create({
        model: state.model,
        messages: [{ role: 'user', content: argsPrompt }],
        temperature: 0.1,
        max_tokens: 500
      });
      
      const argsContent = argsResponse.choices[0]?.message?.content || '{}';
      
      try {
        const jsonMatch = argsContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          toolArgs = JSON.parse(jsonMatch[0]);
        }
      } catch (e) {
        sendDebugEvent(sendEvent, 'tool', 'NEEDS_INFO', state.currentStep, {
          toolName: action.toolName,
          response: argsContent.slice(0, 200)
        });
        return `**Found:** No\n**Summary:** Cannot determine tool arguments.\n**Details:** ${argsContent}\n**Recommendation:** Please provide the missing information.`;
      }
      
      sendDebugEvent(sendEvent, 'tool', 'CALLING', state.currentStep, {
        toolName: action.toolName,
        args: toolArgs
      });
      sendEvent({ type: 'progress', status: 'tool', detail: `Calling ${action.toolName}...` });
      
      console.log('\n╔══════════════════════════════════════════════════════════════════════════════');
      console.log('║ TOOL CALL - EXACT INPUT TO MCP TOOL');
      console.log('╠══════════════════════════════════════════════════════════════════════════════');
      console.log(`║ Tool Name: ${action.toolName}`);
      console.log(`║ Arguments: ${JSON.stringify(toolArgs, null, 2)}`);
      console.log('╚══════════════════════════════════════════════════════════════════════════════\n');
      
      const rawMcpResult = await mcpManager.callTool(action.toolName, toolArgs);
      
      // Unwrap MCP response format to get actual data
      const result = unwrapMCPResponse(rawMcpResult);
      
      const rawData = JSON.stringify(result, null, 2);
      toolAgentContext.rawDataStore.set('latest_tool_result', result);
      toolAgentContext.rawDataStore.set(`${action.toolName}_result`, result);
      
      toolAgentContext.conversationHistory.push({
        role: 'tool_call',
        content: `Called ${action.toolName} with ${JSON.stringify(toolArgs)}`,
        timestamp: new Date(),
        metadata: { toolName: action.toolName, args: toolArgs }
      });
      
      toolAgentContext.conversationHistory.push({
        role: 'tool_response',
        content: rawData.slice(0, 5000),
        timestamp: new Date(),
        metadata: { toolName: action.toolName, fullDataKey: 'latest_tool_result' }
      });
      
      sendDebugEvent(sendEvent, 'tool', 'SUCCESS', state.currentStep, {
        toolName: action.toolName,
        resultSize: rawData.length,
        resultPreview: rawData.slice(0, 200)
      });
      
      const analysisPrompt = TOOL_ANALYSIS_PROMPT
        .replace('{TOOL_NAME}', action.toolName)
        .replace('{PURPOSE}', action.purpose)
        .replace('{LOOKING_FOR}', action.lookingFor)
        .replace('{ARGS_USED}', JSON.stringify(toolArgs))
        .replace('{RAW_RESULT}', rawData.slice(0, 10000));
      
      const analysisResponse = await client.chat.completions.create({
        model: state.model,
        messages: [{ role: 'user', content: analysisPrompt }],
        temperature: 0.2,
        max_tokens: 1000
      });
      
      const analysisContent = analysisResponse.choices[0]?.message?.content || '';
      const summary = processToolAgentResponse(analysisContent, result, action.toolName, sendEvent, state.currentStep);
      
      toolAgentContext.conversationHistory.push({
        role: 'agent_response',
        content: summary,
        timestamp: new Date()
      });
      
      sendDebugEvent(sendEvent, 'tool', 'COMPLETE', state.currentStep, {
        toolName: action.toolName,
        summary: summary.slice(0, 300),
        variablesCreated: Array.from(variableStore.keys())
      });
      
      return summary;
    }
    
  } catch (error: any) {
    const errorMsg = `Tool call failed: ${error.message}`;
    
    toolAgentContext.conversationHistory.push({
      role: 'agent_response',
      content: errorMsg,
      timestamp: new Date()
    });
    
    sendDebugEvent(sendEvent, 'tool', 'FAILED', state.currentStep, {
      toolName: action.toolName,
      error: error.message
    });
    
    return `**Found:** No\n**Error:** ${error.message}\n**Recommendation:** Try a different approach or ask user for clarification.`;
  }
}

// Reset all agent contexts (for new session when user reloads page)
function resetAllContexts() {
  console.log('[Contexts] Resetting all agent contexts for new session');
  plannerContext = { conversationHistory: [], toolDescriptions: '' };
  toolAgentContext = { conversationHistory: [], rawDataStore: new Map() };
  uiAgentContext = { conversationHistory: [], generatedDSL: [] };
  variableStore.clear();  // Clear all stored variables
}

// ============================================================================
// UI AGENT
// ============================================================================
// The UI Agent:
// - Receives instructions from Planner (what UI to create)
// - Has access to VARIABLES containing data (can see actual values)
// - Generates beautiful Nuggt DSL
// - Does NOT report back to Planner (DSL goes directly to user)
// ============================================================================

const UI_AGENT_PROMPT = `You are an expert UI generator that creates ONE UI component at a time using Nuggt DSL.

## YOUR ROLE
Create a SINGLE, focused UI component based on the Planner's instruction.

## WHAT YOU SEE
- **Instructions**: What specific component to create (e.g., "a table showing properties")
- **Variables for this call**: ONLY the variables passed for THIS specific request - you see actual data values
- **Previous Nuggts**: What you've generated before (for visual consistency)
- You do NOT see: raw tool responses, all variables, or other agent data

{VARIABLES_DATA}



### CRITICAL RULES
1. **Order**: Always output the Nuggt DSL lines FIRST. Then output your conversational response.
2. **Formatting**: Do NOT use markdown code blocks (like \`\`\` or \`\`\`nuggt\`) for the DSL lines. Output the raw lines directly.
3. **Syntax**: Follow the syntax exactly. Do not add extra spaces or characters inside the bracket structures that are not defined.
4. **Markdown**: Any text that is NOT a valid Nuggt shortcode will be rendered as Markdown text. Use this for your explanations and guidance.

### AUTO-CANVAS BEHAVIOR
- **Display components** (card, alert, accordion) and **Visual components** (line-chart) are AUTOMATICALLY added to the user's canvas
- **Input components** and **Action components** (buttons) appear in the answer box for user interaction
- When you create Display/Visual components, mention in your markdown that you've added them to the canvas and explain their purpose
- Example: "I've added a revenue chart to your canvas showing the monthly trends. This will help you track performance over time."

### COLLABORATIVE WORKFLOW
1. Break every request into clear sequential steps. Only tackle the current step in detail, then wait for confirmation before moving forward.
2. In every reply remind the user of the broader plan so they know how the current step fits into the end goal.
3. **IMPORTANT**: When you need to ask the user questions, USE INPUT NUGGTS instead of plain text questions!
   - Use \`input\` for text/email/password questions
   - Use \`date-picker\` or \`calendar\` for date questions  
   - Use \`time-picker\` for time questions
   - Always include a \`button\` with a descriptive prompt so the user can submit their answers
   - The button's prompt should describe what happens with the collected values using \`<id>\` references
4. Use markdown text to EXPLAIN why you're asking the questions, what you've added to the canvas, and to provide context.

### NUGGT DSL SYNTAX

#### TEXT QUOTING RULES
- Text values that contain special characters (commas, colons, parentheses, newlines) must be wrapped in quotes
- Use double quotes for simple text: \`title: "Hello, World"\`
- For newlines, use \\n inside the quotes: \`content: "Line 1\\nLine 2"\`
- All text fields support **Markdown formatting** - use **bold**, *italic*, lists, headers, etc.
- **DO NOT** include angle brackets < > in your text content - just use regular quotes

#### 1. DISPLAY COMPONENTS (Type 1)
All text fields render as Markdown. **IMPORTANT**: Every display component MUST include a \`highlight\` property.

**The \`highlight\` property** is a markdown explanation of:
- What this component shows and why you added it
- Any assumptions you made that the user should confirm
- Questions about potential changes or customizations
- Suggestions for improvements

This allows the user to walk through each component and understand your reasoning.

- **Text**: \`text: (content: "Your markdown content", highlight: "Your explanation here")\`
  - Example: \`text: (content: "## Overview\\n\\nKey metrics for your business.", highlight: "I added this overview section to introduce the dashboard. Would you like me to include more context about the data sources?")\`
- **Table**: \`table: (columns: ["Col1","Col2"], data: [...], caption: "Caption", highlight: "Explanation")\`
  - Example: \`table: (columns: ["Name","Status"], data: [{"Name":"Item 1","Status":"Active"}], highlight: "This table shows your active items. Should I add more columns like date or priority?")\`
- **Accordion**: \`accordion: (trigger: "Title", content: "Content", highlight: "Explanation")\`
- **Card**: \`card: (title: "Title", content: "Content", highlight: "Explanation")\`
  - Example: \`card: (title: "Revenue", content: "$12,500", highlight: "I'm showing total revenue here. Would you prefer to see this as a percentage change or include a comparison to last month?")\`
- **Alert**: \`alert: (title: "Title", description: "Description", highlight: "Explanation")\`
- **Image**: \`image: (src: "https://url-to-image.jpg", alt: "Description of image", caption: "Optional caption", rounded: none|sm|md|lg|xl|full, object-fit: cover|contain|fill|none, highlight: "Explanation")\`
  - The image will automatically fit the layout column it's placed in
  - Use \`rounded\` to control corner rounding (default: \`lg\`)
  - Use \`object-fit\` to control how the image fills its container (default: \`cover\`)
  - Example: \`image: (src: "https://example.com/chart.png", alt: "Sales chart", caption: "Q4 2024 Performance", highlight: "I added this chart image to visualize the data.")\`

#### 2. USER INPUT COMPONENTS (Type 2)
You MUST assign a unique ID at the end.
- **Input**: \`input: [(label: "Label Text", placeholder: "Placeholder text", type: text|email|password), myInputId]\`
- **Calendar**: \`calendar: [(mode: single), calendarId]\`
- **Range Calendar**: \`range-calendar: [(), rangeCalId]\`
- **Date Picker**: \`date-picker: [(label: "Select Date"), dateId]\`
- **Time Picker**: \`time-picker: [(label: "Select Time"), timeId]\`

#### 3. ACTION COMPONENTS (Type 3)
You MUST define a "prompt" action. Use \`<inputId>\` to reference input values.
- **Button**: \`button: [(label: "Button Text", variant: default|destructive|outline|secondary|ghost|link), prompt: Action with <inputId>]\`
- **Alert Dialog**: \`alert-dialog: [(trigger: "Open", title: "Confirm", description: "Are you sure?", cancel: "Cancel", action: "Confirm"), prompt: Confirmed action]\`

**Variable Resolution**: 
In the \`prompt:\`, reference Input IDs using angle brackets \`<id>\` - these are the ONLY place where angle brackets should be used.
Example: \`button: [(label: Submit, variant: default), prompt: Sending email to <emailId>]\`

#### 4. VISUAL COMPONENTS (Type 4)
- **Line Chart**: \`line-chart: [(data: JSON_Array, x-data: key, y-data: key|key2|key3, colour: #hex|#hex2|#hex3, title: "Chart Title", label_x: "X Label", label_y: "Y Label"), chartId]\`
  - **IMPORTANT**: The \`data\` prop must be a valid, minified JSON array string. 
  - Do NOT use single quotes inside the JSON. Use double quotes for keys and string values.
  - **MULTIPLE LINES**: Use pipe \`|\` to separate multiple y-data keys and their corresponding colors
  - Single line example: \`line-chart: [(data: [{"month":"Jan","val":10}, {"month":"Feb","val":20}], x-data: month, y-data: val, colour: #2563eb, title: "Monthly Trend"), chart1]\`
  - Multi-line example: \`line-chart: [(data: [{"month":"Jan","sales":100,"revenue":80}, {"month":"Feb","sales":150,"revenue":120}], x-data: month, y-data: sales|revenue, colour: #2563eb|#10b981, title: "Sales vs Revenue"), chart1]\`

#### 5. LAYOUT SYSTEM
Arrange components in a grid.
Syntax: \`[<total_columns>]: { [<span_cols>]: <nuggt>, ... }\`

- **Examples**:
  - 2 Columns equal: \`[2]: { card: (...), card: (...) }\`
  - Spanning: \`[3]: { [2]: card: (...), [1]: button: (...) }\`
  - Row Span: \`[3]: { [2]: continue, [1]: alert: (...) }\` (Uses 'continue' to fill space from row above, must be the same number of columns as the previous nuggt's column that you want to continue)
  - Space: \`[3]: { [1]: space, [2]: card: (...) }\`

### INTERACTION EXAMPLES

**Example 1: Asking questions with Input Nuggts**
User: "Help me plan a marketing campaign"
Response:
[2]: { input: [(label: "Campaign Name", placeholder: "Enter campaign name", type: text), campaignName], input: [(label: "Target Audience", placeholder: "e.g. Young professionals", type: text), audience] }
[2]: { input: [(label: "Budget", placeholder: "Enter budget amount", type: text), budget], date-picker: [(label: "Launch Date"), launchDate] }
button: [(label: "Continue Planning", variant: default), prompt: Planning campaign <campaignName> for <audience> with budget <budget> launching on <launchDate>]

**Step 1 of 3: Campaign Basics**

I'll help you plan your marketing campaign step by step. First, let me gather some basic information.

Please fill in the details above and click "Continue Planning" when ready. In the next step, we'll work on the campaign channels and messaging strategy.

**Example 2: Showing results with Markdown in cards (with highlights)**
User: "Show me a sales dashboard with a chart"
Response:
alert: (title: "**Performance Alert**", description: "Sales are **trending up** by *15%* this week!", highlight: "I added this alert to immediately draw attention to the positive trend. Would you like me to change the threshold for when alerts appear?")
line-chart: [(data: [{"d":"Mon","v":100},{"d":"Tue","v":150},{"d":"Wed","v":120}], x-data: d, y-data: v, colour: #10b981, title: "Weekly Revenue"), chart1]
[2]: { card: (title: "**Total Revenue**", content: "$370", highlight: "This shows your total revenue for the week. Should I add a comparison to last week or show it as a percentage change?"), card: (title: "**Visitors**", content: "450 unique visitors", highlight: "Displaying unique visitor count. Would you prefer to see page views instead, or both metrics?") }

I've added your sales dashboard to the canvas. Click the **Explain** button to walk through each component and provide feedback.

**Example 3: Using text component for detailed content (with highlights)**
User: "Show me an analysis with a chart"
Response:
[2]: { text: (content: "## Sales Analysis\\n\\nThis quarter shows **strong growth**.", highlight: "I created this summary to provide context for the chart. Should I include more detailed breakdowns by region or product category?"), line-chart: [(data: [{"m":"Jan","v":100},{"m":"Feb","v":120},{"m":"Mar","v":150}], x-data: m, y-data: v, colour: #2563eb, title: "Quarterly Trend"), chart1] }

I've added an analysis view. Use the **Explain** button to review my assumptions and suggest changes.

**Example 4: Using table for structured data (with highlights)**
User: "Show me a list of recent invoices"
Response:
table: (columns: ["Invoice","Status","Method","Amount"], data: [{"Invoice":"INV001","Status":"Paid","Method":"Credit Card","Amount":"$250.00"},{"Invoice":"INV002","Status":"Pending","Method":"PayPal","Amount":"$150.00"}], caption: "Recent invoices", highlight: "I'm showing the most recent invoices with key details. Would you like me to add more columns like due date or customer name? Should I filter by status?")

I've added your invoice table. Click **Explain** to review and customize.

**Example 5: Mixed workflow with rich text (with highlights)**
User: (After submitting inputs) "Planning campaign Summer Sale for Young professionals with budget $5000 launching on 2024-06-01"
Response:
card: (title: "**Summer Sale Campaign**", content: "**Target:** Young professionals\\n**Budget:** $5,000\\n**Launch:** June 1, 2024", highlight: "This card summarizes your campaign details. I assumed a single target audience - should we segment this further by age group or interests?")
[3]: { card: (title: "Social Media", content: "*Instagram*, *TikTok*", highlight: "I chose Instagram and TikTok based on the young professional demographic. Would you like to add LinkedIn for B2B reach?"), card: (title: "Email", content: "Newsletter blast", highlight: "Planning a single newsletter blast. Should this be a drip campaign with multiple emails instead?"), card: (title: "Paid Ads", content: "Google and Meta", highlight: "Standard paid channels selected. What's your expected CPC budget split between these platforms?") }
input: [(label: "Primary Message", placeholder: "What is your main campaign message?", type: text), mainMessage]
button: [(label: "Finalize Campaign", variant: default), prompt: Finalizing campaign with message: <mainMessage>]

**Step 2 of 3: Campaign Channels**

I've added your campaign summary and channel strategy. Click **Explain** to walk through each component and provide feedback on my assumptions.

Now, what's the primary message you want to convey? Enter it above and click "Finalize Campaign".

**Example 6: Using item groups for organized sections**
User: "Create a dashboard with analytics and settings sections"
Response:
[2]: { item: (title: "Analytics Overview", description: "Key performance metrics", layout: [2]: { card: (title: "Active Users", content: "1,204", highlight: "Current active user count. Should I add a trend indicator?"), card: (title: "Conversion Rate", content: "3.2%", highlight: "Overall conversion rate. Would you like to see this broken down by source?") }, variant: outline, highlight: "I grouped the analytics KPIs together for easy scanning. Should I add more metrics like bounce rate or session duration?"), item: (title: "Quick Settings", description: "Frequently used options", layout: [1]: { accordion: (trigger: "Notifications", content: "Email and push notification preferences", highlight: "Notification settings section"), accordion: (trigger: "Display", content: "Theme and layout options", highlight: "Display customization options") }, variant: muted, size: sm, highlight: "I created a compact settings group. Would you prefer these as cards instead of accordions?") }

I've organized your dashboard into two main sections:
- **Analytics Overview** with your key metrics in a 2-column layout
- **Quick Settings** with expandable options in a compact format

Click **Explain** to review each group and suggest changes.

## PLANNER'S INSTRUCTION
{INSTRUCTION}

## YOUR PREVIOUS GENERATIONS (for context)
{PREVIOUS_DSL}

Use the data from the VARIABLES PROVIDED section above to create the UI components.
Generate the Nuggt DSL now. Output the DSL code.`;

async function runUIAgent(
  action: { component: string; instruction: string; variables?: string[] },
  state: RequestState,
  sendEvent: (data: any) => void
): Promise<string> {
  const client = createOpenRouterClient();
  
  // Get component-specific prompt
  const componentType = action.component || 'card';
  const componentPrompt = getComponentPrompt(componentType);
  
  // Build variables data string - ONLY for variables passed in this call
  let variablesDataStr = '';
  const variableNames = action.variables || [];
  
  if (variableNames.length > 0) {
    variablesDataStr = '## DATA TO USE\n\n';
    for (const varName of variableNames) {
      const variable = variableStore.get(varName);
      if (variable) {
        variablesDataStr += `### ${varName}\n`;
        variablesDataStr += `${variable.description}\n\n`;
        variablesDataStr += `\`\`\`json\n${JSON.stringify(variable.value, null, 2).slice(0, 5000)}\n\`\`\`\n\n`;
      } else {
        variablesDataStr += `### ${varName}\n(Variable not found)\n\n`;
      }
    }
  } else {
    variablesDataStr = '(No data provided)';
  }
  
  sendDebugEvent(sendEvent, 'ui', 'CREATING', state.currentStep, {
    component: componentType,
    instruction: action.instruction.slice(0, 200),
    variablesProvided: variableNames
  });
  sendEvent({ type: 'progress', status: 'generating', detail: `Creating ${componentType} component...` });
  
  // Build prompt with component-specific template + data + instruction
  const prompt = `${componentPrompt}

## REQUEST FROM PLANNER
${action.instruction}

${variablesDataStr}

Generate ONLY the ${componentType} DSL now. No explanations, no markdown - just the DSL.`;
  
  try {
    const response = await client.chat.completions.create({
      model: state.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 1500
    });
    
    let dsl = response.choices[0]?.message?.content || '';
    
    // Clean up any markdown or extra text - keep only DSL lines
    dsl = dsl.trim();
    // Remove markdown code blocks if present
    dsl = dsl.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
    
    // Store the generated DSL
    uiAgentContext.generatedDSL.push(dsl);
    state.finalDSL.push(dsl);
    
    sendDebugEvent(sendEvent, 'ui', 'COMPLETE', state.currentStep, {
      component: componentType,
      dslPreview: dsl.slice(0, 300),
      dslLength: dsl.length
    });
    
    // Return confirmation to Planner
    return `Created ${componentType} component successfully.`;
    
  } catch (error: any) {
    sendDebugEvent(sendEvent, 'ui', 'FAILED', state.currentStep, {
      component: componentType,
      error: error.message
    });
    return `Failed to create ${componentType}: ${error.message}`;
  }
}

// ============================================================================
// MAIN ORCHESTRATION LOOP
// ============================================================================
// This runs the Planner in a loop, executing actions until complete or paused.
// ============================================================================

async function runPlannerLoop(
  message: string,
  history: any[],
  state: RequestState,
  sendEvent: (data: any) => void
): Promise<{ finalDSL: string[]; finalMessage: string; paused: boolean }> {
  
  // Initialize tool descriptions if not done
  if (!plannerContext.toolDescriptions) {
    // Use sub-tool descriptions if we have learnings, otherwise use original tools
    if (state.useSubTools && hasAnyLearnings()) {
      plannerContext.toolDescriptions = buildSubToolDescriptionsForPlanner();
      console.log('[PlannerLoop] Using learned sub-tool descriptions');
    } else {
      plannerContext.toolDescriptions = buildToolDescriptions(state.tools);
      console.log('[PlannerLoop] Using original MCP tool descriptions');
    }
  }
  
  // Check if this is a continuation (user replied after pause)
  const isContinuation = plannerContext.conversationHistory.length > 0 && 
                         plannerContext.conversationHistory[plannerContext.conversationHistory.length - 1]?.role === 'assistant';
  
  sendDebugEvent(sendEvent, 'system', 'START', 0, {
    mode: isContinuation ? 'Resuming conversation' : 'Starting new request',
    useSubTools: state.useSubTools,
    plannerHistorySize: plannerContext.conversationHistory.length,
    toolAgentHistorySize: toolAgentContext.conversationHistory.length,
    uiAgentHistorySize: uiAgentContext.conversationHistory.length
  });
  
  let agentResponse: string | null = null;
  
  while (state.currentStep < state.maxSteps && !state.isComplete) {
    state.currentStep++;
    
    sendDebugEvent(sendEvent, 'planner', 'STEP', state.currentStep, {
      maxSteps: state.maxSteps
    });
    
    // Run Planner to get next action
    const action = await runPlannerAgent(
      message,
      agentResponse,
      state,
      sendEvent
    );
    
    // Clear message after first iteration (it's now in context)
    message = '';
    agentResponse = null;
    
    // Execute the action
    switch (action.type) {
      case 'CALL_TOOL':
        sendDebugEvent(sendEvent, 'planner', 'DELEGATING', state.currentStep, {
          target: 'Tool Agent',
          toolName: action.toolName,
          purpose: action.purpose,
          lookingFor: action.lookingFor
        });
        agentResponse = await runToolAgent(action, state, sendEvent);
        break;
        
      case 'CREATE_UI':
        sendDebugEvent(sendEvent, 'planner', 'DELEGATING', state.currentStep, {
          target: 'UI Agent',
          component: action.component,
          instruction: action.instruction.slice(0, 150),
          variables: action.variables || []
        });
        agentResponse = await runUIAgent(
          { component: action.component, instruction: action.instruction, variables: action.variables },
          state,
          sendEvent
        );
        break;
        
      case 'RESPOND_TO_USER':
        state.finalMessage = action.message;
        
        if (action.waitForReply) {
          sendDebugEvent(sendEvent, 'planner', 'WAITING', state.currentStep, {
            message: action.message.slice(0, 200),
            waitingForReply: true
          });
          return { finalDSL: state.finalDSL, finalMessage: action.message, paused: true };
        }
        
        // If not waiting, continue to next action
        sendDebugEvent(sendEvent, 'planner', 'INFORMED', state.currentStep, {
          message: action.message.slice(0, 200)
        });
        break;
        
      case 'DONE':
        state.isComplete = true;
        sendDebugEvent(sendEvent, 'system', 'COMPLETE', state.currentStep, {
          totalSteps: state.currentStep,
          dslCount: state.finalDSL.length
        });
        break;
    }
  }
  
  if (state.currentStep >= state.maxSteps) {
    sendDebugEvent(sendEvent, 'system', 'MAX_STEPS', state.currentStep, {
      maxSteps: state.maxSteps,
      message: 'Reached step limit'
    });
  }
  
  return { finalDSL: state.finalDSL, finalMessage: state.finalMessage, paused: false };
}

// ============================================================================
// OPENROUTER REQUEST HANDLER
// ============================================================================
// Entry point for OpenRouter model requests. Uses the multi-agent system.
// ============================================================================

async function handleOpenRouterRequest(
  res: express.Response,
  sendEvent: (data: any) => void,
  message: string,
  history: any[],
  model: string,
  tools: OpenAI.Chat.Completions.ChatCompletionTool[]
) {
  sendEvent({ type: 'progress', status: 'thinking', detail: 'Initializing agents...' });
  
  // Reset all agent contexts if this is a new conversation (empty or minimal history)
  // This happens when the user reloads the page
  if (history.length <= 1) {
    console.log('[OpenRouter] New session detected, resetting all agent contexts');
    resetAllContexts();
  }
  
  // Check if we have learned sub-tools available
  const useSubTools = hasAnyLearnings();
  if (useSubTools) {
    console.log('[OpenRouter] Using learned sub-tools instead of original MCP tools');
  }
  
  // Create request state
  const state: RequestState = {
    model,
    tools,
    currentStep: 0,
    maxSteps: 50,
    isComplete: false,
    finalDSL: [],
    finalMessage: '',
    useSubTools
  };
  
  try {
    const result = await runPlannerLoop(message, history, state, sendEvent);
    
    // Build final response
    let finalText = '';
    
    // Add any generated DSL
    if (result.finalDSL.length > 0) {
      finalText += result.finalDSL.join('\n\n');
    }
    
    // Add message if present
    if (result.finalMessage) {
      if (finalText) finalText += '\n\n---\n\n';
      finalText += result.finalMessage;
    }
    
    if (!finalText) {
      finalText = 'Task completed.';
    }
    
    sendEvent({ type: 'progress', status: 'complete', detail: '✅ Complete!' });
    sendEvent({ type: 'result', text: finalText });
    res.end();
    
  } catch (error: any) {
    console.error('[OpenRouter Pipeline] Error:', error);
    sendEvent({ type: 'error', error: error.message });
    res.end();
  }
}

// Handle Gemini/Google requests
async function handleGeminiRequest(
  res: express.Response,
  sendEvent: (data: any) => void,
  message: string,
  history: any[],
  model: string,
  tools: any[]
) {
  if (!GEMINI_API_KEY) {
    throw new Error('Gemini API key not configured');
  }
  
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

    const contents = history.map((msg: any) => ({
        role: msg.role === 'system' ? 'model' : 'user',
        parts: [{ text: msg.content }]
    }));
    
    contents.push({
      role: 'user',
      parts: [{ text: message }]
    });
    
    let currentContents = [...contents];
    let turns = 0;
    const MAX_TURNS = 5;
    let finalText = '';
    let pendingFunctionCalls: any[] = [];

    // Helper function to stream a generation and collect results
    // Returns functionCalls with their thoughtSignature for thinking models
    const streamGeneration = async (contents: any[], isToolFollowUp = false): Promise<{ text: string; functionCalls: any[]; modelParts: any[] }> => {
      let collectedText = '';
      let functionCalls: any[] = [];
      let modelParts: any[] = []; // Store all model parts to preserve thoughtSignature
      
      const stream = await ai.models.generateContentStream({
        model: model,
        contents: contents,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          temperature: 0.1,
          tools: tools.length > 0 ? tools : undefined,
          thinkingConfig: {
            includeThoughts: true
          }
        }
      });

      for await (const chunk of stream) {
        // Process each candidate's parts
        if (chunk.candidates && chunk.candidates[0]?.content?.parts) {
          for (const part of chunk.candidates[0].content.parts) {
            // Store the raw part to preserve thoughtSignature
            modelParts.push(part);
            
            // Check if this is a thought part
            if (part.thought) {
              // This is a thinking summary - send it to the client
              if (part.text) {
                sendEvent({ type: 'progress', status: 'thinking', detail: part.text });
              }
            } else if (part.text) {
              // This is regular answer text - stream it as it comes
              collectedText += part.text;
              // Send the streaming text to show progress
              sendEvent({ type: 'progress', status: 'generating', detail: collectedText });
            } else if (part.functionCall) {
              // This is a function call - store the full part to keep thoughtSignature
              functionCalls.push(part);
            }
          }
        }
      }

      return { text: collectedText, functionCalls, modelParts };
    };

    // Initial streaming generation
    let result = await streamGeneration(currentContents);
    finalText = result.text;
    pendingFunctionCalls = result.functionCalls;

    // Handle tool calls in a loop
    while (turns < MAX_TURNS && pendingFunctionCalls.length > 0) {
      turns++;
      
      // Add model's function call to history - preserve the full parts with thoughtSignature
      currentContents.push({
        role: 'model',
        parts: pendingFunctionCalls.map(fc => fc) // fc is already the full part with functionCall and thoughtSignature
      });

      const functionResponseParts: any[] = [];

      for (const callPart of pendingFunctionCalls) {
        const call = callPart.functionCall;
        console.log(`Calling tool: ${call.name}`);
        sendEvent({ type: 'progress', status: 'tool', detail: `Calling ${call.name}...` });
        
        try {
          const toolResult = await mcpManager.callTool(call.name, call.args);
          // Include thoughtSignature in the function response if it exists
          const responsePart: any = {
            functionResponse: {
              name: call.name,
              response: formatToolResponse(toolResult)
            }
          };
          // Copy thoughtSignature from the function call to the response
          if (callPart.thoughtSignature) {
            responsePart.thoughtSignature = callPart.thoughtSignature;
          }
          functionResponseParts.push(responsePart);
        } catch (err: any) {
          console.error(`Tool execution failed: ${err.message}`);
          const errorPart: any = {
            functionResponse: {
              name: call.name,
              response: { error: err.message }
            }
          };
          // Copy thoughtSignature from the function call to the error response
          if (callPart.thoughtSignature) {
            errorPart.thoughtSignature = callPart.thoughtSignature;
          }
          functionResponseParts.push(errorPart);
        }
      }

      // Add function responses to history
      currentContents.push({
        role: 'function',
        parts: functionResponseParts
      });

      // Stream the next generation
      sendEvent({ type: 'progress', status: 'generating', detail: 'Processing tool results...' });
      result = await streamGeneration(currentContents, true);
      finalText = result.text;
      pendingFunctionCalls = result.functionCalls;
    }

  sendEvent({ type: 'progress', status: 'complete', detail: 'Done!' });
  sendEvent({ type: 'result', text: finalText });
  res.end();
}

// ============================================================================
// MCP LEARNING ENDPOINTS
// ============================================================================

const LEARNINGS_DIR = path.join(process.cwd(), 'mcp-learnings');

// Ensure learnings directory exists
if (!fs.existsSync(LEARNINGS_DIR)) {
  fs.mkdirSync(LEARNINGS_DIR, { recursive: true });
}

// Get list of MCPs with their learning status
app.get('/api/mcps', async (req, res) => {
  try {
    const tools = mcpManager.getTools();
    
    // Group tools by server
    const mcpMap = new Map<string, number>();
    tools.forEach(tool => {
      // Extract server name from tool name (format: servername_toolname)
      const parts = tool.name.split('_');
      const serverName = parts[0];
      mcpMap.set(serverName, (mcpMap.get(serverName) || 0) + 1);
    });

    // Check learning status for each MCP
    const mcps = Array.from(mcpMap.entries()).map(([name, toolCount]) => {
      const learningPath = path.join(LEARNINGS_DIR, `${name}.json`);
      let hasLearning = false;
      let learnedAt: string | undefined;
      let subToolCount: number | undefined;
      let workflowCount: number | undefined;
      
      if (fs.existsSync(learningPath)) {
        try {
          const learning = JSON.parse(fs.readFileSync(learningPath, 'utf-8'));
          hasLearning = true;
          learnedAt = learning.learnedAt;
          subToolCount = learning.subTools?.length || 0;
          workflowCount = learning.workflows?.length || 0;
        } catch (e) {
          // Invalid learning file
        }
      }
      
      return { name, toolCount, hasLearning, learnedAt, subToolCount, workflowCount };
    });

    res.json({ mcps });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get current agent prompts for the multi-agent system
app.get('/api/agent-prompts', async (req, res) => {
  try {
    const usingSubTools = hasAnyLearnings();
    
    // Build the tool descriptions as the agents would see them
    const toolDescriptions = usingSubTools 
      ? buildSubToolDescriptionsForPlanner()
      : buildToolDescriptions(mcpManager.getToolsForOpenAI());
    
    const toolAgentDocs = usingSubTools
      ? buildSubToolDocsForToolAgent()
      : '(Using original MCP tool schemas - shown in each tool call)';
    
    // Build the prompts as they would be rendered
    const availableComponentsStr = AVAILABLE_COMPONENTS.map(c => 
      `- **${c.type}**: ${c.description}`
    ).join('\n');
    
    const plannerPrompt = PLANNER_PROMPT
      .replace('{TOOL_DESCRIPTIONS}', toolDescriptions)
      .replace('{CONVERSATION_HISTORY}', '(Conversation history would appear here)')
      .replace('{AVAILABLE_VARIABLES}', '(Variables would appear here)')
      .replace('{AVAILABLE_COMPONENTS}', availableComponentsStr);
    
    const subToolArgsPrompt = usingSubTools ? SUBTOOL_ARGS_PROMPT
      .replace('{TOOL_NAME}', '(Sub-tool name)')
      .replace('{PURPOSE}', '(Purpose from Planner)')
      .replace('{LOOKING_FOR}', '(What Planner is looking for)')
      .replace('{SUBTOOL_DOCS}', '(Sub-tool documentation)')
      .replace('{CONVERSATION_HISTORY}', '(Tool Agent conversation history)')
      .replace('{PREVIOUS_RAW_DATA}', '(Previous tool call results)')
      : null;
    
    const originalToolArgsPrompt = TOOL_ARGS_PROMPT
      .replace('{TOOL_NAME}', '(Tool name)')
      .replace('{PURPOSE}', '(Purpose from Planner)')
      .replace('{LOOKING_FOR}', '(What Planner is looking for)')
      .replace('{TOOL_SCHEMA}', '(Tool JSON schema)')
      .replace('{CONVERSATION_HISTORY}', '(Tool Agent conversation history)')
      .replace('{PREVIOUS_RAW_DATA}', '(Previous tool call results)');
    
    // Get current variables for display
    const currentVariables: any[] = [];
    for (const [name, variable] of variableStore) {
      currentVariables.push({
        name,
        description: variable.description,
        createdBy: variable.createdBy,
        dataType: Array.isArray(variable.value) ? `array(${variable.value.length})` : typeof variable.value
      });
    }
    
    // Build component prompts map
    const componentPrompts: Record<string, string> = {};
    for (const [key, prompt] of Object.entries(NUGGT_PROMPTS)) {
      componentPrompts[key] = prompt;
    }
    
    // Build the complete tool-calling agent prompt (for backwards compatibility)
    const toolCallingAgentPrompt = buildToolCallingAgentPrompt();
    
    // Also show the call-syntax sub-tool docs separately
    const toolCallingSyntaxDocs = buildSubToolDocsForToolCallingAgent();
    
    // Build Pilot System prompts
    const pilotToolSummaries = buildToolSummariesForPilot();
    const pilotPromptExample = buildPilotPrompt('(Current data will appear here)', pilotToolSummaries);
    const executorPromptExample = buildExecutorPrompt(
      '(Task from Pilot will appear here)',
      buildToolDocsForExecutor(['llm', 'table', 'line-chart']),
      '(Variables will appear here)',
      '(Progress will appear here)'
    );
    
    res.json({
      usingSubTools,
      subToolCount: usingSubTools ? getAllSubTools().length : 0,
      workflowCount: usingSubTools ? getAllWorkflows().length : 0,
      currentVariables,
      prompts: {
        planner: {
          name: 'Planner Agent (Multi-Agent)',
          description: 'Central coordinator. Chooses which UI component to use and passes data via VARIABLES.',
          prompt: plannerPrompt,
          availableComponents: AVAILABLE_COMPONENTS
        },
        toolAgent: {
          name: 'Tool Agent (Multi-Agent)',
          description: 'Executes tool calls, creates VARIABLES to store data, reports variable names to Planner',
          argsPrompt: usingSubTools ? subToolArgsPrompt : originalToolArgsPrompt,
          analysisPrompt: usingSubTools ? SUBTOOL_ANALYSIS_PROMPT : TOOL_ANALYSIS_PROMPT,
          fullToolDocs: toolAgentDocs
        },
        ui: {
          name: 'UI Agents (Multi-Agent, Component-Specific)',
          description: 'Each UI component has its own specialized prompt. Planner specifies which component to use.',
          componentPrompts: componentPrompts
        },
        pilotSystem: {
          name: 'Pilot System (Toggle Mode)',
          description: 'Two-agent architecture: Pilot (strategist) + Executor (implementer). Pilot decides what tools to use, Executor executes them.',
          pilotPrompt: pilotPromptExample,
          executorPrompt: executorPromptExample,
          toolSummaries: pilotToolSummaries
        }
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Generate LLM prompt preview from learning file
app.get('/api/mcp-learning-preview', async (req, res) => {
  const mcpName = req.query.mcp as string;
  
  if (!mcpName) {
    res.status(400).json({ error: 'MCP name required' });
    return;
  }

  const learningPath = path.join(LEARNINGS_DIR, `${mcpName}.json`);
  
  if (!fs.existsSync(learningPath)) {
    res.status(404).json({ error: 'No learning found for this MCP' });
    return;
  }

  try {
    const learning = JSON.parse(fs.readFileSync(learningPath, 'utf-8'));
    const prompt = generateLLMPromptFromLearning(learning);
    res.json({ prompt });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Helper function to generate LLM prompt from learning data
function generateLLMPromptFromLearning(learning: any): string {
  const lines: string[] = [];
  
  lines.push(`## MCP: ${learning.mcpName}`);
  lines.push(`Learned: ${new Date(learning.learnedAt).toLocaleDateString()}`);
  lines.push('');
  
  // Sub-tools section
  if (learning.subTools && learning.subTools.length > 0) {
    lines.push('## AVAILABLE SUB-TOOLS');
    lines.push('These are specialized tools extracted from the MCP. Call them by name with the specified inputs.');
    lines.push('');
    
    for (const subTool of learning.subTools) {
      lines.push(`### ${subTool.name}`);
      lines.push(`**Description:** ${subTool.description}`);
      lines.push(`**Parent Tool:** ${subTool.parentTool}`);
      
      // Dependencies
      if (subTool.requiresFirst && subTool.requiresFirst.length > 0) {
        lines.push('');
        lines.push('**⚠️ Requires First:**');
        for (const dep of subTool.requiresFirst) {
          lines.push(`  - Call \`${dep.subTool}\` first to get \`${dep.extractField}\``);
          lines.push(`    Extract from: \`${dep.fromPath}\``);
        }
      }
      
      // Inputs
      if (subTool.inputs && subTool.inputs.length > 0) {
        lines.push('');
        lines.push('**Inputs:**');
        for (const input of subTool.inputs) {
          const required = input.required ? '(required)' : '(optional)';
          lines.push(`  - \`${input.name}\` ${required}: ${input.description || input.type}`);
          
          if (input.type === 'enum' && input.options) {
            lines.push('    Valid values:');
            for (const opt of input.options.slice(0, 10)) {
              lines.push(`      - \`${opt.value}\`: ${opt.description || ''}`);
            }
            if (input.options.length > 10) {
              lines.push(`      - ... and ${input.options.length - 10} more options`);
            }
          }
          
          if (input.format) {
            lines.push(`    Format: ${input.format}`);
          }
          
          if (input.source) {
            lines.push(`    Get from: Call \`${input.source.tool}\` first, extract with \`${input.source.jsonPath}\``);
          }
          
          if (input.examples) {
            lines.push(`    Examples: ${input.examples.slice(0, 5).join(', ')}`);
          }
        }
      }
      
      // Output fields
      if (subTool.outputFields && subTool.outputFields.length > 0) {
        lines.push('');
        lines.push('**Returns:**');
        for (const field of subTool.outputFields) {
          lines.push(`  - \`${field.name}\` (${field.type}): ${field.description || ''}`);
        }
      }
      
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }
  
  // Workflows section
  if (learning.workflows && learning.workflows.length > 0) {
    lines.push('## WORKFLOWS');
    lines.push('Use these workflows for complex tasks. Follow the steps in order.');
    lines.push('');
    
    for (const workflow of learning.workflows) {
      lines.push(`### ${workflow.userTask || workflow.name || workflow.id}`);
      if (workflow.category) {
        lines.push(`**Category:** ${workflow.category}`);
      }
      lines.push('');
      
      if (workflow.steps && workflow.steps.length > 0) {
        lines.push('**Steps:**');
        for (const step of workflow.steps) {
          if (step.action) {
            lines.push(`  ${step.step}. [${step.action.toUpperCase()}] ${step.purpose}`);
            if (step.logic) {
              lines.push(`     Logic: ${step.logic}`);
            }
          } else {
            lines.push(`  ${step.step}. Call \`${step.subTool}\`: ${step.purpose}`);
            if (step.inputMapping) {
              lines.push(`     Inputs: ${JSON.stringify(step.inputMapping)}`);
            }
          }
        }
      }
      
      if (workflow.answerTemplate) {
        lines.push('');
        lines.push(`**Answer Format:** ${workflow.answerTemplate}`);
      }
      
      if (workflow.decisionPoints && workflow.decisionPoints.length > 0) {
        lines.push('');
        lines.push('**Decision Points:**');
        for (const point of workflow.decisionPoints) {
          lines.push(`  - ${point}`);
        }
      }
      
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }
  
  // Insights
  if (learning.insights) {
    lines.push('## INSIGHTS');
    lines.push(learning.insights);
    lines.push('');
  }
  
  // Usage instructions
  lines.push('## HOW TO USE');
  lines.push('1. To call a sub-tool, use the tool name as specified above');
  lines.push('2. Check "Requires First" - some tools need IDs from other tools');
  lines.push('3. For complex tasks, follow the workflow steps in order');
  lines.push('4. The system automatically extracts data using JSONPath - you get clean, focused data');
  
  return lines.join('\n');
}

// Learning Agent Prompt
const LEARNING_AGENT_PROMPT = `You are an MCP Tool Learning Agent. Your mission is to systematically explore tools, understand their responses AND inputs deeply, and create precise sub-tools and practical workflows.

## CRITICAL REQUIREMENTS
1. You must learn BOTH the response structure AND the input requirements
2. For inputs with limited options (dimensions, metrics, types), you MUST discover and list ALL valid options
3. For well-known formats (country codes, currencies, languages), use standard formats like ISO 3166-1 alpha-2 for countries
4. For inputs that reference data from other tools, specify where that data comes from
5. If documentation links are mentioned, you can browse them to get complete option lists
6. Output must be in EXACT JSON format that code can parse

## TOOL DEPENDENCIES - CRITICAL
Many tools require data from OTHER tools as input. For example:
- A "get_report" tool may need a "property_id" that comes from "list_properties"
- A "get_details" tool may need an "item_id" that comes from "search_items"

**YOU MUST discover these dependencies by:**
1. First, call tools that LIST or SEARCH to get IDs/references
2. Then, use those IDs to call tools that GET details or reports
3. Document these dependencies in the sub-tool's "requiresFirst" field

When you encounter a tool that needs an ID or reference:
1. Find which tool provides that ID
2. Call that tool first to get real IDs
3. Use those IDs to test the dependent tool
4. Document the dependency chain

## HOW TO CALL TOOLS
To call a tool, output exactly:
[CALL_TOOL]
{"tool": "tool_name", "args": {"arg1": "value1"}, "purpose": "Why you're making this call"}
[/CALL_TOOL]

## HOW TO BROWSE WEB (for documentation)
If you need to look up documentation, output:
[BROWSE_WEB]
{"url": "https://documentation-url.com", "reason": "Looking up valid dimension values"}
[/BROWSE_WEB]

## PHASE 1: TOOL EXPLORATION
For each tool:
1. Review the tool's schema and description
2. Identify if it needs IDs from other tools - if so, call those first
3. Decide on safe, realistic test arguments
4. Call the tool and observe the response
5. You may call the same tool multiple times with different arguments

## PHASE 2: INPUT DOCUMENTATION
For EACH input parameter:

**For ENUM inputs** (limited valid values):
Output:
[INPUT_LEARNED]
{
  "toolName": "original_tool",
  "inputName": "dimension",
  "type": "enum",
  "required": true,
  "options": [
    {"value": "value1", "description": "What this value means"},
    {"value": "value2", "description": "What this value means"}
  ],
  "default": "value1",
  "notes": "Any important notes"
}
[/INPUT_LEARNED]

**For FORMAT inputs** (dates, IDs, codes):
Output:
[INPUT_LEARNED]
{
  "toolName": "original_tool",
  "inputName": "country",
  "type": "format",
  "required": true,
  "format": "ISO 3166-1 alpha-2",
  "description": "Two-letter country code",
  "examples": ["US", "GB", "DE", "JP"],
  "notes": "Use standard ISO country codes"
}
[/INPUT_LEARNED]

**For REFERENCE inputs** (IDs from other tools):
Output:
[INPUT_LEARNED]
{
  "toolName": "original_tool",
  "inputName": "property_id",
  "type": "reference",
  "required": true,
  "source": {
    "tool": "list_properties",
    "jsonPath": "$.properties[*].id",
    "description": "First call list_properties to get available IDs"
  },
  "format": "properties/{numeric_id}",
  "example": "properties/123456789"
}
[/INPUT_LEARNED]

## PHASE 3: SUB-TOOL CREATION
For tools that return multiple types of data, create focused sub-tools:

**IMPORTANT: JSONPath must be for UNWRAPPED data**
MCP responses come wrapped in {"content":[{"type":"text","text":"..."}]}. 
The system automatically unwraps this before applying your JSONPath.
- WRONG: "$.content[0].text" or "$.content[*].text"  
- RIGHT: "$.properties[*].name" (path to actual data inside the text)
Always write JSONPaths assuming the data is already unwrapped.

[SUB_TOOL]
{
  "id": "unique_subtool_id",
  "name": "descriptive_subtool_name",
  "description": "Clear description of what this extracts and returns",
  "parentTool": "original_mcp_tool_name",
  "parentToolDefaultArgs": {
    "arg_that_stays_constant": "value"
  },
  "requiresFirst": [
    {
      "subTool": "list_items",
      "reason": "To get item_id for this tool",
      "extractField": "item_id",
      "fromPath": "$.items[*].id"
    }
  ],
  "inputs": [
    {
      "name": "user_facing_input_name",
      "type": "enum|string|number|date|reference|format",
      "required": true,
      "description": "What this input is for",
      "mapToParentArg": "original_arg_name",
      "options": [...],
      "format": "...",
      "source": {...}
    }
  ],
  "jsonPath": "$.path.to.extract.data",
  "outputFields": [
    {"name": "field1", "path": "$.relative.path", "type": "string", "description": "What this field contains"}
  ],
  "outputExample": {"field1": "example value"}
}
[/SUB_TOOL]

## PHASE 4: WORKFLOW CREATION
Create workflows for SPECIFIC USER TASKS and DECISIONS - NOT generic documentation.

A workflow answers: "If a user asks X, what sub-tools do I call in what order?"

Focus on:
- Complex analytical tasks requiring multiple data points
- Decision-making scenarios that need data comparison
- Multi-step processes where output of one tool feeds another
- Real business questions users would actually ask

[WORKFLOW]
{
  "id": "workflow_id",
  "userTask": "The exact question or task a user would ask, e.g., 'Which of my web pages has the highest bounce rate and why?'",
  "category": "analysis|comparison|investigation|optimization|reporting",
  "complexity": "multi-step",
  "steps": [
    {
      "step": 1,
      "subTool": "subtool_name",
      "purpose": "What this step accomplishes toward answering the user's question",
      "inputSource": "user|previous_step",
      "inputMapping": {
        "input_name": "from user query or $.step1.output.field"
      }
    },
    {
      "step": 2,
      "subTool": "another_subtool",
      "purpose": "Why this step is needed",
      "inputSource": "step_1",
      "inputMapping": {
        "some_id": "$.step1.output.id"
      }
    },
    {
      "step": 3,
      "action": "compare|analyze|decide",
      "purpose": "How to combine data from previous steps to answer the user's question",
      "logic": "Compare step1.bounce_rate across pages, identify highest, then use step2 to get traffic sources for that page"
    }
  ],
  "answerTemplate": "The page with highest bounce rate is {step1.page_name} at {step1.bounce_rate}%. This is likely because {step2.analysis}.",
  "decisionPoints": [
    "If bounce rate > 70%, recommend content review",
    "If traffic source is paid, recommend landing page optimization"
  ]
}
[/WORKFLOW]

**Workflow Examples to Create:**
- "Which content is performing poorly and should be updated?"
- "Compare traffic between two time periods and explain the difference"
- "Find pages with high traffic but low conversions - what's wrong?"
- "What search terms are bringing traffic but not ranking in top 3?"
- "Identify the best performing campaign and why it's working"

## PHASE 5: COMPLETION
When you've explored all tools, output:
[LEARNING_COMPLETE]
{
  "mcpName": "name",
  "totalOriginalTools": N,
  "totalSubToolsCreated": M,
  "totalInputsDocumented": K,
  "totalWorkflowsCreated": W,
  "insights": "Key observations about this MCP"
}
[/LEARNING_COMPLETE]

## IMPORTANT RULES
1. Call tools ONE AT A TIME - wait for response before next action
2. Be thorough - explore different input combinations
3. Create sub-tools for distinct data types in responses
4. For country/language codes, state they should use ISO standards rather than listing all
5. Ignore response metadata (status codes, timestamps, pagination) - focus on business data
6. Every JSONPath must be tested against actual response data
7. Always discover tool dependencies - call list/search tools before detail tools
8. Create workflows that solve REAL user problems, not generic "how to use" guides`;

// Learning endpoint with SSE
app.get('/api/learn-mcp', async (req, res) => {
  const mcpNames = (req.query.mcps as string || '').split(',').filter(Boolean);
  
  if (mcpNames.length === 0) {
    res.status(400).json({ error: 'No MCPs specified' });
    return;
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Get tools for selected MCPs
    const allTools = mcpManager.getTools();
    const selectedTools = allTools.filter(tool => {
      const serverName = tool.name.split('_')[0];
      return mcpNames.includes(serverName);
    });

    if (selectedTools.length === 0) {
      sendEvent({ type: 'error', message: 'No tools found for selected MCPs' });
      res.end();
      return;
    }

    sendEvent({ 
      type: 'log', 
      logType: 'info', 
      message: `Found ${selectedTools.length} tools to learn from ${mcpNames.join(', ')}` 
    });

    sendEvent({
      type: 'progress',
      progress: {
        phase: 'exploring',
        toolIndex: 0,
        totalTools: selectedTools.length,
        subToolsCreated: 0,
        inputsDocumented: 0
      }
    });

    // Build tool descriptions for the learning agent
    const toolDescriptions = selectedTools.map(tool => {
      const schema = tool.inputSchema as any;
      let inputDetails = '';
      if (schema?.properties) {
        inputDetails = Object.entries(schema.properties).map(([name, prop]: [string, any]) => {
          const required = schema.required?.includes(name) ? ' (required)' : ' (optional)';
          return `  - ${name}${required}: ${prop.type || 'any'} - ${prop.description || 'No description'}`;
        }).join('\n');
      }
      return `Tool: ${tool.name}
Description: ${tool.description || 'No description'}
Inputs:
${inputDetails || '  (no inputs)'}`;
    }).join('\n\n---\n\n');

    // Initialize learning state
    const learningState = {
      subTools: [] as any[],
      inputsDocumented: [] as any[],
      workflows: [] as any[],
      currentToolIndex: 0,
      insights: ''
    };

    // Create Anthropic client for learning
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });

    // Conversation history for learning agent
    const messages: { role: 'user' | 'assistant'; content: string }[] = [];

    // Initial message with tool information
    messages.push({
      role: 'user',
      content: `Here are the tools you need to learn:\n\n${toolDescriptions}\n\nPlease start exploring these tools one by one. Remember:
1. Some tools require IDs/data from OTHER tools - call list/search tools first to get those IDs
2. For each tool, call it with test arguments, analyze the response, document the inputs
3. Create focused sub-tools that extract specific data types
4. After exploring all tools, create practical WORKFLOWS for real user tasks/questions

Begin with the first tool. If it needs an ID from another tool, find and call that tool first.`
    });

    let isComplete = false;
    let iterationCount = 0;
    const maxIterations = 50; // Safety limit

    while (!isComplete && iterationCount < maxIterations) {
      iterationCount++;

      // Call Claude
      sendEvent({ type: 'log', logType: 'info', message: 'Learning agent thinking...' });

      const response = await anthropic.messages.create({
        model: 'claude-opus-4-5-20251101',
        max_tokens: 4096,
        system: LEARNING_AGENT_PROMPT,
        messages: messages
      });

      const assistantMessage = response.content[0].type === 'text' ? response.content[0].text : '';
      messages.push({ role: 'assistant', content: assistantMessage });

      // Parse the assistant's response for actions
      let userResponse = '';

      // Check for tool calls
      const toolCallMatch = assistantMessage.match(/\[CALL_TOOL\]\s*(\{[\s\S]*?\})\s*\[\/CALL_TOOL\]/);
      if (toolCallMatch) {
        try {
          const toolCall = JSON.parse(toolCallMatch[1]);
          sendEvent({ 
            type: 'tool_call', 
            tool: toolCall.tool, 
            args: toolCall.args 
          });

          sendEvent({
            type: 'progress',
            progress: {
              phase: 'exploring',
              currentTool: toolCall.tool,
              toolIndex: learningState.currentToolIndex,
              totalTools: selectedTools.length,
              subToolsCreated: learningState.subTools.length,
              inputsDocumented: learningState.inputsDocumented.length
            }
          });

          // Execute the tool call
          try {
            const result = await mcpManager.callTool(toolCall.tool, toolCall.args || {});
            const resultStr = JSON.stringify(result, null, 2);
            
            // Truncate very large responses for the preview
            const preview = resultStr.length > 500 
              ? resultStr.substring(0, 500) + '...[truncated]' 
              : resultStr;
            
            sendEvent({ 
              type: 'tool_response', 
              tool: toolCall.tool, 
              preview: preview 
            });

            userResponse = `Tool response for ${toolCall.tool}:\n\`\`\`json\n${resultStr}\n\`\`\`\n\nAnalyze this response, document the inputs you learned about, create any useful sub-tools, then continue with the next tool or action.`;
          } catch (err: any) {
            sendEvent({ 
              type: 'log', 
              logType: 'error', 
              message: `Tool call failed: ${err.message}` 
            });
            userResponse = `Tool call to ${toolCall.tool} failed with error: ${err.message}\n\nTry different arguments or move to the next tool.`;
          }
        } catch (e) {
          sendEvent({ type: 'log', logType: 'error', message: 'Failed to parse tool call' });
          userResponse = 'Failed to parse your tool call. Please use the exact format specified.';
        }
      }

      // Check for web browse requests
      const browseMatch = assistantMessage.match(/\[BROWSE_WEB\]\s*(\{[\s\S]*?\})\s*\[\/BROWSE_WEB\]/);
      if (browseMatch) {
        try {
          const browseReq = JSON.parse(browseMatch[1]);
          sendEvent({ 
            type: 'web_browse', 
            url: browseReq.url, 
            reason: browseReq.reason 
          });

          // For now, we'll simulate web browsing - in production you'd use a real browser or API
          userResponse = `Web browsing is not fully implemented yet. Please proceed with what you've learned from the tool responses, or use standard formats like ISO codes where applicable.`;
        } catch (e) {
          userResponse = 'Failed to parse browse request.';
        }
      }

      // Check for input learned
      const inputMatches = assistantMessage.matchAll(/\[INPUT_LEARNED\]\s*(\{[\s\S]*?\})\s*\[\/INPUT_LEARNED\]/g);
      for (const match of inputMatches) {
        try {
          const inputData = JSON.parse(match[1]);
          learningState.inputsDocumented.push(inputData);
          
          sendEvent({ 
            type: 'input_documented', 
            tool: inputData.toolName, 
            inputName: inputData.inputName,
            details: inputData 
          });
        } catch (e) {
          // Ignore parse errors
        }
      }

      // Check for sub-tools created
      const subToolMatches = assistantMessage.matchAll(/\[SUB_TOOL\]\s*(\{[\s\S]*?\})\s*\[\/SUB_TOOL\]/g);
      for (const match of subToolMatches) {
        try {
          const subTool = JSON.parse(match[1]);
          learningState.subTools.push(subTool);
          
          sendEvent({ 
            type: 'subtool_created', 
            name: subTool.name,
            details: {
              description: subTool.description,
              parentTool: subTool.parentTool,
              jsonPath: subTool.jsonPath
            }
          });

          sendEvent({
            type: 'progress',
            progress: {
              phase: 'creating_subtools',
              currentTool: subTool.parentTool,
              toolIndex: learningState.currentToolIndex,
              totalTools: selectedTools.length,
              subToolsCreated: learningState.subTools.length,
              inputsDocumented: learningState.inputsDocumented.length
            }
          });
        } catch (e) {
          // Ignore parse errors
        }
      }

      // Check for workflows created
      const workflowMatches = assistantMessage.matchAll(/\[WORKFLOW\]\s*(\{[\s\S]*?\})\s*\[\/WORKFLOW\]/g);
      for (const match of workflowMatches) {
        try {
          const workflow = JSON.parse(match[1]);
          learningState.workflows.push(workflow);
          
          sendEvent({ 
            type: 'log', 
            logType: 'learning',
            message: `Created workflow: ${workflow.userTask?.substring(0, 50)}...`,
            details: {
              id: workflow.id,
              category: workflow.category,
              stepsCount: workflow.steps?.length || 0
            }
          });
        } catch (e) {
          // Ignore parse errors
        }
      }

      // Check for completion
      const completeMatch = assistantMessage.match(/\[LEARNING_COMPLETE\]\s*(\{[\s\S]*?\})\s*\[\/LEARNING_COMPLETE\]/);
      if (completeMatch) {
        try {
          const completion = JSON.parse(completeMatch[1]);
          learningState.insights = completion.insights || '';
          isComplete = true;

          // Save learnings to file
          for (const mcpName of mcpNames) {
            const mcpSubTools = learningState.subTools.filter(st => {
              const parentServer = st.parentTool.split('_')[0];
              return parentServer === mcpName;
            });

            const mcpInputs = learningState.inputsDocumented.filter(inp => {
              const toolServer = inp.toolName.split('_')[0];
              return toolServer === mcpName;
            });

            // Filter workflows that use sub-tools from this MCP
            const mcpWorkflows = learningState.workflows.filter(wf => {
              if (!wf.steps) return false;
              return wf.steps.some((step: any) => {
                const subTool = mcpSubTools.find(st => st.id === step.subTool || st.name === step.subTool);
                return !!subTool;
              });
            });

            const learning = {
              mcpName,
              version: '1.0',
              learnedAt: new Date().toISOString(),
              modelUsed: 'claude-sonnet-4',
              originalTools: selectedTools
                .filter(t => t.name.split('_')[0] === mcpName)
                .map(t => ({ name: t.name, description: t.description })),
              subTools: mcpSubTools,
              documentedInputs: mcpInputs,
              workflows: mcpWorkflows,
              insights: learningState.insights
            };

            const learningPath = path.join(LEARNINGS_DIR, `${mcpName}.json`);
            fs.writeFileSync(learningPath, JSON.stringify(learning, null, 2));
            
            sendEvent({ 
              type: 'log', 
              logType: 'info', 
              message: `Saved learnings to ${mcpName}.json` 
            });
          }

          sendEvent({ 
            type: 'complete', 
            subToolsCount: learningState.subTools.length,
            inputsCount: learningState.inputsDocumented.length,
            workflowsCount: learningState.workflows.length
          });
        } catch (e) {
          sendEvent({ type: 'log', logType: 'error', message: 'Failed to parse completion data' });
        }
      }

      // If no specific action was found, prompt to continue
      if (!userResponse && !isComplete) {
        // Check if we should move to next tool
        const currentToolMentions = selectedTools.filter(t => 
          assistantMessage.includes(t.name)
        );
        if (currentToolMentions.length > 0) {
          const lastMentioned = currentToolMentions[currentToolMentions.length - 1];
          const idx = selectedTools.findIndex(t => t.name === lastMentioned.name);
          if (idx >= 0) {
            learningState.currentToolIndex = idx;
          }
        }

        userResponse = 'Please continue with your analysis. If you\'ve finished with the current tool, move to the next one. If you\'ve explored all tools, create WORKFLOWS for practical user tasks (complex analysis, comparisons, decisions), then output [LEARNING_COMPLETE] with your summary.';
      }

      if (userResponse && !isComplete) {
        messages.push({ role: 'user', content: userResponse });
      }
    }

    if (!isComplete) {
      sendEvent({ 
        type: 'error', 
        message: 'Learning did not complete within iteration limit' 
      });
    }

    res.end();
  } catch (error: any) {
    console.error('Learning error:', error);
    sendEvent({ type: 'error', message: error.message });
    res.end();
  }
});

// ============================================================================
// PILOT SYSTEM (Two-Agent Architecture: Pilot + Executor)
// ============================================================================
// Pilot: Strategist - decides WHAT tools to use, gives natural language instructions
// Executor: Implementer - executes the tools, reports back to Pilot
// Variables persist across turns, tools are dynamically loaded for Executor
// ============================================================================

interface PilotVariable {
  name: string;
  schema: Record<string, { description: string; data_type: string }>;
  actualData: any;
  subToolId?: string;
  description: string; // Human-readable description for Pilot
}

// Type alias for backward compatibility with helper functions
type ToolCallVariable = PilotVariable;

interface PilotState {
  variables: Map<string, PilotVariable>;
  pilotHistory: Array<{ role: string; content: string }>;
  generatedDSL: string[];
  isComplete: boolean;
  finalMessage: string;
}

// Build tool summaries for Pilot (name + description + returns, no syntax)
function buildToolSummariesForPilot(): string {
  const subTools = getAllSubTools();
  
  let result = '';
  
  // Add built-in tools first
  result += `## BUILT-IN TOOLS (always available)\n\n`;
  
  result += `• llm: Ask questions about data values. Use to find specific items or analyze patterns.\n`;
  result += `  Returns: Natural language answer\n\n`;
  
  result += `• extractor: Extract specific values from data using natural language. Stores result in a variable.\n`;
  result += `  Returns: "Stored in variable" or "NOT_FOUND" (you don't see the actual value)\n\n`;
  
  result += `• table: Display data as a table with columns.\n`;
  result += `  Returns: Confirmation that table was displayed\n\n`;
  
  result += `• line-chart: Display data as a line chart.\n`;
  result += `  Returns: Confirmation that chart was displayed\n\n`;
  
  result += `• card: Display markdown content in a card.\n`;
  result += `  Returns: Confirmation that card was displayed\n\n`;
  
  if (subTools.length > 0) {
    result += `## DATA TOOLS (fetch/query data)\n\n`;
    
    for (const st of subTools) {
      const returns = (st.outputFields || []).map((f: any) => f.name).join(', ') || 'data';
      const inputs = (st.inputs || [])
        .filter((i: any) => i.required)
        .map((i: any) => i.name)
        .join(', ');
      
      result += `• ${st.id}(${inputs ? inputs : ''}): ${st.description}\n`;
      result += `  Returns: ${returns}\n`;
      
      if (st.requiresFirst && st.requiresFirst.length > 0) {
        const deps = st.requiresFirst.map((d: any) => d.subTool).join(', ');
        result += `  Requires: ${deps} first\n`;
      }
      result += '\n';
    }
  }
  
  return result;
}

// Build current data context for Pilot
function buildCurrentDataForPilot(variables: Map<string, PilotVariable>): string {
  if (variables.size === 0) {
    return '⚠️ No data fetched yet - you need to use tools to get data first.';
  }
  
  let result = `✅ YOU ALREADY HAVE ${variables.size} VARIABLE(S) - DO NOT FETCH THIS DATA AGAIN!\n\n`;
  
  for (const [name, variable] of variables) {
    const fields = Object.keys(variable.schema).join(', ');
    result += `📦 ${name}\n`;
    result += `   What it is: ${variable.description}\n`;
    result += `   Available fields: ${fields}\n\n`;
  }
  
  result += `⚠️ IMPORTANT: If you need any of the above data, just reference the variable name. DO NOT call tools to fetch it again!`;
  return result;
}

// Build the Pilot's system prompt
function buildPilotPrompt(
  currentData: string,
  toolSummaries: string
): string {
  // Get current date for the Pilot
  const now = new Date();
  const currentDate = now.toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  const isoDate = now.toISOString().split('T')[0];
  
  return `# PILOT AGENT

You are the PILOT - the strategic coordinator. You work step-by-step, making ONE decision at a time based on evidence.

📅 TODAY'S DATE: ${currentDate} (${isoDate})
Use this to calculate any date ranges you need (e.g., "last month", "November 2025", etc.)

================================================================================
## YOUR ROLE
================================================================================

You are a strategist who:
1. Understands what the user wants
2. Takes ONE STEP at a time
3. Reviews results before deciding the next step
4. Adapts your strategy based on what you learn
5. Responds to the user when the task is complete

CRITICAL - You do NOT:
- Write ANY code, brackets, or technical syntax
- See actual data values (only variable names and what exists)
- Create tables or charts in your REPLY (you can't see the data!)
- Give multi-step instructions (ONE step at a time!)

================================================================================
## HOW TO COMMUNICATE
================================================================================

You speak ONLY in natural language. NO brackets, NO code syntax, NO argument structures.

The Executor understands context and knows how to use variables. You just describe what you want in plain English.

GOOD (natural language):
- "Use extractor to find the property ID for vibefam from the properties data"
- "Get the daily traffic report using the extracted property ID for November 2025"
- "Create a line chart showing sessions over time from the daily trend data"
- "Display the traffic data as a table"

BAD (technical/code-like):
- "Use extractor with properties[display_name] and properties[property_id]" ← NO BRACKETS
- "ga_daily_trend_report(prop_id[value], start_date, end_date)" ← NO SYNTAX
- "line-chart(daily_trend.date, daily_trend.sessions)" ← NO CODE

================================================================================
## YOUR TWO OUTPUT OPTIONS
================================================================================

### OPTION 1: Instruct the Executor
Give ONE simple, straightforward instruction. The Executor can only do ONE thing at a time.

Format:
EXECUTOR: <one simple instruction>

⚠️ CRITICAL RULES:
1. ONLY ONE STEP per instruction - never combine multiple actions
2. Follow the DEPENDENCY ORDER - some tools need data from other tools first
3. Before using a value (like property_id), you MUST first:
   - Fetch the data that contains it
   - Extract the specific value using extractor
4. Keep instructions SIMPLE - describe one action

CORRECT step-by-step flow:
Step 1: EXECUTOR: Use ga_list_properties to get all available properties.
        (wait for result)
Step 2: EXECUTOR: Use extractor to find the property ID for "vibefam" from the properties.
        (wait for result)
Step 3: EXECUTOR: Use ga_daily_trend_report with the extracted property ID for November 2025.
        (wait for result)
Step 4: EXECUTOR: Create a line chart showing sessions over time from the daily trend.

WRONG - too many steps at once:
❌ EXECUTOR: Get properties, find vibefam's ID, then get daily traffic and display it.
❌ EXECUTOR: Use ga_daily_trend_report with the property ID (you don't have the ID yet!)

Each instruction = ONE action. Wait for the result before the next step.

### OPTION 2: Reply to User
When you have completed the task and displayed results to the user.

Format:
REPLY: <your response>

IMPORTANT - Your REPLY should:
- Explain what you did and your thought process
- Describe what's displayed on the canvas (tables, charts) - user can see them!
- Share insights the llm tool provided (if any)
- Suggest next steps or ask follow-up questions
- Be conversational and helpful

Your REPLY should NEVER:
- Create markdown tables (you can't see the data!)
- Show data values you don't have access to
- Pretend to display data inline (it's on the canvas)
- Include code or technical syntax

================================================================================
## UNDERSTANDING THE CANVAS
================================================================================

When you ask the Executor to create a table or chart:
- It appears on the CANVAS (a separate display area)
- The USER can see it there
- You DON'T need to recreate it in your REPLY
- Just reference it: "I've displayed a table showing..." or "The chart above shows..."

================================================================================
## ⚠️ EXISTING DATA - DO NOT REFETCH! ⚠️
================================================================================

${currentData}

================================================================================
## VARIABLE NAMING RULES
================================================================================

When asking Executor to store data, suggest DESCRIPTIVE and UNIQUE names:

GOOD variable names:
- "vibefam_properties" (specific to what it contains)
- "november_daily_traffic" (describes the time period and data type)
- "top_traffic_sources" (describes what was extracted)

BAD variable names:
- "data", "result", "temp" (too generic)
- "properties" twice (will OVERWRITE the first one!)

⚠️ NEVER reuse a variable name that already exists above - it will OVERWRITE the data!

================================================================================
## AVAILABLE TOOLS
================================================================================

Tell the Executor which tool to use in natural language.

### Data Tools
${toolSummaries}
### Processing Tools
• llm - DATA ANALYSIS AGENT: Analyzes DATA stored in VARIABLES
  - ONLY use when you have data variables to analyze
  - It performs: sum, average, max, min, count, compare, percentages, filter, sort
  - It creates charts, tables, and cards on the Canvas
  - You receive a SUMMARY of findings

  ⚠️ SCOPE: ONLY for analyzing fetched data in variables
  ✅ CORRECT: "Analyze [data_variable] and compare the trends"
  ❌ WRONG: General questions, date calculations, or anything without data variables

• extractor - Extract specific values from data into a variable
  - Use for finding specific items (like an ID from a list)
  - You DON'T see the value, just confirmation it's stored

### Display Tools (manual, if needed)
• table - Display data as a table
• line-chart - Display data as a line chart  
• card - Display markdown content
• alert - Display an important notice

NOTE: The llm tool now automatically creates visualizations. You only need these 
display tools if you want to create something specific that the analysis didn't produce.

================================================================================
## ⚠️ STEP-BY-STEP EXECUTION RULES
================================================================================

1. ONE instruction per turn - never combine multiple steps
2. Check tool dependencies in AVAILABLE TOOLS:
   - If a tool says "Requires: X first", you MUST call X first
   - You MUST have the data before you can extract from it
   - You MUST extract a value before using it in another tool
3. Wait for Executor's report before deciding the next step
4. Think: "What is the ONE thing I need to do next?"

TYPICAL FLOW:
1. Fetch data (ga_list_properties, etc.)
2. Extract specific value (extractor)
3. Use extracted value in next tool
4. Display results (table, chart)
5. Analyze if needed (llm)
6. Reply to user

================================================================================
## GUIDELINES
================================================================================

1. Speak in natural language only - no code, no brackets, no syntax
2. ONE STEP at a time - simple, straightforward instructions
3. Reference variables by name - Executor handles the technical details
4. Follow tool dependencies - fetch → extract → use → display
5. Display tools show on Canvas - don't recreate in REPLY
6. Your REPLY explains and describes - never fabricates data

================================================================================
## ❌ DO NOT USE llm FOR THESE
================================================================================

The llm tool is STRICTLY for analyzing DATA stored in VARIABLES.

DO NOT use llm for:
- Date ranges or date formatting (you know how dates work)
- Simple calculations or conversions
- General knowledge questions
- Anything that doesn't involve analyzing fetched data variables

ONLY use llm when you have actual data variables to analyze!

================================================================================

Based on the user's request and available data, what is your NEXT SINGLE STEP?
Output either EXECUTOR: <one instruction> or REPLY: <message>`;
}

// Extract tools mentioned in Pilot's instruction
function extractMentionedTools(instruction: string): string[] {
  const subTools = getAllSubTools();
  const mentioned: string[] = [];
  
  const instructionLower = instruction.toLowerCase();
  
  for (const st of subTools) {
    if (instructionLower.includes(st.id.toLowerCase()) || 
        instructionLower.includes(st.name.toLowerCase())) {
      mentioned.push(st.id);
    }
  }
  
  // Also check for built-in tools
  if (instructionLower.includes('llm')) mentioned.push('llm');
  if (instructionLower.includes('extractor') || instructionLower.includes('extract')) mentioned.push('extractor');
  if (instructionLower.includes('table')) mentioned.push('table');
  if (instructionLower.includes('line-chart') || instructionLower.includes('chart')) mentioned.push('line-chart');
  if (instructionLower.includes('card')) mentioned.push('card');
  if (instructionLower.includes('alert')) mentioned.push('alert');
  
  return [...new Set(mentioned)]; // Remove duplicates
}

// Build full docs for specific tools (for Executor)
function buildToolDocsForExecutor(toolIds: string[]): string {
  let result = '';
  
  for (const toolId of toolIds) {
    // Check if it's a sub-tool
    const subTool = findSubTool(toolId);
    if (subTool) {
      // Build call signature
      let callSignature = subTool.id + '(';
      const argParts: string[] = [];
      
      for (const inp of subTool.inputs || []) {
        let argStr = inp.name + ': ';
        if (inp.required) {
          argStr += '<required';
        } else {
          argStr += '<optional';
        }
        
        if (inp.type === 'enum' && inp.options && inp.options.length > 0) {
          const optionValues = inp.options.slice(0, 5).map((o: any) => `"${o.value || o}"`).join(' | ');
          argStr += ': ' + optionValues;
        } else if (inp.format) {
          argStr += ': ' + inp.format;
        }
        argStr += '>';
        argParts.push(argStr);
      }
      callSignature += argParts.join(', ') + ')';
      
      const outputFields = (subTool.outputFields || []).map((f: any) => f.name);
      const accessExamples = outputFields.length > 0
        ? outputFields.map((f: string) => `<var>[${f}]`).join(', ')
        : '<var>';
      
      result += `### ${subTool.id}\n`;
      result += `${subTool.description}\n\n`;
      result += `Syntax: \`variable: ${callSignature}\`\n`;
      result += `Returns: ${outputFields.join(', ') || 'data'}\n`;
      result += `Access: ${accessExamples}\n`;
      
      if (subTool.requiresFirst && subTool.requiresFirst.length > 0) {
        result += `Requires: `;
        for (const dep of subTool.requiresFirst) {
          result += `${dep.extractField} from ${dep.subTool}\n`;
        }
      }
      
      // Add input details
      if (subTool.inputs && subTool.inputs.length > 0) {
        result += `\nInputs:\n`;
        for (const inp of subTool.inputs) {
          const req = inp.required ? '(required)' : '(optional)';
          result += `  • ${inp.name} ${req}: ${inp.description || inp.type}\n`;
          if (inp.type === 'enum' && inp.options) {
            const opts = inp.options.map((o: any) => `"${o.value || o}"`).join(', ');
            result += `    Options: ${opts}\n`;
          }
        }
      }
      result += '\n';
    }
    
    // Built-in tools
    if (toolId === 'llm') {
      result += `### llm (Data Analysis Agent)
Powerful analysis tool that performs calculations and creates visualizations automatically.

Syntax: \`llm(data: [var1, var2], question: "analysis request in natural language")\`

What it can do:
- Aggregations: sum, average, max, min, count
- Comparisons: difference, ratio, percentage, percentage change
- Transformations: filter, sort
- Arithmetic on columns: add, subtract, multiply, divide
- Create tables and charts automatically

Returns: Summary of findings + visualizations on Canvas

Example: \`llm(data: [march_sales, april_sales], question: "Compare March and April revenue, show the trend and highlight key differences")\`

The agent will:
1. Calculate relevant metrics
2. Create appropriate charts/tables
3. Return a summary of key findings

`;
    }
    
    if (toolId === 'extractor') {
      result += `### extractor
Extract specific values from data and store in a variable. Use natural language to describe what to extract.

Syntax: \`result: extractor(data: [var[field1], var[field2]], extract: "natural language description")\`

IMPORTANT:
- The extract argument should be NATURAL LANGUAGE, not code
- You will NOT see the extracted value - it's stored in the variable
- Response will be: "Stored in 'result'" or "NOT_FOUND"
- Use result[value] in subsequent tool calls to pass the extracted data

Good examples:
- \`prop_id: extractor(data: [properties[display_name], properties[property_id]], extract: "find the property_id for the one named vibefam")\`
- \`max_sessions: extractor(data: [report[date], report[sessions]], extract: "the date with the highest sessions")\`

Bad examples (don't use code syntax):
- extract: "property_id WHERE display_name = 'vibefam'" ← Too code-like
- extract: "filter(x => x.name == 'test')" ← Don't use code

`;
    }
    
    if (toolId === 'table') {
      result += `### table
Display data as a table with columns.

Syntax: \`table({column_name: "Label", data: var[field]}, ...)\`
Returns: Confirmation that table was displayed

Example: \`table({column_name: "Date", data: report[date]}, {column_name: "Value", data: report[value]})\`

`;
    }
    
    if (toolId === 'line-chart') {
      result += `### line-chart
Display data as a line chart.

Syntax: \`line-chart(x_data: var[x_field], y_data: var[y_field], x_label: "X Axis", y_label: "Y Axis", colour: "#3b82f6")\`
Returns: Confirmation that chart was displayed

`;
    }
    
    if (toolId === 'card') {
      result += `### card
Display markdown content in a card.

Syntax: \`card("## Title\\n\\nYour markdown content here")\`
Returns: Confirmation that card was displayed

`;
    }
    
    if (toolId === 'alert') {
      result += `### alert
Display an important notice or warning.

Syntax: \`alert("Important message here")\`
Returns: Confirmation that alert was displayed

`;
    }
  }
  
  return result || '(No specific tool docs available)';
}

// Build the Executor's system prompt
function buildExecutorPrompt(
  task: string,
  toolDocs: string,
  variablesContext: string,
  progressLog: string
): string {
  return `# EXECUTOR AGENT

You translate the Pilot's natural language instructions into actual tool calls.

================================================================================
## TASK FROM PILOT (Natural Language)
================================================================================

${task}

================================================================================
## YOUR JOB
================================================================================

1. Understand what the Pilot wants (they speak in natural language)
2. Translate it into the proper tool call syntax
3. Figure out which variables to use and how to access them
4. Execute ONE tool call

The Pilot says things like:
- "Get the property ID for vibefam" → You write: prop_id: extractor(data: [properties[display_name], properties[property_id]], extract: "find the property_id for vibefam")
- "Create a table showing the daily data" → You write: table({column_name: "Date", data: daily[date]}, {column_name: "Sessions", data: daily[sessions]})
- "Get traffic for November using the property ID" → You write: traffic: ga_daily_trend_report(property_id: prop_id[value], start_date: "2025-11-01", end_date: "2025-11-30")

================================================================================
## TOOL DOCUMENTATION
================================================================================

${toolDocs}

================================================================================
## EXISTING VARIABLES (Use these - DON'T refetch!)
================================================================================

${variablesContext || '(No variables yet - you will create them)'}

================================================================================
## ⚠️ VARIABLE NAMING RULES
================================================================================

When creating NEW variables, use DESCRIPTIVE and UNIQUE names:
- GOOD: vibefam_property_id, november_traffic, daily_sessions_trend
- BAD: data, result, prop, temp (too generic)

⚠️ NEVER reuse a variable name that exists above - it will OVERWRITE the data!
⚠️ Check the existing variables before naming a new one!

================================================================================
## SYNTAX REFERENCE
================================================================================

Store result in variable:
\`variable_name: tool_name(arg: value, arg2: value2)\`

Access variable data:
\`variable_name[field_name]\`

For extractor (use natural language for extract):
\`result: extractor(data: [var[field1], var[field2]], extract: "natural language description")\`

For table:
\`table({column_name: "Label", data: var[field]}, ...)\`

For line-chart:
\`line-chart(x_data: var[x_field], y_data: var[y_field], x_label: "X", y_label: "Y", colour: "#3b82f6")\`

================================================================================
## YOUR OUTPUT
================================================================================

Write ONE tool call that accomplishes what the Pilot asked.
Then write DONE: with a brief summary.

Format:
<tool call>
DONE: <what was accomplished>

================================================================================

Now write the tool call for this task:`;
}

// Keep the old buildToolCallingAgentPrompt for the API endpoint that shows prompts
function buildToolCallingAgentPrompt(): string {
  // Use call-syntax format for tool-calling agent (more intuitive for this mode)
  const subToolDocs = buildSubToolDocsForToolCallingAgent();

  return `# TOOL-CALLING AGENT

You are an AI agent that completes tasks by executing tool calls. You communicate ONLY through tool calls - never plain text.

================================================================================
## HOW THE SYSTEM WORKS
================================================================================

This is a turn-based loop:

1. You write ONE tool call
2. System executes it and responds with what you can now use
3. You write your NEXT tool call based on the response
4. Repeat until you call reply_user() to end

**Your output:** Exactly ONE tool call per turn. No text, no explanation - just the tool call.

**System response format:** After each tool call, you'll see something like:
\`✓ Stored in 'accounts'. You can now use: accounts[account_id], accounts[display_name], accounts[property_count]\`

This means the data is stored and you can use those references in your next tool call.

================================================================================
## VARIABLES
================================================================================

### What is a Variable?

A variable is a named container that stores data from a tool call. Variables allow you to:
- Store data fetched from APIs
- Reference that data in subsequent tool calls
- Pass data between different tools

### Creating Variables

Syntax: \`variable_name: tool_name(arguments)\`

When you make a tool call with a name before the colon, the result is stored in that variable.

### Variable Naming Guidelines

**Format:** Use snake_case (lowercase with underscores)
- Good: \`account_list\`, \`monthly_report\`, \`search_result\`
- Bad: \`AccountList\`, \`monthly-report\`, \`searchResult\`

**Be Descriptive:** The name should indicate what data is stored
- Good: \`property_list\`, \`session_counts\`, \`page_views\`
- Bad: \`data\`, \`result\`, \`temp\`, \`x\`

**Be Specific:** Include context when helpful
- Good: \`last_30_days_traffic\`, \`top_10_pages\`, \`organic_sessions\`
- Bad: \`traffic\`, \`pages\`, \`sessions\`

**Be Unique:** Never reuse a variable name - it will overwrite the previous data

### Tool Responses

When you call a data tool, the system responds with:
\`✓ Stored in 'variable_name'. You can now use: variable_name[field1], variable_name[field2], ...\`

This tells you:
- The data was successfully retrieved
- Which fields are available to reference
- The exact syntax to use those fields

**IMPORTANT:** You don't see the actual values - only what fields exist. The data IS stored in the variable.

### Referencing Variable Data

Syntax: \`variable_name[field_name]\`

This creates a reference to a specific field in the variable. The reference is resolved when the tool using it is executed.

Use references in:
- **llm tool**: To inspect actual values (e.g., find a specific item by name)
- **UI tools**: To display values to the user
- **Other data tools**: To pass values as arguments (e.g., use property_id from one tool in another)

================================================================================
## THE llm TOOL
================================================================================

### Purpose

The llm tool is your way to SEE and QUERY actual data values. Since you only see schemas, the llm tool bridges the gap by letting you ask questions about the actual data.

### Syntax

\`result_var: llm(data: [var1[field1], var2[field2], ...], question: "your question")\`

### How It Works

1. You provide variable references (e.g., \`my_data[name]\`, \`my_data[id]\`)
2. System retrieves the ACTUAL values from those references
3. System sends the values + your question to an LLM
4. LLM analyzes the data and answers your question
5. The answer is returned to you as a string

### When to Use llm

Use llm when you need to:
- Find a specific item by name in a list
- Search or filter data based on criteria
- Calculate statistics or identify patterns
- Answer any question about actual data content

Do NOT use llm for:
- Making strategic decisions (that's your job)
- Deciding what to do next (that's your job)

The llm is your data analyst assistant - ask it factual questions about the data.

================================================================================
## DATA TOOLS
================================================================================

These tools fetch data from external sources. When called, they:
1. Execute the API request
2. Store the result in your variable
3. Return a schema showing available fields

${subToolDocs}

================================================================================
## UI TOOLS
================================================================================

These tools display information to the user. The user CAN see the actual values.

### table
Display data as a table with columns.
\`var: table({column_name: "Label", data: variable[field]}, ...)\`

### line-chart
Display data as a line chart.
\`var: line-chart(x_data: var[x], y_data: var[y], x_label: "X", y_label: "Y", colour: #hexcode)\`

### card
Display markdown content in a card format.
\`card("## Title\\n\\nMarkdown content here")\`

### alert
Display an important notice or warning.
\`alert("## Notice\\n\\nImportant information")\`

================================================================================
## RESPONSE TOOL
================================================================================

### reply_user
End the interaction and explain your findings to the user.
\`reply_user("## Summary\\n\\nYour explanation in markdown")\`

This MUST be your final tool call. Include:
- What you found or accomplished
- What was displayed (if anything)
- Key insights or answers
- Suggested follow-up questions

================================================================================
## APPROACH GUIDELINES
================================================================================

### When User Asks About Specific Names/Values

If the user mentions something specific (a name, ID, value), you need to:
1. First, fetch the relevant data into a variable
2. Use llm() to find/identify the specific item in that data
3. Then proceed with what they asked

You cannot skip the llm step because you cannot see the actual values to find what they're looking for.

### When User Asks to Display Data

1. Fetch the data into a variable
2. Use appropriate UI tools (table, chart, card) to display it
3. Use reply_user() to explain what was shown

### When User Asks Analytical Questions

1. Fetch the relevant data
2. Use llm() to analyze the data and answer the question
3. Optionally display supporting visualizations
4. Use reply_user() to present the findings

### General Flow

1. Understand what data you need
2. Fetch it using data tools (creates variables with schemas)
3. If you need to inspect values, use llm()
4. If you need to display to user, use UI tools
5. Always end with reply_user()

================================================================================
## RULES
================================================================================

1. ONE tool call per turn - no text, just the tool call
2. Use snake_case for all variable names
3. Use unique, descriptive variable names
4. You see schemas, not actual data - use llm() to inspect values
5. When user mentions specific names/values, use llm() to find them
6. Variables persist throughout the session
7. ALWAYS end with reply_user()

================================================================================

Write your first tool call now.`;
}

// Parse tool calls from agent response
function parseToolCalls(response: string): Array<{
  variableName: string | null;
  toolName: string;
  args: Record<string, any> | string;
  raw: string;
}> {
  const calls: Array<{variableName: string | null; toolName: string; args: any; raw: string}> = [];
  
  // First, try to find multi-line tool calls (tool calls that span multiple lines)
  // Pattern: var: tool_name(\n  args\n) or tool_name(\n  args\n)
  const multiLinePattern = /(?:([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*)?([a-zA-Z_][a-zA-Z0-9_-]*)\s*\(([\s\S]*?)\)/g;
  let multiMatch;
  
  while ((multiMatch = multiLinePattern.exec(response)) !== null) {
    const [fullMatch, varName, toolName, argsStr] = multiMatch;
    
    // Skip if this looks like a comment or example
    if (fullMatch.includes('→') || fullMatch.includes('SYSTEM RETURNS')) continue;
    
    // Clean up the args string (remove extra whitespace from multi-line)
    const cleanedArgs = argsStr.replace(/\n\s*/g, ' ').trim();
    
    let args: any;
    // Check if it's a single string argument
    if (cleanedArgs.startsWith('"') || cleanedArgs.startsWith("'")) {
      args = cleanedArgs.replace(/^["']|["']$/g, '');
    } else if (cleanedArgs.startsWith('{')) {
      args = cleanedArgs;
    } else {
      // Key-value pairs
      args = {};
      const kvPairs: string[] = [];
      let current = '';
      let bracketDepth = 0;
      
      for (const char of cleanedArgs) {
        if (char === '[') bracketDepth++;
        else if (char === ']') bracketDepth--;
        
        if (char === ',' && bracketDepth === 0) {
          kvPairs.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      if (current.trim()) {
        kvPairs.push(current.trim());
      }
      
      for (const pair of kvPairs) {
        const kvMatch = pair.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*[:=]\s*([\s\S]+)$/);
        if (kvMatch) {
          const [, key, value] = kvMatch;
          args[key] = value.trim().replace(/^["']|["']$/g, '');
        }
      }
    }
    
    calls.push({
      variableName: varName || null,
      toolName,
      args,
      raw: fullMatch.trim()
    });
  }
  
  // If multi-line parsing found calls, return them
  if (calls.length > 0) {
    console.log(`[parseToolCalls] Found ${calls.length} tool call(s) via multi-line parsing`);
    return calls;
  }
  
  // Fallback: line-by-line parsing for single-line tool calls
  // Pattern: var: tool_name(args) or tool_name(args)
  // Args can be key: value pairs or a single string (for card, alert, reply_user)
  const lines = response.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('→') || trimmed.startsWith('```') || trimmed.startsWith('DONE:')) continue;
    
    // Match: variable: tool(args) or tool(args)
    const match = trimmed.match(/^(?:([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*)?([a-zA-Z_][a-zA-Z0-9_-]*)\s*\(([\s\S]*)\)$/);
    if (match) {
      const [, varName, toolName, argsStr] = match;
      
      let args: any;
      // Check if it's a single string argument (for card, alert, reply_user)
      if (argsStr.trim().startsWith('"') || argsStr.trim().startsWith("'")) {
        // Single string argument
        args = argsStr.trim().replace(/^["']|["']$/g, '');
      } else if (argsStr.trim().startsWith('{')) {
        // Table format: {column_name: "X", data: var[key]}, ...
        args = argsStr;
      } else {
        // Key-value pairs: key: value, key2: value2
        // Need to handle arrays like [var[field1], var[field2]] without splitting them
        args = {};
        
        // Smart split: track bracket depth
        const kvPairs: string[] = [];
        let current = '';
        let bracketDepth = 0;
        
        for (const char of argsStr) {
          if (char === '[') bracketDepth++;
          else if (char === ']') bracketDepth--;
          
          if (char === ',' && bracketDepth === 0) {
            kvPairs.push(current.trim());
            current = '';
          } else {
            current += char;
          }
        }
        if (current.trim()) {
          kvPairs.push(current.trim());
        }
        
        for (const pair of kvPairs) {
          // Support both colon (:) and equals (=) as key-value separators
          // e.g., "property_id: value" or "property_id=value"
          const kvMatch = pair.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*[:=]\s*([\s\S]+)$/);
          if (kvMatch) {
            const [, key, value] = kvMatch;
            args[key] = value.trim().replace(/^["']|["']$/g, '');
          }
        }
      }
      
      calls.push({
        variableName: varName || null,
        toolName,
        args,
        raw: trimmed
      });
    }
  }
  
  return calls;
}

// Resolve variable references like "variable[key]" to actual data
function resolveVariableRef(
  ref: string, 
  variables: Map<string, ToolCallVariable>
): any {
  console.log(`[resolveVariableRef] Resolving: "${ref}"`);
  console.log(`[resolveVariableRef] Available variables: ${Array.from(variables.keys()).join(', ')}`);
  
  // Check if it's a variable reference: varName[key]
  const refMatch = ref.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([a-zA-Z_][a-zA-Z0-9_]*)\]$/);
  if (refMatch) {
    const [, varName, key] = refMatch;
    console.log(`[resolveVariableRef] Parsed: varName="${varName}", key="${key}"`);
    
    const variable = variables.get(varName);
    if (!variable) {
      console.log(`[resolveVariableRef] Variable "${varName}" not found!`);
      return ref;
    }
    
    console.log(`[resolveVariableRef] Variable found. Has actualData: ${!!variable.actualData}`);
    console.log(`[resolveVariableRef] actualData type: ${typeof variable.actualData}`);
    console.log(`[resolveVariableRef] actualData is array: ${Array.isArray(variable.actualData)}`);
    if (variable.actualData) {
      console.log(`[resolveVariableRef] actualData preview: ${JSON.stringify(variable.actualData)?.slice(0, 500)}`);
    }
    
    if (variable && variable.actualData) {
      // The actualData is ALREADY EXTRACTED by subTool.jsonPath
      // So we just need to access the field directly on the extracted data
      
      // If it's an array of objects, map to get the field from each
      if (Array.isArray(variable.actualData)) {
        const result = variable.actualData.map(item => {
          if (item && typeof item === 'object') {
            return item[key];
          }
          return undefined;
        }).filter(x => x !== undefined);
        console.log(`[resolveVariableRef] Extracted from array: ${JSON.stringify(result)?.slice(0, 300)}`);
        return result;
      }
      
      // If it's a single object, access the field directly
      if (typeof variable.actualData === 'object' && variable.actualData !== null) {
        const result = variable.actualData[key];
        console.log(`[resolveVariableRef] Extracted from object: ${JSON.stringify(result)?.slice(0, 300)}`);
        return result;
      }
      
      console.log(`[resolveVariableRef] Could not extract field "${key}" from data`);
      return undefined;
    }
  } else {
    console.log(`[resolveVariableRef] Not a variable reference pattern`);
  }
  return ref; // Return as-is if not a variable reference
}

// Pilot System specific unwrap - handles double-encoded JSON
// This is separate from the multi-agent system's unwrapMCPResponse to avoid breaking it
function unwrapMCPResponseForPilot(response: any): any {
  if (!response) return response;
  
  // Check if this is the standard MCP format with content array
  if (response.content && Array.isArray(response.content) && response.content.length > 0) {
    console.log(`[Pilot Unwrap] Found MCP content array with ${response.content.length} items`);
    
    const results: any[] = [];
    
    for (const contentItem of response.content) {
      if (contentItem.type === 'text' && typeof contentItem.text === 'string') {
        try {
          const parsed = JSON.parse(contentItem.text);
          results.push(parsed);
        } catch (e) {
          results.push(contentItem.text);
        }
      } else if (contentItem.text) {
        try {
          results.push(JSON.parse(contentItem.text));
        } catch (e) {
          results.push(contentItem.text);
        }
      } else if (contentItem.data) {
        results.push(contentItem.data);
      }
    }
    
    if (results.length > 0) {
      let finalResult = results.length === 1 ? results[0] : results;
      
      // Handle double-encoded JSON (string that's actually JSON)
      if (typeof finalResult === 'string') {
        try {
          const parsed = JSON.parse(finalResult);
          console.log(`[Pilot Unwrap] Double-encoded JSON detected, parsing again`);
          finalResult = parsed;
        } catch (e) {
          // Not JSON, keep as string
        }
      }
      
      console.log(`[Pilot Unwrap] Extracted ${results.length} item(s). Type: ${Array.isArray(finalResult) ? 'array' : typeof finalResult}`);
      if (typeof finalResult === 'object' && finalResult !== null) {
        console.log(`[Pilot Unwrap] Top-level keys: ${Object.keys(finalResult).slice(0, 10).join(', ')}`);
      }
      return finalResult;
    }
  }
  
  // Check if response itself is a string that needs parsing
  if (typeof response === 'string') {
    try {
      let parsed = JSON.parse(response);
      // Handle double-encoding here too
      if (typeof parsed === 'string') {
        try {
          parsed = JSON.parse(parsed);
        } catch (e) {}
      }
      return parsed;
    } catch (e) {
      return response;
    }
  }
  
  return response;
}

// Navigate a nested path like "dimension_values[0].value" to get the value
function getNestedValue(obj: any, path: string): any {
  if (!obj || !path) return undefined;
  
  // Parse path segments - handle both dots and array brackets
  // e.g., "dimension_values[0].value" -> ["dimension_values", "0", "value"]
  const segments = path.split(/\.|\[|\]/).filter(s => s !== '');
  
  let current = obj;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    
    // Handle array index (numeric string)
    if (/^\d+$/.test(segment)) {
      current = current[parseInt(segment, 10)];
    } else {
      current = current[segment];
    }
  }
  
  return current;
}

// Transform raw data to use schema field names based on outputFields mapping
// This handles the case where raw data has different field names (e.g., "property") 
// than the schema exposes (e.g., "property_id")
// Also handles nested paths like "dimension_values[0].value"
function transformDataToSchemaNames(
  rawData: any,
  outputFields: Array<{ name: string; path?: string; type?: string; description?: string }>
): any {
  if (!outputFields || outputFields.length === 0) {
    return rawData;
  }
  
  // Build a mapping from raw field path to schema field name
  // path: "$.property" -> schema name: "property_id"
  // path: "$.dimension_values[0].value" -> schema name: "date"
  const fieldMapping: Array<{ rawPath: string; schemaName: string }> = [];
  
  for (const field of outputFields) {
    if (field.path) {
      // Remove leading $. from path
      const rawPath = field.path.replace(/^\$\./, '');
      fieldMapping.push({ rawPath, schemaName: field.name });
    } else {
      // If no path, assume the field name matches
      fieldMapping.push({ rawPath: field.name, schemaName: field.name });
    }
  }
  
  console.log(`[transformData] Field mapping: ${JSON.stringify(Object.fromEntries(fieldMapping.map(m => [m.rawPath, m.schemaName])))}`);
  
  // Transform the data
  if (Array.isArray(rawData)) {
    return rawData.map(item => {
      if (typeof item === 'object' && item !== null) {
        const transformed: Record<string, any> = {};
        
        // For each field in the mapping, extract from raw and use schema name
        for (const { rawPath, schemaName } of fieldMapping) {
          // First try direct property access (for simple paths like "property")
          if (rawPath in item) {
            transformed[schemaName] = item[rawPath];
          } else {
            // Try nested path access (for paths like "dimension_values[0].value")
            const value = getNestedValue(item, rawPath);
            if (value !== undefined) {
              transformed[schemaName] = value;
            }
          }
        }
        
        return transformed;
      }
      return item;
    });
  } else if (typeof rawData === 'object' && rawData !== null) {
    const transformed: Record<string, any> = {};
    
    for (const { rawPath, schemaName } of fieldMapping) {
      // First try direct property access
      if (rawPath in rawData) {
        transformed[schemaName] = rawData[rawPath];
      } else {
        // Try nested path access
        const value = getNestedValue(rawData, rawPath);
        if (value !== undefined) {
          transformed[schemaName] = value;
        }
      }
    }
    
    return transformed;
  }
  
  return rawData;
}

// Execute a sub-tool and return schema
async function executeSubToolForAgent(
  subToolId: string,
  args: Record<string, any>,
  variables: Map<string, ToolCallVariable>,
  sendEvent: (data: any) => void
): Promise<{ schema: Record<string, any>; actualData: any } | null> {
  const subTool = getAllSubTools().find(st => st.id === subToolId);
  if (!subTool) {
    sendEvent({ type: 'tool_error', tool: subToolId, error: 'Sub-tool not found' });
    return null;
  }
  
  // Resolve any variable references in args
  const resolvedArgs: Record<string, any> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      resolvedArgs[key] = resolveVariableRef(value, variables);
    } else {
      resolvedArgs[key] = value;
    }
  }
  
  // Build parent tool args - deep copy defaults to handle nested structures
  const parentArgs: Record<string, any> = JSON.parse(JSON.stringify(subTool.parentToolDefaultArgs || {}));
  
  console.log(`\n${'='.repeat(70)}`);
  console.log(`📥 PILOT SYSTEM INPUT MAPPING: ${subToolId}`);
  console.log(`${'='.repeat(70)}`);
  console.log(`   Resolved args from executor: ${JSON.stringify(resolvedArgs, null, 2)}`);
  console.log(`   Parent tool defaults: ${JSON.stringify(subTool.parentToolDefaultArgs, null, 2)}`);
  console.log(`   Sub-tool inputs expected:`);
  for (const input of subTool.inputs || []) {
    console.log(`     - ${input.name} (required: ${input.required}) -> mapToParentArg: ${input.mapToParentArg || input.name}`);
  }
  
  // Map sub-tool inputs to parent tool args
  // Handle nested paths like "date_ranges[0].start_date"
  for (const input of subTool.inputs || []) {
    if (resolvedArgs[input.name] !== undefined) {
      const targetPath = input.mapToParentArg || input.name;
      console.log(`   Mapping: ${input.name} = "${resolvedArgs[input.name]}" -> ${targetPath}`);
      setNestedValue(parentArgs, targetPath, resolvedArgs[input.name]);
    } else {
      console.log(`   MISSING: ${input.name} (required: ${input.required})`);
    }
  }
  
  console.log(`   Final parentArgs: ${JSON.stringify(parentArgs, null, 2)}`);
  console.log(`${'='.repeat(70)}\n`);
  
  sendEvent({ 
    type: 'tool_calling', 
    tool: subToolId, 
    parentTool: subTool.parentTool,
    args: parentArgs 
  });
  
  try {
    // Call parent MCP tool
    const rawResult = await mcpManager.callTool(subTool.parentTool, parentArgs);
    const unwrapped = unwrapMCPResponseForPilot(rawResult);
    
    console.log(`\n${'='.repeat(70)}`);
    console.log(`🔧 PILOT SYSTEM DATA EXTRACTION: ${subToolId}`);
    console.log(`${'='.repeat(70)}`);
    console.log(`   JSONPath: ${subTool.jsonPath || '(none)'}`);
    console.log(`   Unwrapped data type: ${typeof unwrapped}`);
    if (typeof unwrapped === 'object' && unwrapped !== null) {
      console.log(`   Unwrapped data keys: ${Object.keys(unwrapped).slice(0, 10).join(', ')}`);
    }
    console.log(`   Unwrapped data sample: ${JSON.stringify(unwrapped).slice(0, 500)}`);
    
    // Apply JSONPath extraction
    let extractedData = unwrapped;
    if (subTool.jsonPath) {
      extractedData = extractByPath(unwrapped, subTool.jsonPath);
      console.log(`   After JSONPath extraction:`);
      console.log(`     Type: ${typeof extractedData}`);
      console.log(`     Is Array: ${Array.isArray(extractedData)}`);
      console.log(`     Sample: ${JSON.stringify(extractedData).slice(0, 500)}`);
    }
    
    // Build schema from outputFields
    const schema: Record<string, any> = {};
    for (const field of subTool.outputFields || []) {
      schema[field.name] = {
        description: field.description || field.name,
        data_type: field.type || 'string',
        sourcePath: field.path || null // Store the source path for reference
      };
    }
    
    // Transform the extracted data to use schema field names instead of raw field names
    // This maps from outputField.path (e.g., "$.property") to outputField.name (e.g., "property_id")
    const transformedData = transformDataToSchemaNames(extractedData, subTool.outputFields || []);
    
    console.log(`   After field transformation:`);
    console.log(`     Type: ${typeof transformedData}`);
    console.log(`     Is Array: ${Array.isArray(transformedData)}`);
    console.log(`     Sample: ${JSON.stringify(transformedData).slice(0, 500)}`);
    console.log(`${'='.repeat(70)}\n`);
    
    sendEvent({ 
      type: 'tool_success', 
      tool: subToolId,
      schemaKeys: Object.keys(schema)
    });
    
    return { schema, actualData: transformedData };
  } catch (error: any) {
    sendEvent({ type: 'tool_error', tool: subToolId, error: error.message });
    return null;
  }
}

// Execute LLM assistant tool
async function executeLLMTool(
  dataRefs: string[],
  question: string,
  variables: Map<string, ToolCallVariable>,
  model: string,
  sendEvent: (data: any) => void
): Promise<string> {
  const client = createOpenRouterClient();
  
  console.log(`[executeLLMTool] Called with dataRefs: ${JSON.stringify(dataRefs)}`);
  console.log(`[executeLLMTool] Question: ${question}`);
  console.log(`[executeLLMTool] Variables available: ${Array.from(variables.keys()).join(', ')}`);
  
  // Group refs by variable name to detect when multiple fields from same variable are requested
  const refsByVariable: Map<string, string[]> = new Map();
  for (const ref of dataRefs) {
    const match = ref.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([a-zA-Z_][a-zA-Z0-9_]*)\]$/);
    if (match) {
      const [, varName, field] = match;
      if (!refsByVariable.has(varName)) {
        refsByVariable.set(varName, []);
      }
      refsByVariable.get(varName)!.push(field);
    }
  }
  
  // Build data context - show paired records when multiple fields from same variable
  let dataContext = '';
  
  // Helper to find a field in an object, trying different naming conventions
  const findField = (obj: any, fieldName: string): any => {
    if (!obj || typeof obj !== 'object') return undefined;
    
    // Direct match
    if (fieldName in obj) return obj[fieldName];
    
    // Try camelCase version (property_id -> propertyId)
    const camelCase = fieldName.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (camelCase in obj) return obj[camelCase];
    
    // Try snake_case version (propertyId -> property_id)
    const snakeCase = fieldName.replace(/([A-Z])/g, '_$1').toLowerCase();
    if (snakeCase in obj) return obj[snakeCase];
    
    // Try case-insensitive match
    const lowerFieldName = fieldName.toLowerCase();
    for (const key of Object.keys(obj)) {
      if (key.toLowerCase() === lowerFieldName) return obj[key];
    }
    
    return undefined;
  };
  
  for (const [varName, fields] of refsByVariable) {
    const variable = variables.get(varName);
    if (!variable || !variable.actualData) {
      dataContext += `\n${varName}: (no data found)\n`;
      continue;
    }
    
    console.log(`[executeLLMTool] Processing variable "${varName}" with fields: ${fields.join(', ')}`);
    console.log(`[executeLLMTool] actualData sample: ${JSON.stringify(variable.actualData).slice(0, 500)}`);
    
    // If it's an array, show ALL the data with ALL fields for better context
    if (Array.isArray(variable.actualData)) {
      // Get all available field names from the first item
      const firstItem = variable.actualData[0];
      const availableFields = firstItem && typeof firstItem === 'object' 
        ? Object.keys(firstItem) 
        : [];
      
      console.log(`[executeLLMTool] Available fields in data: ${availableFields.join(', ')}`);
      
      // Show all records with all their fields for complete context
      const records = variable.actualData.map((item, idx) => {
        if (typeof item === 'object' && item !== null) {
          // Include all fields from the requested list
          const record: Record<string, any> = {};
          for (const field of fields) {
            const value = findField(item, field);
            record[field] = value;
          }
          return record;
        }
        return item;
      });
      
      // Check if we got any actual data
      const hasData = records.some(r => {
        if (typeof r === 'object' && r !== null) {
          return Object.values(r).some(v => v !== undefined && v !== null);
        }
        return r !== undefined && r !== null;
      });
      
      if (!hasData && firstItem && typeof firstItem === 'object') {
        // Field names didn't match - show raw data with actual field names
        console.log(`[executeLLMTool] Fields not found, showing raw data`);
        dataContext += `\n${varName} (raw data - requested fields "${fields.join(', ')}" not found, showing all):\n`;
        dataContext += JSON.stringify(variable.actualData.slice(0, 20), null, 2).slice(0, 4000) + '\n';
        if (variable.actualData.length > 20) {
          dataContext += `... and ${variable.actualData.length - 20} more items\n`;
        }
      } else {
        dataContext += `\n${varName} (${fields.join(', ')}):\n`;
        dataContext += JSON.stringify(records, null, 2).slice(0, 4000) + '\n';
      }
    }
    // Object data - show fields directly
    else if (typeof variable.actualData === 'object' && variable.actualData !== null) {
      console.log(`[executeLLMTool] Object data keys: ${Object.keys(variable.actualData).join(', ')}`);
      for (const field of fields) {
        const value = findField(variable.actualData, field);
        dataContext += `\n${varName}[${field}]:\n`;
        dataContext += JSON.stringify(value, null, 2).slice(0, 1000) + '\n';
      }
    }
  }
  
  console.log(`[executeLLMTool] Final dataContext:\n${dataContext.slice(0, 1000)}`);
  
  sendEvent({ type: 'llm_calling', question, dataRefs, dataContext: dataContext.slice(0, 500) });
  
  const prompt = `You are a data analysis assistant. Answer the following question about the data provided.

IMPORTANT: Only answer factual questions about patterns, trends, and comparisons in the data. Do NOT strategize, recommend, or make business decisions - just report what the data shows.

DATA:
${dataContext}

QUESTION: ${question}

Provide a clear, concise answer based only on the data provided.`;

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 500
    });
    
    const answer = response.choices[0]?.message?.content || 'Unable to analyze data';
    sendEvent({ type: 'llm_response', answer: answer.slice(0, 200) });
    return answer;
  } catch (error: any) {
    sendEvent({ type: 'llm_error', error: error.message });
    return `Error analyzing data: ${error.message}`;
  }
}

// Execute Extractor tool - extracts specific values from data
async function executeExtractorTool(
  dataRefs: string[],
  extractInstruction: string,
  variables: Map<string, ToolCallVariable>,
  model: string,
  sendEvent: (data: any) => void
): Promise<{ extracted: any; rawText: string }> {
  const client = createOpenRouterClient();
  
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🔍 EXTRACTOR TOOL CALLED`);
  console.log(`   Data refs: ${JSON.stringify(dataRefs)}`);
  console.log(`   Extract instruction: ${extractInstruction}`);
  console.log(`${'='.repeat(70)}`);
  
  // Helper to find a field in an object
  const findField = (obj: any, fieldName: string): any => {
    if (!obj || typeof obj !== 'object') return undefined;
    if (fieldName in obj) return obj[fieldName];
    const camelCase = fieldName.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (camelCase in obj) return obj[camelCase];
    const snakeCase = fieldName.replace(/([A-Z])/g, '_$1').toLowerCase();
    if (snakeCase in obj) return obj[snakeCase];
    const lowerFieldName = fieldName.toLowerCase();
    for (const key of Object.keys(obj)) {
      if (key.toLowerCase() === lowerFieldName) return obj[key];
    }
    return undefined;
  };
  
  // Group refs by variable name
  const refsByVariable: Map<string, string[]> = new Map();
  for (const ref of dataRefs) {
    const match = ref.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([a-zA-Z_][a-zA-Z0-9_]*)\]$/);
    if (match) {
      const [, varName, field] = match;
      if (!refsByVariable.has(varName)) {
        refsByVariable.set(varName, []);
      }
      refsByVariable.get(varName)!.push(field);
    }
  }
  
  // Build data context - show ALL data for referenced variables to be flexible
  let dataContext = '';
  
  for (const [varName, fields] of refsByVariable) {
    const variable = variables.get(varName);
    if (!variable || !variable.actualData) {
      dataContext += `\n${varName}: (no data found)\n`;
      continue;
    }
    
    // First try to show requested fields
    let hasData = false;
    
    if (Array.isArray(variable.actualData)) {
      const records = variable.actualData.map(item => {
        if (typeof item === 'object' && item !== null) {
          const record: Record<string, any> = {};
          for (const field of fields) {
            const value = findField(item, field);
            if (value !== undefined && value !== null) {
              record[field] = value;
              hasData = true;
            }
          }
          return record;
        }
        return item;
      });
      
      if (hasData) {
        dataContext += `\n${varName} (requested: ${fields.join(', ')}):\n`;
        dataContext += JSON.stringify(records, null, 2) + '\n';
      }
    } else if (typeof variable.actualData === 'object' && variable.actualData !== null) {
      for (const field of fields) {
        const value = findField(variable.actualData, field);
        if (value !== undefined && value !== null) {
          dataContext += `\n${varName}[${field}]: ${JSON.stringify(value)}\n`;
          hasData = true;
        }
      }
    }
    
    // If requested fields had no data, show ALL available data for this variable
    if (!hasData) {
      dataContext += `\n${varName} (showing all available data - requested fields not found):\n`;
      dataContext += JSON.stringify(variable.actualData, null, 2).slice(0, 3000) + '\n';
      if (JSON.stringify(variable.actualData).length > 3000) {
        dataContext += '... (truncated)\n';
      }
    }
  }
  
  console.log(`   Data context:\n${dataContext.slice(0, 1500)}`);
  
  sendEvent({ type: 'extractor_calling', instruction: extractInstruction, dataRefs });
  
  const prompt = `You are a data extraction tool. Extract the requested value from the data provided.

TASK: ${extractInstruction}

DATA:
${dataContext}

IMPORTANT:
- Look for the value even if field names are slightly different (e.g., "property_id" vs "propertyId" vs "id")
- Return ONLY the extracted value - no explanations, no markdown, no quotes around strings
- If extracting a single value, return just that value 
- If you truly cannot find the data, return exactly: NOT_FOUND

Your response (just the value):`;

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 500
    });
    
    const rawText = response.choices[0]?.message?.content?.trim() || 'NOT_FOUND';
    
    console.log(`   Extractor raw response: ${rawText}`);
    
    // Try to parse as JSON, otherwise keep as string
    let extracted: any = rawText;
    try {
      extracted = JSON.parse(rawText);
    } catch {
      // Keep as string
      extracted = rawText;
    }
    
    console.log(`   Extracted value: ${JSON.stringify(extracted)}`);
    console.log(`${'='.repeat(70)}\n`);
    
    sendEvent({ type: 'extractor_response', result: typeof extracted === 'string' ? extracted.slice(0, 200) : JSON.stringify(extracted).slice(0, 200) });
    return { extracted, rawText };
  } catch (error: any) {
    console.log(`   Extractor error: ${error.message}`);
    sendEvent({ type: 'extractor_error', error: error.message });
    return { extracted: `Error: ${error.message}`, rawText: `Error: ${error.message}` };
  }
}

// ================================================================================
// DATA ANALYSIS AGENT - Phase 1: Core Functions
// ================================================================================

// Interface for analysis variables (can be columns, tables, or single numbers)
interface AnalysisVariable {
  name: string;
  type: 'column' | 'table' | 'number';
  data: any;  // any[] for column/table, number for single values
  columns?: string[]; // For table type
}

// Storage for analysis agent variables (separate from pilot variables)
let analysisVariables = new Map<string, AnalysisVariable>();

// Helper: Align column sizes (truncate larger to match smaller)
function alignColumnSizes(col1: any[], col2: any[]): { aligned1: any[]; aligned2: any[]; note?: string } {
  if (col1.length === col2.length) {
    return { aligned1: col1, aligned2: col2 };
  }
  
  const minLength = Math.min(col1.length, col2.length);
  const note = col1.length !== col2.length 
    ? `Note: Aligned to ${minLength} rows (columns had ${col1.length} and ${col2.length} rows)`
    : undefined;
  
  return {
    aligned1: col1.slice(0, minLength),
    aligned2: col2.slice(0, minLength),
    note
  };
}

// Helper: Get column data from a variable
function getColumnData(varName: string, colName: string, pilotVariables: Map<string, any>): any[] | null {
  // First check analysis variables
  const analysisVar = analysisVariables.get(varName);
  if (analysisVar) {
    if (analysisVar.type === 'column') {
      return analysisVar.data;
    } else if (analysisVar.type === 'table') {
      // Extract column from table
      return analysisVar.data.map(row => row[colName]);
    }
    // Note: 'number' type is not a column, handled by getStoredNumber
  }
  
  // Then check pilot variables
  const pilotVar = pilotVariables.get(varName);
  if (pilotVar && pilotVar.actualData) {
    if (Array.isArray(pilotVar.actualData)) {
      return pilotVar.actualData.map((item: any) => {
        if (typeof item === 'object' && item !== null) {
          return item[colName];
        }
        return item;
      });
    }
  }
  
  return null;
}

// Helper: Get stored single number from analysis variables
function getStoredNumber(varName: string): number | null {
  const analysisVar = analysisVariables.get(varName);
  if (analysisVar && analysisVar.type === 'number') {
    return analysisVar.data;
  }
  return null;
}

// Helper: Convert string values to numbers where possible
function toNumbers(arr: any[]): number[] {
  return arr.map(v => {
    if (typeof v === 'number') return v;
    const parsed = parseFloat(v);
    return isNaN(parsed) ? 0 : parsed;
  });
}

// ================================================================================
// AGGREGATION OPERATIONS (return single number)
// ================================================================================

function executeSum(varName: string, colName: string, pilotVariables: Map<string, any>): { success: boolean; result?: number; error?: string } {
  const data = getColumnData(varName, colName, pilotVariables);
  if (!data) return { success: false, error: `Column ${varName}[${colName}] not found` };
  
  const numbers = toNumbers(data);
  const sum = numbers.reduce((a, b) => a + b, 0);
  return { success: true, result: Math.round(sum * 100) / 100 };
}

function executeAverage(varName: string, colName: string, pilotVariables: Map<string, any>): { success: boolean; result?: number; error?: string } {
  const data = getColumnData(varName, colName, pilotVariables);
  if (!data) return { success: false, error: `Column ${varName}[${colName}] not found` };
  
  const numbers = toNumbers(data);
  if (numbers.length === 0) return { success: false, error: 'No data to average' };
  
  const avg = numbers.reduce((a, b) => a + b, 0) / numbers.length;
  return { success: true, result: Math.round(avg * 100) / 100 };
}

function executeMax(varName: string, colName: string, pilotVariables: Map<string, any>): { success: boolean; result?: number; error?: string } {
  const data = getColumnData(varName, colName, pilotVariables);
  if (!data) return { success: false, error: `Column ${varName}[${colName}] not found` };
  
  const numbers = toNumbers(data);
  if (numbers.length === 0) return { success: false, error: 'No data' };
  
  return { success: true, result: Math.max(...numbers) };
}

function executeMin(varName: string, colName: string, pilotVariables: Map<string, any>): { success: boolean; result?: number; error?: string } {
  const data = getColumnData(varName, colName, pilotVariables);
  if (!data) return { success: false, error: `Column ${varName}[${colName}] not found` };
  
  const numbers = toNumbers(data);
  if (numbers.length === 0) return { success: false, error: 'No data' };
  
  return { success: true, result: Math.min(...numbers) };
}

function executeCount(varName: string, colName: string, pilotVariables: Map<string, any>): { success: boolean; result?: number; error?: string } {
  const data = getColumnData(varName, colName, pilotVariables);
  if (!data) return { success: false, error: `Column ${varName}[${colName}] not found` };
  
  return { success: true, result: data.length };
}

// ================================================================================
// COMPARISON OPERATIONS (return single number)
// ================================================================================

function executeDifference(var1: string, col1: string, var2: string, col2: string, pilotVariables: Map<string, any>): { success: boolean; result?: number; error?: string; note?: string } {
  const data1 = getColumnData(var1, col1, pilotVariables);
  const data2 = getColumnData(var2, col2, pilotVariables);
  
  if (!data1) return { success: false, error: `Column ${var1}[${col1}] not found` };
  if (!data2) return { success: false, error: `Column ${var2}[${col2}] not found` };
  
  const { aligned1, aligned2, note } = alignColumnSizes(data1, data2);
  const sum1 = toNumbers(aligned1).reduce((a, b) => a + b, 0);
  const sum2 = toNumbers(aligned2).reduce((a, b) => a + b, 0);
  
  return { success: true, result: Math.round((sum1 - sum2) * 100) / 100, note };
}

function executeRatio(var1: string, col1: string, var2: string, col2: string, pilotVariables: Map<string, any>): { success: boolean; result?: number; error?: string; note?: string } {
  const data1 = getColumnData(var1, col1, pilotVariables);
  const data2 = getColumnData(var2, col2, pilotVariables);
  
  if (!data1) return { success: false, error: `Column ${var1}[${col1}] not found` };
  if (!data2) return { success: false, error: `Column ${var2}[${col2}] not found` };
  
  const { aligned1, aligned2, note } = alignColumnSizes(data1, data2);
  const sum1 = toNumbers(aligned1).reduce((a, b) => a + b, 0);
  const sum2 = toNumbers(aligned2).reduce((a, b) => a + b, 0);
  
  if (sum2 === 0) return { success: false, error: 'Cannot divide by zero' };
  
  return { success: true, result: Math.round((sum1 / sum2) * 100) / 100, note };
}

function executePercentage(var1: string, col1: string, var2: string, col2: string, pilotVariables: Map<string, any>): { success: boolean; result?: number; error?: string; note?: string } {
  const data1 = getColumnData(var1, col1, pilotVariables);
  const data2 = getColumnData(var2, col2, pilotVariables);
  
  if (!data1) return { success: false, error: `Column ${var1}[${col1}] not found` };
  if (!data2) return { success: false, error: `Column ${var2}[${col2}] not found` };
  
  const { aligned1, aligned2, note } = alignColumnSizes(data1, data2);
  const sum1 = toNumbers(aligned1).reduce((a, b) => a + b, 0);
  const sum2 = toNumbers(aligned2).reduce((a, b) => a + b, 0);
  
  if (sum2 === 0) return { success: false, error: 'Cannot divide by zero' };
  
  return { success: true, result: Math.round((sum1 / sum2) * 10000) / 100, note }; // Returns percentage like 45.67
}

function executePctChange(var1: string, col1: string, var2: string, col2: string, pilotVariables: Map<string, any>): { success: boolean; result?: number; error?: string; note?: string } {
  const data1 = getColumnData(var1, col1, pilotVariables);
  const data2 = getColumnData(var2, col2, pilotVariables);
  
  if (!data1) return { success: false, error: `Column ${var1}[${col1}] not found` };
  if (!data2) return { success: false, error: `Column ${var2}[${col2}] not found` };
  
  const { aligned1, aligned2, note } = alignColumnSizes(data1, data2);
  const sumOld = toNumbers(aligned1).reduce((a, b) => a + b, 0);
  const sumNew = toNumbers(aligned2).reduce((a, b) => a + b, 0);
  
  if (sumOld === 0) return { success: false, error: 'Cannot calculate percentage change from zero' };
  
  const pctChange = ((sumNew - sumOld) / sumOld) * 100;
  return { success: true, result: Math.round(pctChange * 100) / 100, note };
}

// ================================================================================
// TRANSFORMATION OPERATIONS (return array, stored in variable)
// ================================================================================

function executeFilter(outputVar: string, varName: string, colName: string, condition: string, pilotVariables: Map<string, any>): { success: boolean; count?: number; error?: string } {
  const data = getColumnData(varName, colName, pilotVariables);
  if (!data) return { success: false, error: `Column ${varName}[${colName}] not found` };
  
  // Parse condition: "> 100", "< 50", "= 'value'", "!= 0", ">= 10", "<= 20"
  const condMatch = condition.match(/^(>=|<=|!=|>|<|=)\s*(.+)$/);
  if (!condMatch) return { success: false, error: `Invalid condition format: ${condition}` };
  
  const [, operator, valueStr] = condMatch;
  const compareValue = valueStr.replace(/^['"]|['"]$/g, '').trim();
  const compareNum = parseFloat(compareValue);
  const isNumeric = !isNaN(compareNum);
  
  const filtered = data.filter(item => {
    const itemValue = typeof item === 'number' ? item : parseFloat(item);
    const itemNum = isNaN(itemValue) ? 0 : itemValue;
    const itemStr = String(item);
    
    switch (operator) {
      case '>': return isNumeric ? itemNum > compareNum : itemStr > compareValue;
      case '<': return isNumeric ? itemNum < compareNum : itemStr < compareValue;
      case '>=': return isNumeric ? itemNum >= compareNum : itemStr >= compareValue;
      case '<=': return isNumeric ? itemNum <= compareNum : itemStr <= compareValue;
      case '=': return isNumeric ? itemNum === compareNum : itemStr === compareValue;
      case '!=': return isNumeric ? itemNum !== compareNum : itemStr !== compareValue;
      default: return false;
    }
  });
  
  analysisVariables.set(outputVar, { name: outputVar, type: 'column', data: filtered });
  return { success: true, count: filtered.length };
}

function executeSortAsc(outputVar: string, varName: string, colName: string, pilotVariables: Map<string, any>): { success: boolean; count?: number; error?: string } {
  const data = getColumnData(varName, colName, pilotVariables);
  if (!data) return { success: false, error: `Column ${varName}[${colName}] not found` };
  
  const sorted = [...data].sort((a, b) => {
    const numA = parseFloat(a);
    const numB = parseFloat(b);
    if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
    return String(a).localeCompare(String(b));
  });
  
  analysisVariables.set(outputVar, { name: outputVar, type: 'column', data: sorted });
  return { success: true, count: sorted.length };
}

function executeSortDesc(outputVar: string, varName: string, colName: string, pilotVariables: Map<string, any>): { success: boolean; count?: number; error?: string } {
  const data = getColumnData(varName, colName, pilotVariables);
  if (!data) return { success: false, error: `Column ${varName}[${colName}] not found` };
  
  const sorted = [...data].sort((a, b) => {
    const numA = parseFloat(a);
    const numB = parseFloat(b);
    if (!isNaN(numA) && !isNaN(numB)) return numB - numA;
    return String(b).localeCompare(String(a));
  });
  
  analysisVariables.set(outputVar, { name: outputVar, type: 'column', data: sorted });
  return { success: true, count: sorted.length };
}

// ================================================================================
// ARITHMETIC OPERATIONS (return array, stored in variable)
// ================================================================================

function executeAddNum(outputVar: string, varName: string, colName: string, num: number, pilotVariables: Map<string, any>): { success: boolean; count?: number; error?: string } {
  const data = getColumnData(varName, colName, pilotVariables);
  if (!data) return { success: false, error: `Column ${varName}[${colName}] not found` };
  
  const result = toNumbers(data).map(v => Math.round((v + num) * 100) / 100);
  analysisVariables.set(outputVar, { name: outputVar, type: 'column', data: result });
  return { success: true, count: result.length };
}

function executeSubtractNum(outputVar: string, varName: string, colName: string, num: number, pilotVariables: Map<string, any>): { success: boolean; count?: number; error?: string } {
  const data = getColumnData(varName, colName, pilotVariables);
  if (!data) return { success: false, error: `Column ${varName}[${colName}] not found` };
  
  const result = toNumbers(data).map(v => Math.round((v - num) * 100) / 100);
  analysisVariables.set(outputVar, { name: outputVar, type: 'column', data: result });
  return { success: true, count: result.length };
}

function executeMultiplyNum(outputVar: string, varName: string, colName: string, num: number, pilotVariables: Map<string, any>): { success: boolean; count?: number; error?: string } {
  const data = getColumnData(varName, colName, pilotVariables);
  if (!data) return { success: false, error: `Column ${varName}[${colName}] not found` };
  
  const result = toNumbers(data).map(v => Math.round((v * num) * 100) / 100);
  analysisVariables.set(outputVar, { name: outputVar, type: 'column', data: result });
  return { success: true, count: result.length };
}

function executeDivideNum(outputVar: string, varName: string, colName: string, num: number, pilotVariables: Map<string, any>): { success: boolean; count?: number; error?: string } {
  if (num === 0) return { success: false, error: 'Cannot divide by zero' };
  
  const data = getColumnData(varName, colName, pilotVariables);
  if (!data) return { success: false, error: `Column ${varName}[${colName}] not found` };
  
  const result = toNumbers(data).map(v => Math.round((v / num) * 100) / 100);
  analysisVariables.set(outputVar, { name: outputVar, type: 'column', data: result });
  return { success: true, count: result.length };
}

// Column arithmetic
function executeAddColumns(outputVar: string, var1: string, col1: string, var2: string, col2: string, pilotVariables: Map<string, any>): { success: boolean; count?: number; error?: string; note?: string } {
  const data1 = getColumnData(var1, col1, pilotVariables);
  const data2 = getColumnData(var2, col2, pilotVariables);
  
  if (!data1) return { success: false, error: `Column ${var1}[${col1}] not found` };
  if (!data2) return { success: false, error: `Column ${var2}[${col2}] not found` };
  
  const { aligned1, aligned2, note } = alignColumnSizes(data1, data2);
  const nums1 = toNumbers(aligned1);
  const nums2 = toNumbers(aligned2);
  
  const result = nums1.map((v, i) => Math.round((v + nums2[i]) * 100) / 100);
  analysisVariables.set(outputVar, { name: outputVar, type: 'column', data: result });
  return { success: true, count: result.length, note };
}

function executeSubtractColumns(outputVar: string, var1: string, col1: string, var2: string, col2: string, pilotVariables: Map<string, any>): { success: boolean; count?: number; error?: string; note?: string } {
  const data1 = getColumnData(var1, col1, pilotVariables);
  const data2 = getColumnData(var2, col2, pilotVariables);
  
  if (!data1) return { success: false, error: `Column ${var1}[${col1}] not found` };
  if (!data2) return { success: false, error: `Column ${var2}[${col2}] not found` };
  
  const { aligned1, aligned2, note } = alignColumnSizes(data1, data2);
  const nums1 = toNumbers(aligned1);
  const nums2 = toNumbers(aligned2);
  
  const result = nums1.map((v, i) => Math.round((v - nums2[i]) * 100) / 100);
  analysisVariables.set(outputVar, { name: outputVar, type: 'column', data: result });
  return { success: true, count: result.length, note };
}

function executeMultiplyColumns(outputVar: string, var1: string, col1: string, var2: string, col2: string, pilotVariables: Map<string, any>): { success: boolean; count?: number; error?: string; note?: string } {
  const data1 = getColumnData(var1, col1, pilotVariables);
  const data2 = getColumnData(var2, col2, pilotVariables);
  
  if (!data1) return { success: false, error: `Column ${var1}[${col1}] not found` };
  if (!data2) return { success: false, error: `Column ${var2}[${col2}] not found` };
  
  const { aligned1, aligned2, note } = alignColumnSizes(data1, data2);
  const nums1 = toNumbers(aligned1);
  const nums2 = toNumbers(aligned2);
  
  const result = nums1.map((v, i) => Math.round((v * nums2[i]) * 100) / 100);
  analysisVariables.set(outputVar, { name: outputVar, type: 'column', data: result });
  return { success: true, count: result.length, note };
}

function executeDivideColumns(outputVar: string, var1: string, col1: string, var2: string, col2: string, pilotVariables: Map<string, any>): { success: boolean; count?: number; error?: string; note?: string } {
  const data1 = getColumnData(var1, col1, pilotVariables);
  const data2 = getColumnData(var2, col2, pilotVariables);
  
  if (!data1) return { success: false, error: `Column ${var1}[${col1}] not found` };
  if (!data2) return { success: false, error: `Column ${var2}[${col2}] not found` };
  
  const { aligned1, aligned2, note } = alignColumnSizes(data1, data2);
  const nums1 = toNumbers(aligned1);
  const nums2 = toNumbers(aligned2);
  
  // Handle division by zero by returning 0 for those elements
  const result = nums1.map((v, i) => nums2[i] === 0 ? 0 : Math.round((v / nums2[i]) * 100) / 100);
  analysisVariables.set(outputVar, { name: outputVar, type: 'column', data: result });
  return { success: true, count: result.length, note };
}

// ================================================================================
// TABLE CREATION OPERATION
// ================================================================================

function executeCreateTable(outputVar: string, columns: Array<{ label: string; data: any[] }>, pilotVariables: Map<string, any>): { success: boolean; rows?: number; cols?: number; error?: string } {
  if (columns.length === 0) return { success: false, error: 'No columns provided' };
  
  // Find the minimum length across all columns
  const minLength = Math.min(...columns.map(c => c.data.length));
  
  // Build table rows
  const rows: any[] = [];
  for (let i = 0; i < minLength; i++) {
    const row: Record<string, any> = {};
    for (const col of columns) {
      row[col.label] = col.data[i];
    }
    rows.push(row);
  }
  
  analysisVariables.set(outputVar, { 
    name: outputVar, 
    type: 'table', 
    data: rows,
    columns: columns.map(c => c.label)
  });
  
  return { success: true, rows: rows.length, cols: columns.length };
}

// ================================================================================
// TABLE PREVIEW BUILDER (for showing data to agent)
// ================================================================================

function buildTablePreview(varName: string, variable: any): string {
  if (!variable || !variable.actualData) {
    return `📊 ${varName} (no data)`;
  }
  
  const data = variable.actualData;
  const schema = variable.schema || {};
  
  if (!Array.isArray(data) || data.length === 0) {
    return `📊 ${varName} (empty)`;
  }
  
  // Get column names from schema or first row
  const columns = Object.keys(schema).length > 0 
    ? Object.keys(schema) 
    : (typeof data[0] === 'object' ? Object.keys(data[0]) : ['value']);
  
  // Determine data types
  const types: Record<string, string> = {};
  for (const col of columns) {
    if (schema[col]?.data_type) {
      types[col] = schema[col].data_type;
    } else if (data[0] && typeof data[0] === 'object') {
      const sampleValue = data[0][col];
      types[col] = typeof sampleValue === 'number' ? 'number' : 'string';
    } else {
      types[col] = 'string';
    }
  }
  
  // Build ASCII table
  const colWidths: Record<string, number> = {};
  for (const col of columns) {
    colWidths[col] = Math.max(col.length, types[col].length + 2, 12);
  }
  
  let result = `📊 ${varName} (${data.length} rows)\n`;
  
  // Header row
  result += '┌' + columns.map(c => '─'.repeat(colWidths[c] + 2)).join('┬') + '┐\n';
  result += '│' + columns.map(c => ` ${c.padEnd(colWidths[c])} `).join('│') + '│\n';
  result += '│' + columns.map(c => ` (${types[c]})`.padEnd(colWidths[c] + 2)).join('│') + '│\n';
  result += '├' + columns.map(c => '─'.repeat(colWidths[c] + 2)).join('┼') + '┤\n';
  
  // Data rows (first 3)
  const previewRows = data.slice(0, 3);
  for (const row of previewRows) {
    const values = columns.map(col => {
      const val = typeof row === 'object' ? row[col] : row;
      const strVal = String(val ?? '').slice(0, colWidths[col]);
      return ` ${strVal.padEnd(colWidths[col])} `;
    });
    result += '│' + values.join('│') + '│\n';
  }
  
  result += '└' + columns.map(c => '─'.repeat(colWidths[c] + 2)).join('┴') + '┘\n';
  
  if (data.length > 3) {
    result += `(+ ${data.length - 3} more rows)\n`;
  }
  
  return result;
}

// ================================================================================
// OPERATION PARSER
// ================================================================================

interface ParsedOperation {
  type: string;
  outputVar?: string;
  args: {
    var1?: string;
    col1?: string;
    var2?: string;
    col2?: string;
    num?: number;
    condition?: string;
    columns?: Array<{ label: string; dataRef: string }>;
    explicitData?: Array<{ label: string; values: any[] }>;
  };
}

function parseAnalysisOperation(executeBlock: string): ParsedOperation | null {
  const trimmed = executeBlock.trim();
  
  // Pattern for variable assignment: var_name: operation(...)
  const assignMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+)$/);
  const outputVar = assignMatch ? assignMatch[1] : undefined;
  const operationStr = assignMatch ? assignMatch[2] : trimmed;
  
  // Parse operation name and arguments
  const opMatch = operationStr.match(/^([a-zA-Z_]+)\s*\((.+)\)$/s);
  if (!opMatch) return null;
  
  const [, opName, argsStr] = opMatch;
  
  // Helper: Parse a variable reference - supports both var[col] and just var (for column-type analysis variables)
  const parseVarRef = (str: string): { varName: string; colName: string } | null => {
    const trimStr = str.trim();
    // Try var[col] pattern first
    const varColMatch = trimStr.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([a-zA-Z_][a-zA-Z0-9_]*)\]$/);
    if (varColMatch) {
      return { varName: varColMatch[1], colName: varColMatch[2] };
    }
    // Try just var pattern (for column-type analysis variables)
    const varOnlyMatch = trimStr.match(/^([a-zA-Z_][a-zA-Z0-9_]*)$/);
    if (varOnlyMatch) {
      // Use '_value' as a placeholder column name - getColumnData ignores it for column-type vars
      return { varName: varOnlyMatch[1], colName: '_value' };
    }
    return null;
  };
  
  // Parse based on operation type
  switch (opName.toLowerCase()) {
    // Aggregations - include outputVar so result is stored
    case 'sum':
    case 'average':
    case 'max':
    case 'min':
    case 'count': {
      const ref = parseVarRef(argsStr);
      if (!ref) return null;
      return { type: opName.toLowerCase(), outputVar, args: { var1: ref.varName, col1: ref.colName } };
    }
    
    // Comparisons - include outputVar so result is stored
    case 'difference':
    case 'ratio':
    case 'percentage':
    case 'pct_change': {
      // Split by comma (careful with nested brackets)
      const commaIdx = argsStr.indexOf(',');
      if (commaIdx === -1) return null;
      
      const ref1 = parseVarRef(argsStr.slice(0, commaIdx));
      const ref2 = parseVarRef(argsStr.slice(commaIdx + 1));
      if (!ref1 || !ref2) return null;
      
      return { type: opName.toLowerCase(), outputVar, args: { var1: ref1.varName, col1: ref1.colName, var2: ref2.varName, col2: ref2.colName } };
    }
    
    // Filter
    case 'filter': {
      // Try var[col], "condition" pattern first
      const filterMatch = argsStr.match(/([a-zA-Z_][a-zA-Z0-9_]*)\[([a-zA-Z_][a-zA-Z0-9_]*)\]\s*,\s*["'](.+)["']/);
      if (filterMatch) {
        return { type: 'filter', outputVar, args: { var1: filterMatch[1], col1: filterMatch[2], condition: filterMatch[3] } };
      }
      // Try just var, "condition" pattern (for column-type analysis variables)
      const filterVarOnly = argsStr.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*,\s*["'](.+)["']/);
      if (filterVarOnly) {
        return { type: 'filter', outputVar, args: { var1: filterVarOnly[1], col1: '_value', condition: filterVarOnly[2] } };
      }
      return null;
    }
    
    // Sort
    case 'sort_asc':
    case 'sort_desc': {
      const ref = parseVarRef(argsStr);
      if (!ref) return null;
      return { type: opName.toLowerCase(), outputVar, args: { var1: ref.varName, col1: ref.colName } };
    }
    
    // Arithmetic with number or column
    case 'add':
    case 'subtract':
    case 'multiply':
    case 'divide': {
      // Find the comma separator (not inside brackets)
      let commaIdx = -1;
      let depth = 0;
      for (let i = 0; i < argsStr.length; i++) {
        if (argsStr[i] === '[') depth++;
        else if (argsStr[i] === ']') depth--;
        else if (argsStr[i] === ',' && depth === 0) {
          commaIdx = i;
          break;
        }
      }
      if (commaIdx === -1) return null;
      
      const firstArg = argsStr.slice(0, commaIdx).trim();
      const secondArg = argsStr.slice(commaIdx + 1).trim();
      
      // Check if second arg is a number
      const numMatch = secondArg.match(/^[\d.]+$/);
      if (numMatch) {
        const ref1 = parseVarRef(firstArg);
        if (!ref1) return null;
        return { type: `${opName.toLowerCase()}_num`, outputVar, args: { var1: ref1.varName, col1: ref1.colName, num: parseFloat(secondArg) } };
      }
      
      // Otherwise it's column arithmetic
      const ref1 = parseVarRef(firstArg);
      const ref2 = parseVarRef(secondArg);
      if (!ref1 || !ref2) return null;
      return { type: `${opName.toLowerCase()}_columns`, outputVar, args: { var1: ref1.varName, col1: ref1.colName, var2: ref2.varName, col2: ref2.colName } };
    }
    
    // Table creation
    case 'table': {
      // Parse table columns: table(Label1: var[col], Label2: var[col], ...)
      // or table(Label1: [val1, val2], Label2: [val3, val4], ...)
      const columns: Array<{ label: string; dataRef: string }> = [];
      const explicitData: Array<{ label: string; values: any[] }> = [];
      
      // Split by top-level commas (not inside brackets)
      const parts: string[] = [];
      let current = '';
      let depth = 0;
      for (const char of argsStr) {
        if (char === '[') depth++;
        else if (char === ']') depth--;
        
        if (char === ',' && depth === 0) {
          parts.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      if (current.trim()) parts.push(current.trim());
      
      for (const part of parts) {
        const labelMatch = part.match(/^([a-zA-Z_][a-zA-Z0-9_\s]*)\s*:\s*(.+)$/);
        if (labelMatch) {
          const [, label, dataStr] = labelMatch;
          
          // Check if it's a variable reference
          const varColMatch = dataStr.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([a-zA-Z_][a-zA-Z0-9_]*)\]$/);
          if (varColMatch) {
            columns.push({ label: label.trim(), dataRef: dataStr.trim() });
          }
          // Check if it's explicit array
          else if (dataStr.trim().startsWith('[')) {
            try {
              const values = JSON.parse(dataStr.trim());
              explicitData.push({ label: label.trim(), values });
            } catch {
              // Skip invalid JSON
            }
          }
          // Check if it's a simple variable reference (analysis variable)
          else if (dataStr.match(/^[a-zA-Z_][a-zA-Z0-9_]*$/)) {
            columns.push({ label: label.trim(), dataRef: dataStr.trim() });
          }
        }
      }
      
      return { type: 'table', outputVar, args: { columns, explicitData } };
    }
    
    default:
      return null;
  }
}

// ================================================================================
// OPERATION EXECUTOR (main dispatcher)
// ================================================================================

function executeAnalysisOperation(parsed: ParsedOperation, pilotVariables: Map<string, any>): string {
  const { type, outputVar, args } = parsed;
  
  // Helper to store number and return formatted response
  const storeNumberResult = (value: number, varName?: string): string => {
    if (varName) {
      analysisVariables.set(varName, { name: varName, type: 'number', data: value });
      return `Result: ${value} (stored in '${varName}')`;
    }
    return `Result: ${value}`;
  };
  
  // Helper to get numeric value from either stored number or column sum
  const getNumericValue = (varName: string, colName: string): { value: number | null; error?: string } => {
    // First check if it's a stored number variable
    const storedNum = getStoredNumber(varName);
    if (storedNum !== null) {
      return { value: storedNum };
    }
    
    // Otherwise get column data and sum it
    const colData = getColumnData(varName, colName, pilotVariables);
    if (!colData) {
      return { value: null, error: `Variable '${varName}' not found or has no data` };
    }
    const nums = toNumbers(colData);
    const sum = nums.reduce((a, b) => a + b, 0);
    return { value: sum };
  };
  
  switch (type) {
    // Aggregations - now store in variable if outputVar provided
    case 'sum': {
      const result = executeSum(args.var1!, args.col1!, pilotVariables);
      if (!result.success) return `Error: ${result.error}`;
      return storeNumberResult(result.result!, outputVar);
    }
    case 'average': {
      const result = executeAverage(args.var1!, args.col1!, pilotVariables);
      if (!result.success) return `Error: ${result.error}`;
      return storeNumberResult(result.result!, outputVar);
    }
    case 'max': {
      const result = executeMax(args.var1!, args.col1!, pilotVariables);
      if (!result.success) return `Error: ${result.error}`;
      return storeNumberResult(result.result!, outputVar);
    }
    case 'min': {
      const result = executeMin(args.var1!, args.col1!, pilotVariables);
      if (!result.success) return `Error: ${result.error}`;
      return storeNumberResult(result.result!, outputVar);
    }
    case 'count': {
      const result = executeCount(args.var1!, args.col1!, pilotVariables);
      if (!result.success) return `Error: ${result.error}`;
      return storeNumberResult(result.result!, outputVar);
    }
    
    // Comparisons - now support stored numbers OR column references
    case 'difference': {
      const val1 = getNumericValue(args.var1!, args.col1!);
      const val2 = getNumericValue(args.var2!, args.col2!);
      if (val1.error) return `Error: ${val1.error}`;
      if (val2.error) return `Error: ${val2.error}`;
      const diff = Math.round((val1.value! - val2.value!) * 100) / 100;
      return storeNumberResult(diff, outputVar);
    }
    case 'ratio': {
      const val1 = getNumericValue(args.var1!, args.col1!);
      const val2 = getNumericValue(args.var2!, args.col2!);
      if (val1.error) return `Error: ${val1.error}`;
      if (val2.error) return `Error: ${val2.error}`;
      if (val2.value === 0) return `Error: Cannot divide by zero`;
      const ratio = Math.round((val1.value! / val2.value!) * 100) / 100;
      return storeNumberResult(ratio, outputVar);
    }
    case 'percentage': {
      const val1 = getNumericValue(args.var1!, args.col1!);
      const val2 = getNumericValue(args.var2!, args.col2!);
      if (val1.error) return `Error: ${val1.error}`;
      if (val2.error) return `Error: ${val2.error}`;
      if (val2.value === 0) return `Error: Cannot divide by zero`;
      const pct = Math.round((val1.value! / val2.value!) * 10000) / 100;
      if (outputVar) {
        analysisVariables.set(outputVar, { name: outputVar, type: 'number', data: pct });
        return `Result: ${pct}% (stored in '${outputVar}')`;
      }
      return `Result: ${pct}%`;
    }
    case 'pct_change': {
      const val1 = getNumericValue(args.var1!, args.col1!);
      const val2 = getNumericValue(args.var2!, args.col2!);
      if (val1.error) return `Error: ${val1.error}`;
      if (val2.error) return `Error: ${val2.error}`;
      if (val1.value === 0) return `Error: Cannot calculate percentage change from zero`;
      const change = Math.round(((val2.value! - val1.value!) / val1.value!) * 10000) / 100;
      if (outputVar) {
        analysisVariables.set(outputVar, { name: outputVar, type: 'number', data: change });
        return `Result: ${change}% (stored in '${outputVar}')`;
      }
      return `Result: ${change}%`;
    }
    
    // Transformations
    case 'filter': {
      if (!outputVar) return 'Error: filter requires output variable (e.g., filtered_data: filter(...))';
      const result = executeFilter(outputVar, args.var1!, args.col1!, args.condition!, pilotVariables);
      return result.success ? `Stored in '${outputVar}' (${result.count} values)` : `Error: ${result.error}`;
    }
    case 'sort_asc': {
      if (!outputVar) return 'Error: sort_asc requires output variable';
      const result = executeSortAsc(outputVar, args.var1!, args.col1!, pilotVariables);
      return result.success ? `Stored in '${outputVar}' (${result.count} values)` : `Error: ${result.error}`;
    }
    case 'sort_desc': {
      if (!outputVar) return 'Error: sort_desc requires output variable';
      const result = executeSortDesc(outputVar, args.var1!, args.col1!, pilotVariables);
      return result.success ? `Stored in '${outputVar}' (${result.count} values)` : `Error: ${result.error}`;
    }
    
    // Arithmetic with number
    case 'add_num': {
      if (!outputVar) return 'Error: add requires output variable';
      const result = executeAddNum(outputVar, args.var1!, args.col1!, args.num!, pilotVariables);
      return result.success ? `Stored in '${outputVar}' (${result.count} values)` : `Error: ${result.error}`;
    }
    case 'subtract_num': {
      if (!outputVar) return 'Error: subtract requires output variable';
      const result = executeSubtractNum(outputVar, args.var1!, args.col1!, args.num!, pilotVariables);
      return result.success ? `Stored in '${outputVar}' (${result.count} values)` : `Error: ${result.error}`;
    }
    case 'multiply_num': {
      if (!outputVar) return 'Error: multiply requires output variable';
      const result = executeMultiplyNum(outputVar, args.var1!, args.col1!, args.num!, pilotVariables);
      return result.success ? `Stored in '${outputVar}' (${result.count} values)` : `Error: ${result.error}`;
    }
    case 'divide_num': {
      if (!outputVar) return 'Error: divide requires output variable';
      const result = executeDivideNum(outputVar, args.var1!, args.col1!, args.num!, pilotVariables);
      return result.success ? `Stored in '${outputVar}' (${result.count} values)` : `Error: ${result.error}`;
    }
    
    // Arithmetic with columns
    case 'add_columns': {
      if (!outputVar) return 'Error: add requires output variable';
      const result = executeAddColumns(outputVar, args.var1!, args.col1!, args.var2!, args.col2!, pilotVariables);
      let response = result.success ? `Stored in '${outputVar}' (${result.count} values)` : `Error: ${result.error}`;
      if (result.note) response += ` (${result.note})`;
      return response;
    }
    case 'subtract_columns': {
      if (!outputVar) return 'Error: subtract requires output variable';
      const result = executeSubtractColumns(outputVar, args.var1!, args.col1!, args.var2!, args.col2!, pilotVariables);
      let response = result.success ? `Stored in '${outputVar}' (${result.count} values)` : `Error: ${result.error}`;
      if (result.note) response += ` (${result.note})`;
      return response;
    }
    case 'multiply_columns': {
      if (!outputVar) return 'Error: multiply requires output variable';
      const result = executeMultiplyColumns(outputVar, args.var1!, args.col1!, args.var2!, args.col2!, pilotVariables);
      let response = result.success ? `Stored in '${outputVar}' (${result.count} values)` : `Error: ${result.error}`;
      if (result.note) response += ` (${result.note})`;
      return response;
    }
    case 'divide_columns': {
      if (!outputVar) return 'Error: divide requires output variable';
      const result = executeDivideColumns(outputVar, args.var1!, args.col1!, args.var2!, args.col2!, pilotVariables);
      let response = result.success ? `Stored in '${outputVar}' (${result.count} values)` : `Error: ${result.error}`;
      if (result.note) response += ` (${result.note})`;
      return response;
    }
    
    // Table creation
    case 'table': {
      if (!outputVar) return 'Error: table requires output variable';
      
      const tableColumns: Array<{ label: string; data: any[] }> = [];
      
      // Process column references
      for (const col of args.columns || []) {
        // Check if it's a var[col] reference
        const varColMatch = col.dataRef.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([a-zA-Z_][a-zA-Z0-9_]*)\]$/);
        if (varColMatch) {
          const data = getColumnData(varColMatch[1], varColMatch[2], pilotVariables);
          if (data) {
            tableColumns.push({ label: col.label, data });
          }
        }
        // Check if it's a simple analysis variable
        else {
          const analysisVar = analysisVariables.get(col.dataRef);
          if (analysisVar && analysisVar.type === 'column') {
            tableColumns.push({ label: col.label, data: analysisVar.data });
          }
        }
      }
      
      // Process explicit data
      for (const col of args.explicitData || []) {
        tableColumns.push({ label: col.label, data: col.values });
      }
      
      if (tableColumns.length === 0) return 'Error: No valid columns for table';
      
      const result = executeCreateTable(outputVar, tableColumns, pilotVariables);
      return result.success ? `Stored in '${outputVar}' (${result.rows} rows, ${result.cols} columns)` : `Error: ${result.error}`;
    }
    
    default:
      return `Error: Unknown operation type: ${type}`;
  }
}

// Reset analysis variables (call when starting new analysis)
function resetAnalysisVariables(): void {
  analysisVariables = new Map<string, AnalysisVariable>();
}

// ================================================================================
// END OF DATA ANALYSIS AGENT - Phase 1
// ================================================================================

// ================================================================================
// DATA ANALYSIS SYSTEM - Two-Tool Architecture
// ================================================================================
// Tool 1: Execution Planner - Plans all operations with comments
// Tool 2: Report Writer - Creates visualizations and summary
// ================================================================================

// Build the Execution Planner prompt
function buildExecutionPlannerPrompt(
  tablePreviews: string,
  pilotRequest: string
): string {
  return `# EXECUTION PLANNER

You plan data operations to answer the request. You see schemas and samples, not raw data.
Write ALL operations needed, one per line. Add a comment after each to explain what it computes.

================================================================================
## AVAILABLE DATA
================================================================================

${tablePreviews}

================================================================================
## REQUEST TO ANALYZE
================================================================================

${pilotRequest}

================================================================================
## OPERATIONS REFERENCE
================================================================================

### Aggregations (returns single number)
variable: sum(data[column])       # Total of all values
variable: average(data[column])   # Mean value  
variable: max(data[column])       # Largest value
variable: min(data[column])       # Smallest value
variable: count(data[column])     # Number of rows

### Comparisons (returns single number - can use stored variables or columns)
variable: difference(var1, var2)    # var1 minus var2
variable: ratio(var1, var2)         # var1 divided by var2
variable: percentage(var1, var2)    # (var1 / var2) × 100
variable: pct_change(old, new)      # ((new - old) / old) × 100

### Transformations (returns column, stored in variable)
variable: filter(data[column], "> 100")   # Rows matching condition
variable: sort_asc(data[column])          # Sorted ascending
variable: sort_desc(data[column])         # Sorted descending

### Arithmetic (returns column, stored in variable)
variable: add(data[column], 10)           # Add number to each
variable: subtract(data[column], 5)       # Subtract number from each
variable: multiply(data[column], 2)       # Multiply each by number
variable: divide(data[column], 2)         # Divide each by number

### Column Arithmetic (returns column)
variable: add(data1[col1], data2[col2])        # Add columns
variable: subtract(data1[col1], data2[col2])   # Subtract columns

### Table Creation (for display)
variable: table(Label1: data[col1], Label2: data[col2], Label3: stored_var)

================================================================================
## VARIABLE NAMING
================================================================================

Use DESCRIPTIVE and UNIQUE names:
✓ q1_total_revenue, march_average_sales, growth_rate_pct
✗ result, data, temp, var1

================================================================================
## OUTPUT FORMAT
================================================================================

Write operations one per line. Add # comment explaining what it computes/stores.

EXAMPLE (for inventory analysis):
\`\`\`
warehouse_a_total: sum(inventory_a[quantity])  # Total items in warehouse A
warehouse_b_total: sum(inventory_b[quantity])  # Total items in warehouse B
inventory_difference: difference(warehouse_a_total, warehouse_b_total)  # Difference between warehouses
low_stock_items: filter(inventory_a[quantity], "< 50")  # Items with low stock
comparison_table: table(Warehouse: ["A", "B"], Total Items: [warehouse_a_total, warehouse_b_total])  # Summary table
\`\`\`

================================================================================

Write your operations now. One per line with # comment:`;
}

// Parse execution plan into operations
function parseExecutionPlan(planOutput: string): Array<{ line: string; varName: string; operation: string; comment: string }> {
  const operations: Array<{ line: string; varName: string; operation: string; comment: string }> = [];
  
  const lines = planOutput.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('\`')) continue;
    
    // Parse: variable: operation(args)  # comment
    const match = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([^#]+?)(?:\s*#\s*(.*))?$/);
    if (match) {
      const [, varName, operation, comment] = match;
      operations.push({
        line: trimmed,
        varName: varName.trim(),
        operation: operation.trim(),
        comment: comment?.trim() || ''
      });
    }
  }
  
  return operations;
}

// Execute the plan and collect results
interface ExecutionResult {
  varName: string;
  operation: string;
  comment: string;
  resultType: 'number' | 'column' | 'table';
  value?: number;
  count?: number;
  columns?: string[];
  error?: string;
}

async function executeExecutionPlan(
  operations: Array<{ line: string; varName: string; operation: string; comment: string }>,
  pilotVariables: Map<string, any>,
  sendEvent: (data: any) => void
): Promise<ExecutionResult[]> {
  const results: ExecutionResult[] = [];
  
  for (const op of operations) {
    console.log(`[Execution Planner] Executing: ${op.varName}: ${op.operation}`);
    
    // Parse the operation using existing parser
    const fullOperation = `${op.varName}: ${op.operation}`;
    const parsed = parseAnalysisOperation(fullOperation);
    
    if (!parsed) {
      results.push({
        varName: op.varName,
        operation: op.operation,
        comment: op.comment,
        resultType: 'number',
        error: `Could not parse operation`
      });
      continue;
    }
    
    // Execute using existing function
    const resultStr = executeAnalysisOperation(parsed, pilotVariables);
    
    // Determine result type and extract info
    if (resultStr.startsWith('Error:')) {
      results.push({
        varName: op.varName,
        operation: op.operation,
        comment: op.comment,
        resultType: 'number',
        error: resultStr
      });
    } else if (resultStr.includes('Result:')) {
      // Single number result
      const valueMatch = resultStr.match(/Result:\s*([\d.-]+)/);
      const value = valueMatch ? parseFloat(valueMatch[1]) : 0;
      results.push({
        varName: op.varName,
        operation: op.operation,
        comment: op.comment,
        resultType: 'number',
        value
      });
    } else if (resultStr.includes('Stored in')) {
      // Column or table result
      const analysisVar = analysisVariables.get(op.varName);
      if (analysisVar?.type === 'table') {
        results.push({
          varName: op.varName,
          operation: op.operation,
          comment: op.comment,
          resultType: 'table',
          count: analysisVar.data.length,
          columns: analysisVar.columns
        });
      } else {
        results.push({
          varName: op.varName,
          operation: op.operation,
          comment: op.comment,
          resultType: 'column',
          count: analysisVar?.data?.length || 0
        });
      }
    }
    
    sendEvent({
      type: 'analysis_operation_result',
      operation: fullOperation,
      result: resultStr
    });
  }
  
  return results;
}

// Build context string from execution results for Report Writer
function buildExecutionResultsContext(results: ExecutionResult[]): string {
  let computed = '## COMPUTED VALUES (use these in your report)\n\n';
  let variables = '## AVAILABLE VARIABLES FOR VISUALS\n\n';
  
  for (const r of results) {
    if (r.error) {
      computed += `• ${r.varName}: ERROR - ${r.error}\n`;
    } else if (r.resultType === 'number') {
      computed += `• ${r.varName} = ${r.value}  (${r.comment || 'computed value'})\n`;
    } else if (r.resultType === 'column') {
      variables += `• ${r.varName} (column: ${r.count} values) - ${r.comment || 'computed column'}\n`;
    } else if (r.resultType === 'table') {
      variables += `• ${r.varName} (table: ${r.count} rows, columns: ${r.columns?.join(', ')}) - ${r.comment || 'created table'}\n`;
    }
  }
  
  return computed + '\n' + variables;
}

// Build the Report Writer prompt
function buildReportWriterPrompt(
  tablePreviews: string,
  pilotRequest: string,
  executionResults: string
): string {
  return `# REPORT WRITER

You create visualizations and summaries based on computed data.
You see the original data schemas, the request, and all computed values.

================================================================================
## ORIGINAL DATA (schemas and samples)
================================================================================

${tablePreviews}

================================================================================
## REQUEST FROM PILOT
================================================================================

${pilotRequest}

================================================================================
## EXECUTION RESULTS
================================================================================

${executionResults}

================================================================================
## YOUR TASK
================================================================================

Create a [report] with visualizations and a [summary] for the Pilot agent.

### Visual Types

VISUAL_1: table
  caption: "Table Caption"
  data: variable_name   # Reference a table variable

VISUAL_2: line-chart
  title: "Chart Title"
  x_data: data[column]
  y_data: data[column] OR computed_column_variable
  x_label: "X Axis"
  y_label: "Y Axis"
  color: #3b82f6

VISUAL_3: card
  content: |
    ## Heading
    Text with **bold** and *italic*.
    Reference computed values: The total was **45,000**.
    - Bullet points
    - More points

### Rules
1. Reference variables in VISUAL blocks - don't invent data
2. Cards: simple markdown only - NO tables in cards
3. Use the computed VALUES in your card text (e.g., "Revenue was **$52,000**")
4. Summary is for the Pilot - be concise about key findings

================================================================================
## EXAMPLE OUTPUT
================================================================================

For an inventory comparison request with computed values:
- warehouse_a_total = 1500
- warehouse_b_total = 1200
- inventory_difference = 300
- comparison_table (table with 2 rows)

\`\`\`
[report]
VISUAL_1: table
  caption: "Warehouse Inventory Comparison"
  data: comparison_table

VISUAL_2: card
  content: |
    ## Inventory Summary
    Warehouse A holds **1,500** items while Warehouse B has **1,200** items.
    The difference of **300 items** shows A has 25% more inventory.
    
    Consider redistributing stock for balance.
[/report]

[summary]
Warehouse A (1,500 items) has 300 more items than Warehouse B (1,200 items). Comparison table and summary card displayed showing the 25% difference.
[/summary]
\`\`\`

================================================================================

Write your [report] and [summary] now:`;
}

// Parse Report Writer output
function parseReportWriterOutput(output: string): { report: string; summary: string } {
  let report = '';
  let summary = '';
  
  const reportMatch = output.match(/\[report\]([\s\S]*?)\[\/report\]/i);
  if (reportMatch) {
    report = reportMatch[1].trim();
  }
  
  const summaryMatch = output.match(/\[summary\]([\s\S]*?)\[\/summary\]/i);
  if (summaryMatch) {
    summary = summaryMatch[1].trim();
  }
  
  // If no closing tag, try to extract anyway
  if (!summary && output.includes('[summary]')) {
    const summaryStart = output.indexOf('[summary]') + '[summary]'.length;
    summary = output.slice(summaryStart).trim();
  }
  
  return { report, summary };
}

// Main two-tool analysis function
async function runTwoToolAnalysis(
  dataRefs: string[],
  question: string,
  pilotVariables: Map<string, any>,
  model: string,
  sendEvent: (data: any) => void
): Promise<{ summary: string; visuals: ParsedVisual[]; error?: string }> {
  const client = createOpenRouterClient();
  
  // Reset analysis variables
  resetAnalysisVariables();
  
  // Build table previews (same as before)
  let tablePreviews = '';
  const referencedVars: string[] = [];
  
  for (const ref of dataRefs) {
    const varName = ref.includes('[') ? ref.split('[')[0] : ref;
    if (!referencedVars.includes(varName)) {
      referencedVars.push(varName);
    }
  }
  
  for (const varName of referencedVars) {
    const pilotVar = pilotVariables.get(varName);
    if (pilotVar) {
      tablePreviews += buildTablePreview(varName, pilotVar) + '\n\n';
    }
  }
  
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`🔧 TWO-TOOL ANALYSIS SYSTEM`);
  console.log(`${'═'.repeat(80)}`);
  console.log(`Question: ${question}`);
  console.log(`Variables: ${referencedVars.join(', ')}`);
  
  sendEvent({ type: 'analysis_started', question, variables: referencedVars });
  
  // ==========================================
  // TOOL 1: Execution Planner
  // ==========================================
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`📋 TOOL 1: EXECUTION PLANNER`);
  console.log(`${'─'.repeat(40)}`);
  
  sendEvent({ type: 'analysis_phase', phase: 'planning' });
  
  const plannerPrompt = buildExecutionPlannerPrompt(tablePreviews, question);
  
  let plannerOutput = '';
  try {
    const plannerResponse = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: plannerPrompt },
        { role: 'user', content: 'Write your operations now:' }
      ],
      temperature: 0.3,
      max_tokens: 1500
    });
    plannerOutput = plannerResponse.choices[0]?.message?.content || '';
  } catch (error: any) {
    console.error(`[Execution Planner] Error:`, error.message);
    return { summary: 'Analysis failed - Execution Planner error', visuals: [], error: error.message };
  }
  
  console.log(`\n📝 PLANNER OUTPUT:\n${plannerOutput}\n`);
  
  // Parse operations
  const operations = parseExecutionPlan(plannerOutput);
  console.log(`\n✅ Parsed ${operations.length} operations`);
  
  if (operations.length === 0) {
    return { summary: 'Analysis failed - no operations parsed from planner', visuals: [], error: 'No operations' };
  }
  
  // ==========================================
  // Execute Operations
  // ==========================================
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`⚙️ EXECUTING OPERATIONS`);
  console.log(`${'─'.repeat(40)}`);
  
  sendEvent({ type: 'analysis_phase', phase: 'executing' });
  
  const results = await executeExecutionPlan(operations, pilotVariables, sendEvent);
  
  console.log(`\n✅ Executed ${results.length} operations`);
  for (const r of results) {
    if (r.error) {
      console.log(`   ❌ ${r.varName}: ${r.error}`);
    } else if (r.resultType === 'number') {
      console.log(`   📊 ${r.varName} = ${r.value}`);
    } else if (r.resultType === 'column') {
      console.log(`   📦 ${r.varName} (column: ${r.count} values)`);
    } else if (r.resultType === 'table') {
      console.log(`   📋 ${r.varName} (table: ${r.count} rows)`);
    }
  }
  
  // Build context for Report Writer
  const executionResultsContext = buildExecutionResultsContext(results);
  
  // ==========================================
  // TOOL 2: Report Writer
  // ==========================================
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`📝 TOOL 2: REPORT WRITER`);
  console.log(`${'─'.repeat(40)}`);
  
  sendEvent({ type: 'analysis_phase', phase: 'reporting' });
  
  const reportPrompt = buildReportWriterPrompt(tablePreviews, question, executionResultsContext);
  
  let reportOutput = '';
  try {
    const reportResponse = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: reportPrompt },
        { role: 'user', content: 'Write your [report] and [summary] now:' }
      ],
      temperature: 0.4,
      max_tokens: 2000
    });
    reportOutput = reportResponse.choices[0]?.message?.content || '';
  } catch (error: any) {
    console.error(`[Report Writer] Error:`, error.message);
    return { summary: 'Analysis failed - Report Writer error', visuals: [], error: error.message };
  }
  
  console.log(`\n📝 REPORT WRITER OUTPUT:\n${reportOutput}\n`);
  
  // Parse report and summary
  const { report, summary } = parseReportWriterOutput(reportOutput);
  
  if (!report) {
    console.log(`⚠️ No [report] block found`);
  }
  if (!summary) {
    console.log(`⚠️ No [summary] block found`);
  }
  
  // Parse visuals from report
  const { visuals } = parseAnalysisReport(report);
  
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`✅ ANALYSIS COMPLETE`);
  console.log(`   Visuals: ${visuals.length}`);
  console.log(`   Summary: ${summary.slice(0, 100)}...`);
  console.log(`${'═'.repeat(80)}\n`);
  
  sendEvent({ type: 'analysis_complete', summary: summary.slice(0, 200), visualCount: visuals.length });
  
  return { summary: summary || 'Analysis complete', visuals };
}

// ================================================================================
// LEGACY DATA ANALYSIS AGENT (kept for reference)
// ================================================================================

// Build the Data Analysis Agent prompt
function buildDataAnalysisAgentPrompt(
  tablePreviews: string,
  pilotRequest: string,
  availableAnalysisVars: string
): string {
  return `# DATA ANALYSIS AGENT

You analyze data by performing operations step-by-step. You see schemas and samples, not raw data.

================================================================================
## AVAILABLE DATA
================================================================================

${tablePreviews}

${availableAnalysisVars ? `## CREATED VARIABLES (from previous operations)\n${availableAnalysisVars}\n` : ''}

================================================================================
## REQUEST FROM PILOT
================================================================================

${pilotRequest}

================================================================================
## OPERATIONS
================================================================================

ALL operations with "variable_name: operation(...)" store the result in that variable.
You can then use that variable in subsequent operations.

### Aggregations (single number - value shown, stored in variable)
november_sessions_total: sum(november[sessions])     → Shows value AND stores it
october_sessions_average: average(october[sessions]) → Shows value AND stores it
peak_sessions: max(traffic[sessions])                → Shows value AND stores it
lowest_sessions: min(traffic[sessions])              → Shows value AND stores it
total_rows: count(traffic[date])                     → Shows value AND stores it

### Comparisons (single number - can use stored numbers OR columns)
sessions_difference: difference(november_sessions_total, october_sessions_total)  → Use stored numbers
revenue_ratio: ratio(sales[revenue], sales[cost])                                  → Use columns directly
growth_percentage: percentage(new_users_count, total_users_count)                  → Mix allowed
monthly_change: pct_change(october_sessions_total, november_sessions_total)        → Use stored numbers

### Transformations (column - stored in variable, value NOT shown)
high_traffic_days: filter(traffic[sessions], "> 1000")  → Stored, count shown
sorted_by_sessions: sort_asc(traffic[sessions])         → Stored, count shown
top_performers: sort_desc(revenue[amount])              → Stored, count shown

### Arithmetic with Numbers (column - stored in variable, value NOT shown)
adjusted_revenue: add(sales[revenue], 100)       → Stored, count shown
discounted_prices: subtract(items[price], 10)    → Stored, count shown
doubled_values: multiply(metrics[value], 2)      → Stored, count shown
halved_costs: divide(expenses[cost], 2)          → Stored, count shown

### Arithmetic with Columns (column - stored in variable, value NOT shown)
total_cost: add(orders[price], orders[shipping])        → Stored, count shown
profit_margin: subtract(sales[revenue], sales[cost])    → Stored, count shown
line_totals: multiply(items[quantity], items[price])    → Stored, count shown
conversion_rate: divide(events[clicks], events[views])  → Stored, count shown

### Table Creation (table - stored in variable)
summary_table: table(Label1: var[col1], Label2: var[col2], Label3: stored_number_var)

================================================================================
## COLUMN SIZE MISMATCH
================================================================================

When operating on two columns of different sizes, the system automatically uses 
the first N rows of the larger column to match the smaller one.
You'll see a note when this happens.

================================================================================
## OUTPUT FORMAT
================================================================================

### Each analysis step:
[thought]
Explain what you're doing and why
[/thought]

[execute]
one_operation_here
[/execute]

### Final step (when ready to report):
[thought]
Summarize your analysis approach
[/thought]

[report]
VISUAL_1: line-chart
  title: "Chart Title"
  x_data: var[col]
  y_data: var[col] OR created_variable
  x_label: "X Axis Label"
  y_label: "Y Axis Label"
  color: #hexcode

VISUAL_2: table
  caption: "Table Caption"
  data: created_table_variable

VISUAL_3: card
  content: |
    ## Heading
    Simple text explanation here.
    **Bold** and *italic* allowed.
    - Bullet points
    - More points
[/report]

[summary]
Key findings for Pilot agent: be concise and insightful about what you found.
This is sent back to the Pilot agent who orchestrates the overall task.
[/summary]

================================================================================
## IMPORTANT RULES
================================================================================

1. ONE operation per [execute] - wait for result before next step
2. Use DESCRIPTIVE and UNIQUE variable names:
   ✓ march_total_revenue, filtered_high_performers, quarterly_growth_rate
   ✗ result, data, temp, output, var1
3. NEVER reuse a variable name - each must be unique
4. [report] + [summary] are ONLY for the FINAL generation - not before!
5. Create any tables you need BEFORE your final generation (so you can reference them in report)
6. In VISUAL blocks, reference variables - don't write raw numbers
7. Card content: simple markdown only (NO tables in cards - use table operation)
8. [summary] goes back to Pilot agent - be clear and concise about key findings

================================================================================
## ⚠️ CRITICAL: ONE STEP AT A TIME
================================================================================

You MUST output only ONE [thought] + ONE [execute] per response.
Then STOP and WAIT for the system to return the result.
The system will tell you the result, then you continue with the next step.

DO NOT output multiple operations at once!
DO NOT output [report] or [summary] until your FINAL step!

================================================================================
## COMPLETE EXAMPLE FLOW
================================================================================

Pilot asks: "Compare Q1 and Q2 sales"
Available data: q1_sales (columns: product, revenue), q2_sales (columns: product, revenue)

╔══════════════════════════════════════════════════════════════════════════════╗
║ YOUR OUTPUT #1:                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
[thought]
First, calculate total revenue for Q1.
[/thought]

[execute]
q1_total_revenue: sum(q1_sales[revenue])
[/execute]

<<< STOP HERE - WAIT FOR SYSTEM >>>

╔══════════════════════════════════════════════════════════════════════════════╗
║ SYSTEM RESPONSE (you receive this):                                          ║
╚══════════════════════════════════════════════════════════════════════════════╝
Result: 45000 (stored in 'q1_total_revenue')

╔══════════════════════════════════════════════════════════════════════════════╗
║ YOUR OUTPUT #2:                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
[thought]
Good, Q1 is 45000. Now get Q2 total.
[/thought]

[execute]
q2_total_revenue: sum(q2_sales[revenue])
[/execute]

<<< STOP HERE - WAIT FOR SYSTEM >>>

╔══════════════════════════════════════════════════════════════════════════════╗
║ SYSTEM RESPONSE (you receive this):                                          ║
╚══════════════════════════════════════════════════════════════════════════════╝
Result: 52000 (stored in 'q2_total_revenue')

╔══════════════════════════════════════════════════════════════════════════════╗
║ YOUR OUTPUT #3:                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
[thought]
Calculate percentage change.
[/thought]

[execute]
quarterly_growth: pct_change(q1_total_revenue, q2_total_revenue)
[/execute]

<<< STOP HERE - WAIT FOR SYSTEM >>>

╔══════════════════════════════════════════════════════════════════════════════╗
║ SYSTEM RESPONSE (you receive this):                                          ║
╚══════════════════════════════════════════════════════════════════════════════╝
Result: 15.56% (stored in 'quarterly_growth')

╔══════════════════════════════════════════════════════════════════════════════╗
║ YOUR OUTPUT #4:                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
[thought]
Create summary table before final report.
[/thought]

[execute]
comparison_table: table(Quarter: ["Q1", "Q2"], Revenue: [q1_total_revenue, q2_total_revenue])
[/execute]

<<< STOP HERE - WAIT FOR SYSTEM >>>

╔══════════════════════════════════════════════════════════════════════════════╗
║ SYSTEM RESPONSE (you receive this):                                          ║
╚══════════════════════════════════════════════════════════════════════════════╝
Stored in 'comparison_table' (table: 2 rows)

╔══════════════════════════════════════════════════════════════════════════════╗
║ YOUR OUTPUT #5 (FINAL - now you can use [report] and [summary]):             ║
╚══════════════════════════════════════════════════════════════════════════════╝
[thought]
Analysis complete. Ready for final report.
[/thought]

[report]
VISUAL_1: table
  caption: "Quarterly Revenue Comparison"
  data: comparison_table

VISUAL_2: card
  content: |
    ## Summary
    Q2 revenue ($52,000) exceeded Q1 ($45,000) by **15.56%**.
[/report]

[summary]
Q2 outperformed Q1 by 15.56% ($52,000 vs $45,000). Created comparison table and summary card.
[/summary]

================================================================================

Begin your analysis now.
Output ONE [thought] + ONE [execute], then STOP and wait for the system result.
Only use [report] + [summary] on your FINAL output after all calculations are done.`;
}

// Parse the agent's response to extract thought, execute, report, and summary blocks
function parseAnalysisAgentResponse(response: string): {
  thought?: string;
  execute?: string;
  report?: string;
  summary?: string;
} {
  const result: { thought?: string; execute?: string; report?: string; summary?: string } = {};
  
  // Extract thought
  const thoughtMatch = response.match(/\[thought\]([\s\S]*?)\[\/thought\]/i);
  if (thoughtMatch) {
    result.thought = thoughtMatch[1].trim();
  }
  
  // Extract execute
  const executeMatch = response.match(/\[execute\]([\s\S]*?)\[\/execute\]/i);
  if (executeMatch) {
    result.execute = executeMatch[1].trim();
  }
  
  // Extract report
  const reportMatch = response.match(/\[report\]([\s\S]*?)\[\/report\]/i);
  if (reportMatch) {
    result.report = reportMatch[1].trim();
  }
  
  // Extract summary (separate tag - this goes back to Pilot)
  const summaryMatch = response.match(/\[summary\]([\s\S]*?)\[\/summary\]/i);
  if (summaryMatch) {
    result.summary = summaryMatch[1].trim();
  }
  
  return result;
}

// Parse the report section to extract visuals and summary
interface ParsedVisual {
  type: 'line-chart' | 'table' | 'card';
  properties: Record<string, any>;
}

function parseAnalysisReport(reportBlock: string): {
  visuals: ParsedVisual[];
} {
  const visuals: ParsedVisual[] = [];
  
  // Parse each VISUAL block
  const visualMatches = reportBlock.matchAll(/VISUAL_\d+:\s*(\S+)([\s\S]*?)(?=VISUAL_\d+:|$)/gi);
  
  for (const match of visualMatches) {
    const [, type, propsStr] = match;
    const properties: Record<string, any> = {};
    
    // Parse indented properties
    const lines = propsStr.trim().split('\n');
    let currentKey = '';
    let multilineValue = '';
    let inMultiline = false;
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;
      
      // Check for multiline start (content: |)
      if (trimmedLine.match(/^(\w+):\s*\|$/)) {
        const keyMatch = trimmedLine.match(/^(\w+):/);
        if (keyMatch) {
          currentKey = keyMatch[1];
          inMultiline = true;
          multilineValue = '';
        }
        continue;
      }
      
      // If in multiline, accumulate until next key
      if (inMultiline) {
        if (trimmedLine.match(/^\w+:/) && !trimmedLine.match(/^(http|https):/)) {
          // End of multiline
          properties[currentKey] = multilineValue.trim();
          inMultiline = false;
        } else {
          multilineValue += line.replace(/^\s{4}/, '') + '\n';
          continue;
        }
      }
      
      // Parse key: value
      const kvMatch = trimmedLine.match(/^(\w+):\s*(.+)$/);
      if (kvMatch) {
        const [, key, value] = kvMatch;
        properties[key] = value.trim();
      }
    }
    
    // Don't forget last multiline
    if (inMultiline && currentKey) {
      properties[currentKey] = multilineValue.trim();
    }
    
    // Clean up content property - remove surrounding quotes if present
    if (properties.content) {
      let content = properties.content;
      // Remove surrounding double quotes
      if (content.startsWith('"') && content.endsWith('"')) {
        content = content.slice(1, -1);
      }
      // Remove surrounding single quotes
      if (content.startsWith("'") && content.endsWith("'")) {
        content = content.slice(1, -1);
      }
      properties.content = content;
    }
    
    visuals.push({
      type: type.toLowerCase() as 'line-chart' | 'table' | 'card',
      properties
    });
  }
  
  return { visuals };
}

// Build available analysis variables string for prompt
function buildAvailableAnalysisVars(): string {
  if (analysisVariables.size === 0) return '';
  
  let result = '';
  for (const [name, variable] of analysisVariables) {
    if (variable.type === 'column') {
      result += `• ${name} (column: ${variable.data.length} values)\n`;
    } else if (variable.type === 'table') {
      result += `• ${name} (table: ${variable.data.length} rows, columns: ${variable.columns?.join(', ')})\n`;
    } else if (variable.type === 'number') {
      result += `• ${name} = ${variable.data} (stored number)\n`;
    }
  }
  return result;
}

// Main Data Analysis Agent execution function
async function executeDataAnalysisAgent(
  dataRefs: string[],
  question: string,
  pilotVariables: Map<string, any>,
  model: string,
  sendEvent: (data: any) => void
): Promise<{ summary: string; visuals: ParsedVisual[]; error?: string }> {
  const client = createOpenRouterClient();
  const MAX_ITERATIONS = 15;
  const MAX_RETRIES = 3;
  
  // Reset analysis variables for new analysis
  resetAnalysisVariables();
  
  // Build table previews for all referenced variables
  let tablePreviews = '';
  const referencedVars = new Set<string>();
  
  for (const ref of dataRefs) {
    const match = ref.match(/^([a-zA-Z_][a-zA-Z0-9_]*)/);
    if (match) {
      referencedVars.add(match[1]);
    }
  }
  
  for (const varName of referencedVars) {
    const variable = pilotVariables.get(varName);
    if (variable) {
      tablePreviews += buildTablePreview(varName, variable) + '\n';
    }
  }
  
  if (!tablePreviews) {
    return { summary: 'No data available for analysis', visuals: [], error: 'No valid data references' };
  }
  
  sendEvent({ type: 'analysis_started', question, variables: Array.from(referencedVars) });
  
  // Conversation history for the agent
  const messages: Array<{ role: string; content: string }> = [];
  
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    // Build prompt with current state
    const availableAnalysisVars = buildAvailableAnalysisVars();
    const systemPrompt = buildDataAnalysisAgentPrompt(tablePreviews, question, availableAnalysisVars);
    
    // Build message for this turn
    let userMessage = '';
    if (iteration === 0) {
      userMessage = 'Begin your analysis. What is your first step?';
    } else {
      // Include the result of the last operation
      userMessage = 'Continue your analysis. What is your next step?';
    }
    
    messages.push({ role: 'user', content: userMessage });
    
    sendEvent({ type: 'analysis_thinking', iteration: iteration + 1 });
    
    // Call LLM with retry logic
    let agentResponse = '';
    let retryCount = 0;
    
    while (retryCount < MAX_RETRIES) {
      try {
        const response = await client.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            ...messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
          ],
          temperature: 0.3,
          max_tokens: 2000
        });
        
        agentResponse = response.choices[0]?.message?.content || '';
        
        if (agentResponse.trim()) {
          break; // Success
        }
        
        retryCount++;
        sendEvent({ type: 'analysis_retry', reason: 'empty_response', attempt: retryCount });
      } catch (error: any) {
        retryCount++;
        sendEvent({ type: 'analysis_retry', reason: 'error', error: error.message, attempt: retryCount });
        
        if (retryCount >= MAX_RETRIES) {
          return { summary: 'Analysis failed due to errors', visuals: [], error: error.message };
        }
      }
    }
    
    if (!agentResponse.trim()) {
      return { summary: 'Analysis failed - no response from agent', visuals: [], error: 'Empty response after retries' };
    }
    
    // TERMINAL LOGGING - Complete Analysis Agent Output
    console.log(`\n${'═'.repeat(80)}`);
    console.log(`📊 ANALYSIS AGENT - ITERATION ${iteration + 1}`);
    console.log(`${'═'.repeat(80)}`);
    console.log(`\n📝 COMPLETE RAW OUTPUT:\n`);
    console.log(agentResponse);
    console.log(`\n${'─'.repeat(80)}`);
    
    // Parse the response
    const parsed = parseAnalysisAgentResponse(agentResponse);
    
    // Log parsed components
    console.log(`\n🔍 PARSED COMPONENTS:`);
    console.log(`   [thought]: ${parsed.thought ? `✅ (${parsed.thought.length} chars)` : '❌ missing'}`);
    console.log(`   [execute]: ${parsed.execute ? `✅ "${parsed.execute}"` : '❌ missing'}`);
    console.log(`   [report]:  ${parsed.report ? `✅ (${parsed.report.length} chars)` : '❌ missing'}`);
    console.log(`   [summary]: ${parsed.summary ? `✅ (${parsed.summary.length} chars)` : '❌ missing'}`);
    console.log(`${'═'.repeat(80)}\n`);
    
    sendEvent({
      type: 'analysis_step',
      iteration: iteration + 1,
      thought: parsed.thought,
      execute: parsed.execute,
      hasExecute: !!parsed.execute,
      hasReport: !!parsed.report,
      hasSummary: !!parsed.summary
    });
    
    // Add agent response to history
    messages.push({ role: 'assistant', content: agentResponse });
    
    // Check if we have a report AND summary (final step)
    // Both are required - report contains visuals, summary goes back to Pilot
    if (parsed.report && parsed.summary) {
      sendEvent({ type: 'analysis_report_generated' });
      const { visuals } = parseAnalysisReport(parsed.report);
      return { summary: parsed.summary, visuals };
    }
    
    // If only report without summary, prompt agent to provide summary
    if (parsed.report && !parsed.summary) {
      const missingMsg = 'You provided [report] but missing [summary]. Please add [summary] with key findings for the Pilot agent.';
      messages.push({ role: 'user', content: missingMsg });
      continue;
    }
    
    // Execute the operation if present
    if (parsed.execute) {
      const operation = parseAnalysisOperation(parsed.execute);
      
      console.log(`\n⚙️  OPERATION PARSING:`);
      console.log(`   Raw: "${parsed.execute}"`);
      console.log(`   Parsed: ${operation ? JSON.stringify(operation, null, 2) : 'FAILED TO PARSE'}`);
      
      if (!operation) {
        // Add error message to conversation
        const errorMsg = `Error: Could not parse operation "${parsed.execute}". Please check syntax.`;
        console.log(`   ❌ ${errorMsg}`);
        messages.push({ role: 'user', content: errorMsg });
        sendEvent({ type: 'analysis_operation_error', error: errorMsg });
        continue;
      }
      
      const result = executeAnalysisOperation(operation, pilotVariables);
      
      console.log(`\n📊 OPERATION RESULT:`);
      console.log(`   ${result}`);
      
      // Log current analysis variables
      console.log(`\n📦 ANALYSIS VARIABLES (${analysisVariables.size} total):`);
      for (const [name, variable] of analysisVariables) {
        if (variable.type === 'number') {
          console.log(`   • ${name} = ${variable.data} (number)`);
        } else if (variable.type === 'column') {
          console.log(`   • ${name} (column: ${variable.data.length} values)`);
        } else if (variable.type === 'table') {
          console.log(`   • ${name} (table: ${variable.data.length} rows)`);
        }
      }
      console.log(`${'─'.repeat(80)}\n`);
      
      sendEvent({
        type: 'analysis_operation_result',
        operation: parsed.execute,
        result
      });
      
      // Add result to conversation
      messages.push({ role: 'user', content: result });
    } else if (!parsed.report) {
      // No execute and no report - prompt for next action
      console.log(`\n⚠️  No [execute] or [report] found - prompting agent for action`);
      messages.push({ role: 'user', content: 'Please provide an [execute] block with an operation, or a [report] block if analysis is complete.' });
    }
  }
  
  // Max iterations reached
  sendEvent({ type: 'analysis_max_iterations' });
  return { 
    summary: 'Analysis reached maximum iterations without completing. Partial results may be available.', 
    visuals: [],
    error: 'Max iterations reached'
  };
}

// ================================================================================
// END OF DATA ANALYSIS AGENT - Phase 2
// ================================================================================

// ================================================================================
// DATA ANALYSIS AGENT - Phase 3: UI Rendering
// ================================================================================

// Build prompt for UI Component LLM
function buildUIComponentPrompt(
  visualInstruction: ParsedVisual,
  availableVars: string
): string {
  return `# UI COMPONENT GENERATOR

Convert the visual instruction into exact component syntax.

================================================================================
## VISUAL INSTRUCTION
================================================================================

Type: ${visualInstruction.type}
Properties:
${Object.entries(visualInstruction.properties).map(([k, v]) => `  ${k}: ${v}`).join('\n')}

================================================================================
## AVAILABLE DATA
================================================================================

${availableVars}

================================================================================
## OUTPUT SYNTAX
================================================================================

For line-chart:
line-chart(x_data: var[col], y_data: var[col], x_label: "Label", y_label: "Label", colour: "#hexcode")

For table:
table({column_name: "Label", data: var[col]}, {column_name: "Label", data: var[col]})

For card:
card("## Title\\n\\nMarkdown content here\\n\\n- Bullet\\n- Points")

================================================================================
## RULES
================================================================================

1. Output ONLY the component syntax - no explanation, no markdown
2. For table data references, use the exact variable[column] format
3. For analysis variables (created by operations), use just the variable name
4. Escape newlines in card content with \\n
5. Use the exact title, labels, and colors from the instruction

================================================================================

Write the component syntax now:`;
}

// Build available variables string for UI LLM
function buildAvailableVarsForUI(
  pilotVariables: Map<string, any>,
  analysisVars: Map<string, AnalysisVariable>
): string {
  let result = 'Pilot Variables:\n';
  
  for (const [name, variable] of pilotVariables) {
    const fields = Object.keys(variable.schema || {}).join(', ');
    result += `• ${name}: ${fields}\n`;
    result += `  Access: ${Object.keys(variable.schema || {}).map(f => `${name}[${f}]`).join(', ')}\n`;
  }
  
  if (analysisVars.size > 0) {
    result += '\nAnalysis Variables (created by operations):\n';
    for (const [name, variable] of analysisVars) {
      if (variable.type === 'column') {
        result += `• ${name}: array of ${variable.data.length} values (use directly: ${name})\n`;
      } else if (variable.type === 'table') {
        result += `• ${name}: table with columns [${variable.columns?.join(', ')}] (use: ${name})\n`;
      }
    }
  }
  
  return result;
}

// Render all visuals from the analysis report (fully programmatic, no LLM)
function renderReportVisuals(
  visuals: ParsedVisual[],
  pilotVariables: Map<string, any>,
  sendEvent: (data: any) => void
): string[] {
  const generatedDSL: string[] = [];
  
  // Helper to clean property values (remove surrounding quotes)
  const cleanProp = (value: string | undefined): string => {
    if (!value) return '';
    let cleaned = value.trim();
    // Remove surrounding double quotes
    if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
      cleaned = cleaned.slice(1, -1);
    }
    // Remove surrounding single quotes
    if (cleaned.startsWith("'") && cleaned.endsWith("'")) {
      cleaned = cleaned.slice(1, -1);
    }
    return cleaned;
  };
  
  for (let i = 0; i < visuals.length; i++) {
    const visual = visuals[i];
    
    sendEvent({
      type: 'ui_rendering',
      visualIndex: i + 1,
      totalVisuals: visuals.length,
      visualType: visual.type
    });
    
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`🎨 RENDERING VISUAL ${i + 1}: ${visual.type.toUpperCase()}`);
    console.log(`${'─'.repeat(60)}`);
    console.log(`📥 Properties from Report Writer:`);
    for (const [key, value] of Object.entries(visual.properties)) {
      console.log(`   ${key}: ${String(value).slice(0, 100)}`);
    }
    
    // ========================================
    // CARD - Render programmatically
    // ========================================
    if (visual.type === 'card') {
      let content = visual.properties.content || '';
      
      // Clean surrounding quotes
      content = cleanProp(content);
      
      // Escape for DSL syntax
      const escapedContent = content.replace(/\n/g, '\\n').replace(/"/g, '\\"');
      const dsl = `card: (title: "", content: "${escapedContent}")`;
      generatedDSL.push(dsl);
      
      console.log(`\n📤 GENERATED DSL:`);
      console.log(`   ${dsl.slice(0, 500)}${dsl.length > 500 ? '...' : ''}`);
      console.log(`${'─'.repeat(60)}\n`);
      
      sendEvent({ type: 'ui_component_generated', index: i + 1, componentType: 'card' });
      continue;
    }
    
    // ========================================
    // TABLE - Render programmatically
    // ========================================
    if (visual.type === 'table') {
      const dataRef = cleanProp(visual.properties.data);
      const caption = cleanProp(visual.properties.caption || visual.properties.title) || 'Data Table';
      
      // Check if it's an analysis table variable
      const tableVar = analysisVariables.get(dataRef);
      if (tableVar && tableVar.type === 'table' && tableVar.columns) {
        // Build table data from analysis variable
        const colsStr = JSON.stringify(tableVar.columns);
        const dataStr = JSON.stringify(tableVar.data);
        const dsl = `table: (columns: ${colsStr}, data: ${dataStr}, caption: "${caption}")`;
        generatedDSL.push(dsl);
        
        console.log(`\n📤 GENERATED DSL (from analysis variable):`);
        console.log(`   Columns: ${tableVar.columns.join(', ')}`);
        console.log(`   Rows: ${tableVar.data.length}`);
        console.log(`   Caption: ${caption}`);
        console.log(`${'─'.repeat(60)}\n`);
        
        sendEvent({ type: 'ui_component_generated', index: i + 1, componentType: 'table' });
        continue;
      }
      
      // Check if it's a pilot variable
      const pilotVar = pilotVariables.get(dataRef);
      if (pilotVar && pilotVar.actualData) {
        const data = Array.isArray(pilotVar.actualData) ? pilotVar.actualData : [pilotVar.actualData];
        const columns = Object.keys(pilotVar.schema || data[0] || {});
        const colsStr = JSON.stringify(columns);
        const dataStr = JSON.stringify(data);
        const dsl = `table: (columns: ${colsStr}, data: ${dataStr}, caption: "${caption}")`;
        generatedDSL.push(dsl);
        
        console.log(`\n📤 GENERATED DSL (from pilot variable):`);
        console.log(`   Columns: ${columns.join(', ')}`);
        console.log(`   Rows: ${data.length}`);
        console.log(`   Caption: ${caption}`);
        console.log(`${'─'.repeat(60)}\n`);
        
        sendEvent({ type: 'ui_component_generated', index: i + 1, componentType: 'table' });
        continue;
      }
      
      console.log(`\n⚠️ Could not resolve table data: ${dataRef}`);
      console.log(`${'─'.repeat(60)}\n`);
      continue;
    }
    
    // ========================================
    // LINE-CHART - Render programmatically
    // ========================================
    if (visual.type === 'line-chart') {
      const xDataRef = cleanProp(visual.properties.x_data);
      const yDataRef = cleanProp(visual.properties.y_data);
      const xLabel = cleanProp(visual.properties.x_label) || 'X';
      const yLabel = cleanProp(visual.properties.y_label) || 'Y';
      const title = cleanProp(visual.properties.title) || `${yLabel} over ${xLabel}`;
      const colour = cleanProp(visual.properties.color || visual.properties.colour) || '#2563eb';
      
      console.log(`\n🔍 Resolving data references:`);
      console.log(`   x_data: ${xDataRef}`);
      console.log(`   y_data: ${yDataRef}`);
      
      // Resolve x_data
      const xData = resolveDataReference(xDataRef, pilotVariables, analysisVariables);
      const yData = resolveDataReference(yDataRef, pilotVariables, analysisVariables);
      
      console.log(`   x_data resolved: ${xData ? `${xData.length} values` : 'NOT FOUND'}`);
      console.log(`   y_data resolved: ${yData ? `${yData.length} values` : 'NOT FOUND'}`);
      
      if (!xData || !yData) {
        console.log(`\n⚠️ Could not resolve chart data`);
        console.log(`${'─'.repeat(60)}\n`);
        continue;
      }
      
      // Build chart data
      const chartData = [];
      for (let j = 0; j < Math.min(xData.length, yData.length); j++) {
        chartData.push({ x: xData[j], y: yData[j] });
      }
      
      const dataStr = JSON.stringify(chartData);
      const dsl = `line-chart: [(data: ${dataStr}, x-data: x, y-data: y, colour: ${colour}, title: "${title}", label_x: "${xLabel}", label_y: "${yLabel}"), chart_${Date.now()}]`;
      generatedDSL.push(dsl);
      
      console.log(`\n📤 GENERATED DSL:`);
      console.log(`   Data points: ${chartData.length}`);
      console.log(`   Title: ${title}`);
      console.log(`   Colour: ${colour}`);
      console.log(`${'─'.repeat(60)}\n`);
      
      sendEvent({ type: 'ui_component_generated', index: i + 1, componentType: 'line-chart' });
      continue;
    }
    
    // Unknown visual type
    console.log(`\n⚠️ Unknown visual type: ${visual.type}`);
    console.log(`${'─'.repeat(60)}\n`);
  }
  
  return generatedDSL;
}

// Helper function to resolve data references for charts
function resolveDataReference(
  ref: string,
  pilotVariables: Map<string, any>,
  analysisVars: Map<string, AnalysisVariable>
): any[] | null {
  if (!ref) return null;
  
  // Parse variable[column] format
  const match = ref.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([a-zA-Z_][a-zA-Z0-9_]*)\]$/);
  
  if (match) {
    const [, varName, colName] = match;
    
    // Check analysis variables first
    const analysisVar = analysisVars.get(varName);
    if (analysisVar) {
      if (analysisVar.type === 'column') {
        return analysisVar.data;
      } else if (analysisVar.type === 'table') {
        return analysisVar.data.map((row: any) => row[colName]);
      }
    }
    
    // Check pilot variables
    const pilotVar = pilotVariables.get(varName);
    if (pilotVar && pilotVar.actualData) {
      if (Array.isArray(pilotVar.actualData)) {
        return pilotVar.actualData.map((item: any) => {
          if (typeof item === 'object' && item !== null) {
            return item[colName];
          }
          return item;
        });
      }
    }
  } else {
    // Just variable name (for analysis column variables)
    const analysisVar = analysisVars.get(ref);
    if (analysisVar && analysisVar.type === 'column') {
      return analysisVar.data;
    }
  }
  
  return null;
}

// Execute the generated UI components through the existing executeUITool
function executeGeneratedUIComponents(
  dslList: string[],
  pilotVariables: Map<string, any>,
  sendEvent: (data: any) => void
): string[] {
  const results: string[] = [];
  
  // Create a combined variables map that includes both pilot and analysis variables
  const combinedVariables = new Map<string, any>(pilotVariables);
  
  // Add analysis variables in a format compatible with resolveVariableRef
  for (const [name, analysisVar] of analysisVariables) {
    if (analysisVar.type === 'column') {
      // Store as a simple array that can be accessed directly
      combinedVariables.set(name, {
        name,
        schema: { value: { description: 'Analysis result', data_type: 'array' } },
        actualData: analysisVar.data,
        description: `Analysis variable: ${name}`
      });
    } else if (analysisVar.type === 'table') {
      // Store table with proper structure
      const schema: Record<string, any> = {};
      for (const col of analysisVar.columns || []) {
        schema[col] = { description: `Column: ${col}`, data_type: 'string' };
      }
      combinedVariables.set(name, {
        name,
        schema,
        actualData: analysisVar.data,
        description: `Analysis table: ${name}`
      });
    }
  }
  
  for (const dsl of dslList) {
    try {
      // Parse the DSL to determine tool type
      const toolMatch = dsl.match(/^(line-chart|table|card|alert)\s*\(/);
      if (!toolMatch) {
        results.push(dsl); // Keep as-is if can't parse
        continue;
      }
      
      const toolName = toolMatch[1];
      const argsStart = dsl.indexOf('(');
      const argsEnd = dsl.lastIndexOf(')');
      const argsStr = dsl.substring(argsStart + 1, argsEnd);
      
      // Execute through existing UI tool function
      const result = executeUITool(
        toolName,
        argsStr,
        combinedVariables as Map<string, ToolCallVariable>,
        sendEvent
      );
      
      results.push(result.dsl);
    } catch (error: any) {
      sendEvent({ type: 'ui_execute_error', dsl: dsl.slice(0, 50), error: error.message });
      results.push(dsl); // Keep original on error
    }
  }
  
  return results;
}

// Complete Data Analysis flow: two-tool architecture (Execution Planner + Report Writer)
async function runDataAnalysisWithVisuals(
  dataRefs: string[],
  question: string,
  pilotVariables: Map<string, any>,
  model: string,
  sendEvent: (data: any) => void
): Promise<{ summary: string; generatedDSL: string[]; error?: string }> {
  
  // Use the new two-tool analysis system
  const analysisResult = await runTwoToolAnalysis(
    dataRefs,
    question,
    pilotVariables,
    model,
    sendEvent
  );
  
  if (analysisResult.error && analysisResult.visuals.length === 0) {
    return { summary: analysisResult.summary, generatedDSL: [], error: analysisResult.error };
  }
  
  // Render the visuals from the report (fully programmatic, no LLM)
  sendEvent({ type: 'analysis_phase', phase: 'rendering', visualCount: analysisResult.visuals.length });
  const rawDSL = renderReportVisuals(
    analysisResult.visuals,
    pilotVariables,
    sendEvent
  );
  
  // Execute the UI components
  const executedDSL = executeGeneratedUIComponents(
    rawDSL,
    pilotVariables,
    sendEvent
  );
  
  return {
    summary: analysisResult.summary,
    generatedDSL: executedDSL
  };
}

// ================================================================================
// END OF DATA ANALYSIS AGENT - Phase 3
// ================================================================================

// Execute UI tools (line-chart, table, card, alert)
function executeUITool(
  toolName: string,
  args: any,
  variables: Map<string, ToolCallVariable>,
  sendEvent: (data: any) => void
): { dsl: string; message: string } {
  sendEvent({ type: 'ui_creating', tool: toolName });
  
  switch (toolName) {
    case 'line-chart': {
      const xData = resolveVariableRef(args.x_data || args.xData, variables);
      const yData = resolveVariableRef(args.y_data || args.yData, variables);
      const xLabel = args.x_label || args.xLabel || 'X';
      const yLabel = args.y_label || args.yLabel || 'Y';
      const colour = args.colour || args.color || '#2563eb';
      
      // Build chart data
      const chartData = [];
      if (Array.isArray(xData) && Array.isArray(yData)) {
        for (let i = 0; i < Math.min(xData.length, yData.length); i++) {
          chartData.push({ x: xData[i], y: yData[i] });
        }
      }
      
      const dataStr = JSON.stringify(chartData).replace(/"/g, '"');
      const dsl = `line-chart: [(data: ${dataStr}, x-data: x, y-data: y, colour: ${colour}, title: "${yLabel} over ${xLabel}", label_x: "${xLabel}", label_y: "${yLabel}"), chart_${Date.now()}]`;
      
      sendEvent({ type: 'ui_created', tool: 'line-chart', dslPreview: dsl.slice(0, 100) });
      return { dsl, message: 'Line chart displayed to user' };
    }
    
    case 'table': {
      // Parse table format: {column_name: "X", data: var[key]}, ...
      const columns: string[] = [];
      const dataArrays: any[][] = [];
      
      // Parse the table args string
      const tableArgsStr = typeof args === 'string' ? args : JSON.stringify(args);
      const columnMatches = tableArgsStr.matchAll(/\{[^}]*column_name\s*:\s*["']?([^"',}]+)["']?\s*,\s*data\s*:\s*([^}]+)\}/g);
      
      for (const match of columnMatches) {
        const [, colName, dataRef] = match;
        columns.push(colName.trim());
        const resolved = resolveVariableRef(dataRef.trim(), variables);
        dataArrays.push(Array.isArray(resolved) ? resolved : [resolved]);
      }
      
      // Build table data
      const tableData = [];
      const maxRows = Math.max(...dataArrays.map(arr => arr.length), 0);
      for (let i = 0; i < maxRows; i++) {
        const row: Record<string, any> = {};
        columns.forEach((col, idx) => {
          row[col] = dataArrays[idx]?.[i] ?? '';
        });
        tableData.push(row);
      }
      
      const colsStr = JSON.stringify(columns);
      const dataStr = JSON.stringify(tableData);
      const dsl = `table: (columns: ${colsStr}, data: ${dataStr}, caption: "Data Table")`;
      
      sendEvent({ type: 'ui_created', tool: 'table', rows: tableData.length, columns: columns.length });
      return { dsl, message: 'Table displayed to user' };
    }
    
    case 'card': {
      const content = typeof args === 'string' ? args : args.content || '';
      const dsl = `card: (title: "", content: "${content.replace(/"/g, '\\"').replace(/\n/g, '\\n')}")`;
      sendEvent({ type: 'ui_created', tool: 'card' });
      return { dsl, message: 'Card displayed to user' };
    }
    
    case 'alert': {
      const content = typeof args === 'string' ? args : args.content || '';
      const dsl = `alert: (title: "Notice", description: "${content.replace(/"/g, '\\"').replace(/\n/g, '\\n')}")`;
      sendEvent({ type: 'ui_created', tool: 'alert' });
      return { dsl, message: 'Alert displayed to user' };
    }
    
    default:
      return { dsl: '', message: `Unknown UI tool: ${toolName}` };
  }
}

// ============================================================================
// PILOT SYSTEM MAIN LOOP
// ============================================================================

// Run the Executor agent for a SINGLE step
async function runExecutorAgent(
  task: string,
  mentionedTools: string[],
  variables: Map<string, PilotVariable>,
  generatedDSL: string[],
  model: string,
  sendEvent: (data: any) => void
): Promise<{ success: boolean; report: string; newVariables: string[] }> {
  const client = createOpenRouterClient();
  const toolDocs = buildToolDocsForExecutor(mentionedTools);
  const newVariables: string[] = [];
  
  // Build variables context with descriptions
  let variablesContext = '';
  if (variables.size > 0) {
    variablesContext = `⚠️ These ${variables.size} variable(s) ALREADY EXIST - use them, don't refetch!\n\n`;
    for (const [name, variable] of variables) {
      const accessKeys = Object.keys(variable.schema)
        .map(key => `${name}[${key}]`)
        .join(', ');
      variablesContext += `📦 ${name}\n`;
      variablesContext += `   Description: ${variable.description}\n`;
      variablesContext += `   Access via: ${accessKeys}\n\n`;
    }
    variablesContext += `⚠️ DO NOT create a new variable with any of these names - it will OVERWRITE!`;
  }
  
  sendEvent({
    type: 'executor_started',
    task: task.slice(0, 200),
    tools: mentionedTools
  });
  
  const systemPrompt = buildExecutorPrompt(task, toolDocs, variablesContext, '(Execute this single step)');
  
  const messages: any[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'Execute this step now. Write ONE tool call then DONE with summary.' }
  ];
  
  sendEvent({
    type: 'executor_thinking',
    iteration: 1,
    progress: 0
  });
  
  try {
    const response = await client.chat.completions.create({
      model,
      messages,
      temperature: 0.3,
      max_tokens: 800
    });
    
    const executorResponse = response.choices[0]?.message?.content || '';
    
    sendEvent({
      type: 'executor_response',
      iteration: 1,
      response: executorResponse
    });
    
    // Parse tool call from response
    console.log(`\n[Executor] Parsing tool calls from response...`);
    console.log(`[Executor] Response length: ${executorResponse.length} chars`);
    
    const toolCalls = parseToolCalls(executorResponse);
    
    console.log(`[Executor] Parsed ${toolCalls.length} tool call(s)`);
    if (toolCalls.length > 0) {
      console.log(`[Executor] First call: ${toolCalls[0].toolName}(${JSON.stringify(toolCalls[0].args).slice(0, 200)})`);
    }
    
    if (toolCalls.length === 0) {
      // Maybe Executor just said DONE without a tool call
      const doneMatch = executorResponse.match(/DONE:\s*(.+)/is);
      if (doneMatch) {
        console.log(`[Executor] No tool call found, but found DONE - returning report`);
        return { success: true, report: doneMatch[1].trim(), newVariables };
      }
      console.log(`[Executor] ERROR: No tool call and no DONE found`);
      return { success: false, report: 'Could not parse tool call from Executor response', newVariables };
    }
    
    const call = toolCalls[0];
    let toolResponse = '';
    let report = '';
    
    sendEvent({
      type: 'executor_calling_tool',
      tool: call.toolName,
      variable: call.variableName,
      raw: call.raw
    });
    
    // Execute the tool
    if (call.toolName === 'llm') {
      // LLM tool - now uses Data Analysis Agent
      const parsedRefs: string[] = [];
      
      console.log(`[Executor LLM/Analysis] Raw call.args: ${JSON.stringify(call.args)}`);
      
      // The args might be a string (raw args) or object (parsed key-value pairs)
      let dataStr = '';
      let questionStr = '';
      
      if (typeof call.args === 'string') {
        // Raw args string - parse it ourselves
        const dataMatch = call.args.match(/data:\s*\[([^\]]+)\]/);
        if (dataMatch) {
          dataStr = dataMatch[1];
        }
        const questionMatch = call.args.match(/question:\s*["']([^"']+)["']/);
        if (questionMatch) {
          questionStr = questionMatch[1];
        }
      } else if (typeof call.args === 'object') {
        dataStr = String(call.args.data || '');
        questionStr = call.args.question || '';
      }
      
      console.log(`[Executor LLM/Analysis] dataStr: ${dataStr}`);
      console.log(`[Executor LLM/Analysis] questionStr: ${questionStr}`);
      
      // Extract all variable references (both var[col] and just var)
      const refMatches = dataStr.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*(?:\[[a-zA-Z_][a-zA-Z0-9_]*\])?)/g);
      for (const match of refMatches) {
        if (match[1].includes('[') || variables.has(match[1])) {
          parsedRefs.push(match[1]);
        }
      }
      
      console.log(`[Executor LLM/Analysis] Parsed refs: ${JSON.stringify(parsedRefs)}`);
      
      const question = questionStr;
      
      // Print Analysis Agent call to terminal
      console.log(`\n${'='.repeat(70)}`);
      console.log(`📊 DATA ANALYSIS AGENT CALLED`);
      console.log(`   Data refs: ${parsedRefs.join(', ')}`);
      console.log(`   Question: ${question}`);
      console.log(`${'='.repeat(70)}\n`);
      
      // Use the new Data Analysis Agent with visuals
      const analysisResult = await runDataAnalysisWithVisuals(
        parsedRefs,
        question,
        variables as Map<string, any>,
        model,
        sendEvent
      );
      
      // Add generated DSL to the output
      for (const dsl of analysisResult.generatedDSL) {
        generatedDSL.push(dsl);
      }
      
      // Print Analysis summary to terminal
      console.log(`\n${'='.repeat(70)}`);
      console.log(`📊 DATA ANALYSIS COMPLETE`);
      console.log(`   Summary: ${analysisResult.summary.slice(0, 500)}`);
      console.log(`   Visuals generated: ${analysisResult.generatedDSL.length}`);
      if (analysisResult.error) {
        console.log(`   Error: ${analysisResult.error}`);
      }
      console.log(`${'='.repeat(70)}\n`);
      
      // Only the summary goes back to the Pilot
      toolResponse = `Analysis complete. Summary: ${analysisResult.summary}`;
      report = `Data Analysis Agent completed. ${analysisResult.generatedDSL.length} visualizations created. Summary: ${analysisResult.summary}`;
    }
    else if (call.toolName === 'extractor') {
      // Extractor tool - extracts specific values from variables
      const parsedRefs: string[] = [];
      let dataStr = '';
      let extractStr = '';
      
      if (typeof call.args === 'string') {
        // Raw args string - parse it ourselves
        const dataMatch = call.args.match(/data:\s*\[([^\]]+)\]/);
        if (dataMatch) {
          dataStr = dataMatch[1];
        }
        const extractMatch = call.args.match(/extract:\s*["']([^"']+)["']/);
        if (extractMatch) {
          extractStr = extractMatch[1];
        }
      } else if (typeof call.args === 'object') {
        dataStr = String(call.args.data || '');
        extractStr = call.args.extract || '';
      }
      
      console.log(`[Executor Extractor] dataStr: ${dataStr}`);
      console.log(`[Executor Extractor] extractStr: ${extractStr}`);
      
      // Extract all variable references
      const refMatches = dataStr.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*\[[a-zA-Z_][a-zA-Z0-9_]*\])/g);
      for (const match of refMatches) {
        parsedRefs.push(match[1]);
      }
      
      console.log(`[Executor Extractor] Parsed refs: ${JSON.stringify(parsedRefs)}`);
      
      const { extracted, rawText } = await executeExtractorTool(
        parsedRefs,
        extractStr,
        variables as Map<string, ToolCallVariable>,
        model,
        sendEvent
      );
      
      // Check if extraction failed
      if (rawText === 'NOT_FOUND' || rawText.toLowerCase().includes('not found')) {
        toolResponse = `NOT_FOUND`;
        report = `Extractor could not find the requested data.`;
      } else if (call.variableName) {
        // Store the extracted value in a variable
        const isArray = Array.isArray(extracted);
        const isObject = typeof extracted === 'object' && !isArray && extracted !== null;
        
        let schema: Record<string, any>;
        let actualData: any;
        
        if (isArray) {
          schema = { values: { description: 'Extracted array of values', data_type: 'array' } };
          actualData = { values: extracted };
        } else if (isObject) {
          schema = {};
          for (const key of Object.keys(extracted)) {
            schema[key] = { description: `Extracted field: ${key}`, data_type: typeof extracted[key] };
          }
          actualData = extracted;
        } else {
          // Simple value (string, number, etc.)
          schema = { value: { description: 'Extracted value', data_type: typeof extracted } };
          actualData = { value: extracted };
        }
        
        variables.set(call.variableName, {
          name: call.variableName,
          schema,
          actualData,
          description: `Extracted value`
        });
        newVariables.push(call.variableName);
        
        // Print variable details to terminal (for debugging only)
        console.log(`\n${'='.repeat(60)}`);
        console.log(`📦 VARIABLE CREATED: ${call.variableName}`);
        console.log(`   Tool: extractor`);
        console.log(`   Available fields:`);
        for (const key of Object.keys(schema)) {
          console.log(`     → ${call.variableName}[${key}]`);
        }
        console.log(`   Value (debug only):`);
        console.log(`     ${JSON.stringify(actualData, null, 2).split('\n').join('\n     ')}`);
        console.log(`${'='.repeat(60)}\n`);
        
        // DON'T show the actual value to the agent - just confirm storage
        toolResponse = `Stored in '${call.variableName}'. You can use ${call.variableName}[value] in subsequent tool calls.`;
        report = `Extracted and stored in variable '${call.variableName}'.`;
      } else {
        toolResponse = `Extraction completed but no variable name provided to store the result.`;
        report = `Extractor ran but result was not stored (no variable name).`;
      }
    }
    else if (['line-chart', 'table', 'card', 'alert'].includes(call.toolName)) {
      // UI tools
      console.log(`\n${'='.repeat(60)}`);
      console.log(`🎨 UI TOOL: ${call.toolName}`);
      console.log(`${'='.repeat(60)}\n`);
      
      const result = executeUITool(call.toolName, call.args, variables as Map<string, ToolCallVariable>, sendEvent);
      generatedDSL.push(result.dsl);
      toolResponse = result.message;
      report = `Displayed ${call.toolName} to user.`;
      
      console.log(`   ✅ ${result.message}`);
    }
    else {
      // Sub-tool
      console.log(`\n${'='.repeat(60)}`);
      console.log(`🔧 EXECUTOR CALLING SUB-TOOL: ${call.toolName}`);
      console.log(`   call.args type: ${typeof call.args}`);
      console.log(`   call.args value: ${JSON.stringify(call.args)}`);
      console.log(`   call.raw: ${call.raw}`);
      console.log(`${'='.repeat(60)}\n`);
      
      // If args is a string, try to parse it as key-value pairs
      let parsedArgs: Record<string, any> = {};
      if (typeof call.args === 'object' && call.args !== null && Object.keys(call.args).length > 0) {
        parsedArgs = call.args;
      } else if (typeof call.args === 'string') {
        // Try to parse string args (might happen if parsing failed earlier)
        const kvMatches = call.args.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*[:=]\s*([^,]+(?:,(?=[^,]*[:=])|$)?)/g);
        for (const match of kvMatches) {
          const [, key, value] = match;
          parsedArgs[key] = value.trim().replace(/^["']|["']$/g, '');
        }
        console.log(`   Parsed string args to: ${JSON.stringify(parsedArgs)}`);
      }
      
      // If args are still empty, try to parse positional arguments from raw
      if (Object.keys(parsedArgs).length === 0 && call.raw) {
        const subTool = getAllSubTools().find(st => st.id === call.toolName);
        if (subTool && subTool.inputs) {
          // Extract arguments from raw: tool_name(arg1, arg2, arg3)
          const argsMatch = call.raw.match(/\(([^)]+)\)/);
          if (argsMatch) {
            const argsStr = argsMatch[1];
            
            // Smart split by comma, respecting brackets
            const positionalArgs: string[] = [];
            let current = '';
            let bracketDepth = 0;
            
            for (const char of argsStr) {
              if (char === '[' || char === '(') bracketDepth++;
              else if (char === ']' || char === ')') bracketDepth--;
              
              if (char === ',' && bracketDepth === 0) {
                positionalArgs.push(current.trim());
                current = '';
              } else {
                current += char;
              }
            }
            if (current.trim()) {
              positionalArgs.push(current.trim());
            }
            
            console.log(`   Positional args detected: ${JSON.stringify(positionalArgs)}`);
            
            // Map positional args to input names in order
            const inputNames = subTool.inputs.map((inp: any) => inp.name);
            for (let i = 0; i < positionalArgs.length && i < inputNames.length; i++) {
              const value = positionalArgs[i].replace(/^["']|["']$/g, '');
              parsedArgs[inputNames[i]] = value;
              console.log(`   Mapped position ${i} -> ${inputNames[i]}: ${value}`);
            }
          }
        }
      }
      
      const subToolResult = await executeSubToolForAgent(
        call.toolName,
        parsedArgs,
        variables as Map<string, ToolCallVariable>,
        sendEvent
      );
      
      if (subToolResult && call.variableName) {
        const fields = Object.keys(subToolResult.schema).join(', ');
        variables.set(call.variableName, {
          name: call.variableName,
          schema: subToolResult.schema,
          actualData: subToolResult.actualData,
          description: `Data with fields: ${fields}`
        });
        newVariables.push(call.variableName);
        
        const accessKeys = Object.keys(subToolResult.schema)
          .map(key => `${call.variableName}[${key}]`);
        
        // Print raw sub-tool response
        console.log(`\n${'='.repeat(70)}`);
        console.log(`📥 RAW SUB-TOOL RESPONSE: ${call.toolName}`);
        console.log(`${'='.repeat(70)}`);
        console.log(JSON.stringify(subToolResult.actualData, null, 2).slice(0, 3000));
        if (JSON.stringify(subToolResult.actualData).length > 3000) {
          console.log('... (truncated)');
        }
        console.log(`${'='.repeat(70)}\n`);
        
        // Print variable with actual values
        console.log(`\n${'='.repeat(70)}`);
        console.log(`📦 VARIABLE CREATED: ${call.variableName}`);
        console.log(`   Tool: ${call.toolName}`);
        console.log(`${'='.repeat(70)}`);
        console.log(`   Available fields and their values:\n`);
        
        for (const key of Object.keys(subToolResult.schema)) {
          const accessKey = `${call.variableName}[${key}]`;
          console.log(`   → ${accessKey}:`);
          
          // Get the actual value for this field
          let value: any;
          if (Array.isArray(subToolResult.actualData)) {
            // If it's an array, show the values from each item
            value = subToolResult.actualData.map((item: any) => {
              if (typeof item === 'object' && item !== null) {
                return item[key];
              }
              return item;
            });
          } else if (typeof subToolResult.actualData === 'object' && subToolResult.actualData !== null) {
            value = subToolResult.actualData[key];
          }
          
          const valueStr = JSON.stringify(value, null, 2);
          // Indent the value output
          const indentedValue = valueStr.split('\n').map(line => `     ${line}`).join('\n');
          console.log(indentedValue.slice(0, 1000));
          if (valueStr.length > 1000) {
            console.log('     ... (truncated)');
          }
          console.log('');
        }
        console.log(`${'='.repeat(70)}\n`);
        
        toolResponse = `Stored in '${call.variableName}'. Available: ${accessKeys.join(', ')}`;
        report = `Called ${call.toolName}. Created variable '${call.variableName}' with fields: ${fields}`;
      } else {
        toolResponse = `Error: Tool ${call.toolName} failed`;
        report = `Failed to execute ${call.toolName}`;
      }
    }
    
    sendEvent({
      type: 'executor_tool_result',
      tool: call.toolName,
      result: toolResponse
    });
    
    sendEvent({
      type: 'executor_done',
      report,
      newVariables
    });
    
    return { success: true, report, newVariables };
    
  } catch (error: any) {
    sendEvent({ type: 'executor_error', error: error.message });
    sendEvent({
      type: 'executor_done',
      report: `Error: ${error.message}`,
      newVariables
    });
    return { success: false, report: `Error: ${error.message}`, newVariables };
  }
}

// Run the Pilot agent for one turn
async function runPilotAgent(
  userMessage: string,
  executorReport: string | null,
  variables: Map<string, PilotVariable>,
  pilotHistory: Array<{ role: string; content: string }>,
  model: string,
  sendEvent: (data: any) => void,
  retryCount: number = 0
): Promise<{ action: 'EXECUTOR' | 'REPLY'; content: string }> {
  const MAX_RETRIES = 3;
  const client = createOpenRouterClient();
  
  const toolSummaries = buildToolSummariesForPilot();
  const currentData = buildCurrentDataForPilot(variables);
  const systemPrompt = buildPilotPrompt(currentData, toolSummaries);
  
  // Build user message for this turn
  let userContent = '';
  if (executorReport) {
    userContent = `EXECUTOR REPORT:\n${executorReport}\n\nBased on this result, what is your NEXT SINGLE STEP?\n\nRemember: Give ONE instruction at a time. Think about what you learned and what you need next.\n\n(EXECUTOR: single step instruction OR REPLY: final response to user)`;
  } else {
    userContent = `USER REQUEST:\n${userMessage}\n\nWhat is your FIRST STEP to address this request?\n\nRemember: Give ONE instruction at a time. You'll see the results before deciding the next step.\n\n(EXECUTOR: single step instruction OR REPLY: if you can answer directly)`;
  }
  
  // Only add to history on first attempt (not retries)
  if (retryCount === 0) {
    pilotHistory.push({ role: 'user', content: userContent });
  }
  
  const messages: any[] = [
    { role: 'system', content: systemPrompt },
    ...pilotHistory.map(h => ({ role: h.role, content: h.content }))
  ];
  
  sendEvent({
    type: 'pilot_thinking',
    historyLength: pilotHistory.length,
    variableCount: variables.size,
    retry: retryCount > 0 ? retryCount : undefined
  });
  
  // Send the LLM request details
  sendEvent({
    type: 'pilot_llm_request',
    systemPromptPreview: systemPrompt.slice(0, 500) + '...',
    userContent,
    retry: retryCount > 0 ? retryCount : undefined
  });
  
  try {
    const response = await client.chat.completions.create({
      model,
      messages,
      temperature: 0.3,
      max_tokens: 1500
    });
    
    const pilotResponse = response.choices[0]?.message?.content || '';
    
    // Check if response is empty or invalid - retry if so
    if (!pilotResponse || pilotResponse.trim() === '') {
      console.log(`[Pilot] Empty response, retry ${retryCount + 1}/${MAX_RETRIES}`);
      if (retryCount < MAX_RETRIES) {
        sendEvent({ type: 'pilot_retry', reason: 'empty_response', attempt: retryCount + 1 });
        return runPilotAgent(userMessage, executorReport, variables, pilotHistory, model, sendEvent, retryCount + 1);
      }
      // Max retries reached, return a fallback
      return { action: 'REPLY', content: 'I apologize, but I encountered an issue processing your request. Could you please try again?' };
    }
    
    // Add to history
    pilotHistory.push({ role: 'assistant', content: pilotResponse });
    
    sendEvent({
      type: 'pilot_response',
      response: pilotResponse
    });
    
    // Parse Pilot's output
    if (pilotResponse.toUpperCase().includes('EXECUTOR:')) {
      const match = pilotResponse.match(/EXECUTOR:\s*(.+)/is);
      const instructions = match ? match[1].trim() : pilotResponse;
      return { action: 'EXECUTOR', content: instructions };
    }
    else if (pilotResponse.toUpperCase().includes('REPLY:')) {
      const match = pilotResponse.match(/REPLY:\s*(.+)/is);
      const message = match ? match[1].trim() : pilotResponse;
      return { action: 'REPLY', content: message };
    }
    else {
      // Default: treat as executor instruction if contains tool names, otherwise as reply
      const hasToolNames = getAllSubTools().some(st => 
        pilotResponse.toLowerCase().includes(st.id.toLowerCase())
      );
      if (hasToolNames) {
        return { action: 'EXECUTOR', content: pilotResponse };
      }
      return { action: 'REPLY', content: pilotResponse };
    }
    
  } catch (error: any) {
    console.log(`[Pilot] Error: ${error.message}, retry ${retryCount + 1}/${MAX_RETRIES}`);
    // Retry on error
    if (retryCount < MAX_RETRIES) {
      sendEvent({ type: 'pilot_retry', reason: 'error', error: error.message, attempt: retryCount + 1 });
      return runPilotAgent(userMessage, executorReport, variables, pilotHistory, model, sendEvent, retryCount + 1);
    }
    sendEvent({ type: 'pilot_error', error: error.message });
    return { action: 'REPLY', content: 'I apologize, but I encountered an issue processing your request. Could you please try again?' };
  }
}

// Global storage for Pilot System variables (persists across requests)
let pilotSystemVariables = new Map<string, PilotVariable>();

// Main Pilot System loop
async function runPilotSystem(
  userMessage: string,
  model: string,
  conversationHistory: Array<{ role: string; content: string }>,
  sendEvent: (data: any) => void
): Promise<{ finalDSL: string[]; finalMessage: string; history: Array<{ role: string; content: string }> }> {
  // If this is a new conversation (no history), reset variables
  if (conversationHistory.length === 0) {
    pilotSystemVariables = new Map<string, PilotVariable>();
    sendEvent({ type: 'pilot_variables_reset' });
  }
  
  const variables = pilotSystemVariables; // Use persistent variables
  const generatedDSL: string[] = [];
  
  // Initialize pilot history from conversation history
  const pilotHistory: Array<{ role: string; content: string }> = [...conversationHistory];
  
  let isComplete = false;
  let finalMessage = '';
  let executorReport: string | null = null;
  let pilotTurn = 0;
  const maxPilotTurns = 10;
  
  sendEvent({
    type: 'pilot_system_started',
    userMessage: userMessage.slice(0, 200),
    existingVariables: Array.from(variables.keys()),
    historyLength: conversationHistory.length
  });
  
  while (!isComplete && pilotTurn < maxPilotTurns) {
    pilotTurn++;
    
    sendEvent({
      type: 'pilot_turn',
      turn: pilotTurn,
      hasExecutorReport: !!executorReport
    });
    
    // Run Pilot
    const pilotResult = await runPilotAgent(
      userMessage,
      executorReport,
      variables,
      pilotHistory,
      model,
      sendEvent
    );
    
    if (pilotResult.action === 'REPLY') {
      // Pilot is responding to user - we're done
      finalMessage = pilotResult.content;
      isComplete = true;
      
      sendEvent({
        type: 'pilot_replying',
        message: finalMessage
      });
    }
    else if (pilotResult.action === 'EXECUTOR') {
      // Pilot wants Executor to do something
      const instructions = pilotResult.content;
      
      sendEvent({
        type: 'pilot_instructing_executor',
        instructions: instructions.slice(0, 300)
      });
      
      // Extract mentioned tools
      const mentionedTools = extractMentionedTools(instructions);
      
      if (mentionedTools.length === 0) {
        // No tools found - ask Pilot to be more specific
        executorReport = 'I could not identify any specific tools in your instructions. Please specify which tools to use by name.';
        continue;
      }
      
      // Run Executor
      const executorResult = await runExecutorAgent(
        instructions,
        mentionedTools,
        variables,
        generatedDSL,
        model,
        sendEvent
      );
      
      // Prepare report for next Pilot turn
      let reportParts = [executorResult.report];
      if (executorResult.newVariables.length > 0) {
        reportParts.push(`Created variables: ${executorResult.newVariables.join(', ')}`);
      }
      executorReport = reportParts.join('\n');
    }
  }
  
  if (!isComplete) {
    finalMessage = 'I was unable to complete the task. Please try rephrasing your request.';
  }
  
  sendEvent({
    type: 'pilot_system_complete',
    finalMessage: finalMessage.slice(0, 200),
    variableCount: variables.size,
    dslCount: generatedDSL.length
  });
  
  // Build conversation history for the client
  // Add the current user message and assistant response to the existing history
  const updatedHistory: Array<{ role: string; content: string }> = [
    ...conversationHistory,
    { role: 'user', content: userMessage },
    { role: 'assistant', content: finalMessage }
  ];
  
  return {
    finalDSL: generatedDSL,
    finalMessage,
    history: updatedHistory
  };
}

// Pilot System endpoint (replaces tool-calling agent)
app.post('/api/tool-calling-agent', async (req, res) => {
  const { message, history = [], model: modelId = 'gpt-oss-20b' } = req.body;
  
  if (!message) {
    res.status(400).json({ error: 'Message required' });
    return;
  }
  
  // Check if we have any learned sub-tools
  if (!hasAnyLearnings()) {
    res.status(400).json({ error: 'No learned sub-tools available. Please learn an MCP first.' });
    return;
  }
  
  // Use MODEL_MAP to get the actual model name (same as multi-agent system)
  const modelConfig = MODEL_MAP[modelId] || MODEL_MAP['gpt-oss-20b'];
  const model = modelConfig.model;
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  
  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  
  try {
    sendEvent({ type: 'started', model, modelId, system: 'pilot' });
    
    const result = await runPilotSystem(
      message,
      model,
      history,
      sendEvent
    );
    
    // Send final result
    sendEvent({
      type: 'complete',
      dsl: result.finalDSL,
      message: result.finalMessage,
      history: result.history
    });
    
    res.end();
  } catch (error: any) {
    console.error('Tool-calling agent error:', error);
    sendEvent({ type: 'error', message: error.message });
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

