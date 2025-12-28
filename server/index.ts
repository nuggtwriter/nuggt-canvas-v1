import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
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
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Anthropic API key is required
if (!ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY. Please provide it in environment variables");
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

  getToolsForClaude(): Anthropic.Tool[] {
    if (!this.tools.length) return [];
    return this.tools.map(tool => ({
      name: tool.name,
      description: tool.description || '',
      input_schema: tool.inputSchema || { type: 'object', properties: {} }
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

// Build tool descriptions from Claude tools
function buildToolDescriptions(tools: Anthropic.Tool[]): string {
  if (tools.length === 0) return '(No tools available)';
  
  let result = '## AVAILABLE TOOLS\n\n';
  for (const tool of tools) {
    result += `**${tool.name}**\n`;
    result += `${tool.description}\n\n`;
  }
  return result;
}

// Build sub-tool descriptions (summaries only)
function buildSubToolDescriptions(): string {
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

// --- SYSTEM INSTRUCTION FOR CLAUDE ---

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

// Claude Sonnet 4 model configuration
const CLAUDE_MODEL = 'claude-sonnet-4-5';

app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body;

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
    
    // Prepare tools from MCP for Claude
    const mcpToolsForClaude = mcpManager.getToolsForClaude();
    
    // Use Claude Sonnet for all requests
    await handleClaudeRequest(res, sendEvent, message, history, CLAUDE_MODEL, mcpToolsForClaude);
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

// Get system information
app.get('/api/agent-prompts', async (req, res) => {
  try {
    const usingSubTools = hasAnyLearnings();
    
    // Build the tool descriptions
    const toolDescriptions = usingSubTools 
      ? buildSubToolDescriptions()
      : buildToolDescriptions(mcpManager.getToolsForClaude());
    
    const toolAgentDocs = usingSubTools
      ? buildSubToolDocsForToolAgent()
      : '(Using original MCP tool schemas)';
    
    // Build component prompts map
    const componentPrompts: Record<string, string> = {};
    for (const [key, prompt] of Object.entries(NUGGT_PROMPTS)) {
      componentPrompts[key] = prompt;
    }
    
    res.json({
      usingSubTools,
      subToolCount: usingSubTools ? getAllSubTools().length : 0,
      workflowCount: usingSubTools ? getAllWorkflows().length : 0,
      prompts: {
        system: {
          name: 'Claude Sonnet System',
          description: 'Uses Claude Sonnet 4.5 for UI generation with MCP tool support',
          systemInstruction: SYSTEM_INSTRUCTION.slice(0, 500) + '...',
          availableComponents: AVAILABLE_COMPONENTS
        },
        tools: {
          name: 'Tool Descriptions',
          description: 'Available MCP tools',
          toolDescriptions: toolDescriptions,
          fullToolDocs: toolAgentDocs
        },
        ui: {
          name: 'UI Component Prompts',
          description: 'Each UI component has its own specialized prompt',
          componentPrompts: componentPrompts
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
        model: 'claude-sonnet-4-5',
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
              modelUsed: 'claude-sonnet-4-5',
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

