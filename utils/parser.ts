
export interface ParsedProps {
  [key: string]: string;
}

export interface ParsedElement {
  id: string; // Internal render key
  type: string;
  props: ParsedProps;
  items?: Array<ParsedProps & { id: string }>; // For grouped items like Accordion
  actionPrompt?: string; // For Actions: "prompt: Call tool with <id>"
  inputId?: string; // For User Inputs: "myId"
  markdown?: string; // For markdown content
  highlight?: string; // For Display types: LLM explanation of what this nuggt is about
}

export interface GridCell {
  id: string;
  type: 'nuggt' | 'space' | 'continue';
  content?: ParsedElement; // If type is nuggt
  colSpan: number;
  rowSpan: number;
  merged?: boolean; 
}

export interface ParsedGrid {
  id: string;
  type: 'grid';
  columns: number;
  cells: GridCell[]; 
}

export type ParsedNode = ParsedElement | ParsedGrid;

// Helper to split by comma but ignore commas inside brackets/parens/curlies AND quoted strings
const splitSafe = (str: string, delimiter: string = ','): string[] => {
  const items: string[] = [];
  let current = '';
  let depth = 0; // Tracks (), [], {}
  let inDoubleQuote = false;
  let inAngleBracketQuote = false; // Tracks "<...>"

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    const prevChar = i > 0 ? str[i-1] : '';
    
    // Toggle double quote state
    if (char === '"' && prevChar !== '\\') {
      inDoubleQuote = !inDoubleQuote;
    }
    
    // Track angle bracket quotes "<...>"
    if (char === '<' && prevChar === '"' && !inAngleBracketQuote) {
      inAngleBracketQuote = true;
    }
    if (char === '>' && i + 1 < str.length && str[i + 1] === '"' && inAngleBracketQuote) {
      // Will be closed on next iteration
    }
    if (char === '"' && prevChar === '>' && inAngleBracketQuote) {
      inAngleBracketQuote = false;
    }

    if (inDoubleQuote || inAngleBracketQuote) {
      current += char;
    } else {
      if (char === delimiter && depth === 0) {
        items.push(current.trim());
        current = '';
      } else {
        if (['(', '[', '{'].includes(char)) depth++;
        if ([')', ']', '}'].includes(char)) depth--;
        current += char;
      }
    }
  }
  if (current.trim()) items.push(current.trim());
  return items;
};

// Extract text from quoted format: "<text>" -> text, or just return as-is
// Also converts literal \n to actual newlines for markdown rendering
const extractQuotedText = (value: string): string => {
  let result = value;
  
  // Check for "<...>" format
  const angleBracketMatch = value.match(/^"<(.*)>"$/s);
  if (angleBracketMatch) {
    result = angleBracketMatch[1];
  } else {
    // Check for simple "..." format
    const simpleQuoteMatch = value.match(/^"(.*)"$/s);
    if (simpleQuoteMatch) {
      result = simpleQuoteMatch[1];
    }
  }
  
  // Convert literal \n to actual newlines for markdown rendering
  result = result.replace(/\\n/g, '\n');
  
  return result;
};

export const parseProps = (propString: string): ParsedProps => {
  const props: ParsedProps = {};
  const parts = splitSafe(propString, ',');
  
  parts.forEach(part => {
    const splitIndex = part.indexOf(':');
    if (splitIndex !== -1) {
      const key = part.slice(0, splitIndex).trim();
      let value = part.slice(splitIndex + 1).trim();
      if (key) {
        // Extract text from quoted format
        props[key] = extractQuotedText(value);
      }
    }
  });
  return props;
};

// Display types that should have highlight property
const DISPLAY_TYPES = ['card', 'alert', 'accordion', 'text', 'table', 'image'];

// Parses a single "nuggt" string
const parseNuggt = (input: string, id: string): ParsedElement | null => {
  const trimmed = input.trim();
  
  // New Syntax: component: [ (props), <suffix> ]
  // Suffix can be "prompt: <text>" or an ID "myId"
  const bracketMatch = trimmed.match(/^([a-zA-Z0-9-]+):\s*\[\s*\((.*)\)\s*,\s*(.*)\s*\]$/);
  
  // Standard Syntax: component: (props)
  const stdMatch = trimmed.match(/^([a-zA-Z0-9-]+):\s*\((.*)\)$/);

  if (bracketMatch) {
    const type = bracketMatch[1].toLowerCase();
    const propsString = bracketMatch[2];
    const suffix = bracketMatch[3].trim();
    
    // Determine if suffix is a prompt or an ID
    const isPrompt = suffix.toLowerCase().startsWith('prompt:');
    
    let actionPrompt: string | undefined;
    let inputId: string | undefined;

    if (isPrompt) {
      // Extract everything after "prompt:"
      actionPrompt = suffix.substring(7).trim();
    } else {
      inputId = suffix;
    }
    
    const props = parseProps(propsString);
    const highlight = props.highlight;
    delete props.highlight; // Remove from props as it's a special field
    
    return {
      id,
      type,
      props,
      actionPrompt,
      inputId,
      highlight
    };
  } else if (stdMatch) {
    const type = stdMatch[1].toLowerCase();
    const propsString = stdMatch[2];
    
    const props = parseProps(propsString);
    const highlight = props.highlight;
    delete props.highlight; // Remove from props as it's a special field
    
    return {
      id,
      type,
      props,
      highlight
    };
  }
  return null;
};

export const parseDSL = (input: string): ParsedNode[] => {
  const lines = input.split('\n').filter(l => l.trim().length > 0);
  const nodes: ParsedNode[] = [];
  
  let currentAccordionGroup: ParsedElement | null = null;
  let currentGridBlock: { columns: number; rows: string[] } | null = null;
  let currentMarkdownBlock: string[] = [];

  const flushMarkdown = () => {
    if (currentMarkdownBlock.length > 0) {
      nodes.push({
        id: `grid-md-${nodes.length}`,
        type: 'grid',
        columns: 1,
        cells: [{
          id: `cell-md-${nodes.length}`,
          type: 'nuggt',
          colSpan: 1,
          rowSpan: 1,
          content: {
            id: `md-${nodes.length}`,
            type: 'markdown',
            props: {},
            markdown: currentMarkdownBlock.join('\n')
          }
        }]
      });
      currentMarkdownBlock = [];
    }
  };

  const flushGrid = () => {
    if (currentGridBlock) {
      nodes.push(processGridBlock(currentGridBlock));
      currentGridBlock = null;
    }
  };

  const flushAccordion = () => {
    currentAccordionGroup = null;
  };

  const flushAll = () => {
    flushMarkdown();
    flushGrid();
  };

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const gridMatch = trimmed.match(/^\[(\d+)\]:\s*\{(.*)\}$/);

    if (gridMatch) {
      flushMarkdown();
      flushAccordion();
      const cols = parseInt(gridMatch[1], 10);
      const content = gridMatch[2];

      if (currentGridBlock && currentGridBlock.columns === cols) {
        currentGridBlock.rows.push(content);
      } else {
        flushGrid();
        currentGridBlock = { columns: cols, rows: [content] };
      }
    } else {
      flushGrid(); 
      
      const parsed = parseNuggt(trimmed, `el-${index}`);
      
      if (parsed) {
        flushMarkdown();

        if (parsed.type === 'accordion') {
          if (!currentAccordionGroup) {
            currentAccordionGroup = {
              id: `acc-group-${index}`,
              type: 'accordion-group',
              props: {},
              items: []
            };
            
            nodes.push({
              id: `grid-acc-${index}`,
              type: 'grid',
              columns: 1,
              cells: [{
                id: `cell-acc-${index}`,
                type: 'nuggt',
                colSpan: 1,
                rowSpan: 1,
                content: currentAccordionGroup
              }]
            });
          }
          currentAccordionGroup.items?.push({ ...parsed.props, id: `item-${index}` });
        } else {
          flushAccordion();
          nodes.push({
            id: `grid-implicit-${index}`,
            type: 'grid',
            columns: 1,
            cells: [{
              id: `cell-implicit-${index}`,
              type: 'nuggt',
              colSpan: 1,
              rowSpan: 1,
              content: parsed
            }]
          });
        }
      } else {
         flushAccordion();
         currentMarkdownBlock.push(trimmed);
      }
    }
  });

  flushAll();

  return nodes;
};

const processGridBlock = (block: { columns: number; rows: string[] }): ParsedGrid => {
  const matrix: GridCell[][] = [];
  const totalCols = block.columns;

  block.rows.forEach((rowStr, rowIndex) => {
    const rawItems = splitSafe(rowStr, ',');
    
    const parsedItems = rawItems.map(item => {
      const match = item.trim().match(/^\[(\d+)\]:\s*(.*)$/);
      if (match) {
        return { explicitSpan: parseInt(match[1], 10), raw: match[2] };
      }
      return { raw: item.trim() };
    });

    let usedCols = 0;
    let undefinedCount = 0;
    
    parsedItems.forEach(i => {
      if (i.explicitSpan) usedCols += i.explicitSpan;
      else undefinedCount++;
    });

    const remainingCols = totalCols - usedCols;
    const currentRowCells: GridCell[] = [];
    const allDefinedExceptLast = undefinedCount === 1 && !parsedItems[parsedItems.length - 1].explicitSpan;
    const allDefinedExceptFirst = undefinedCount === 1 && !parsedItems[0].explicitSpan;
    
    parsedItems.forEach((item, i) => {
      let span = item.explicitSpan || 0;

      if (!item.explicitSpan) {
        if (allDefinedExceptLast && i === parsedItems.length - 1) {
          span = remainingCols;
        } else if (allDefinedExceptFirst && i === 0) {
          span = remainingCols;
        } else {
          span = Math.floor(remainingCols / undefinedCount); 
        }
      }

      let cellType: 'nuggt' | 'space' | 'continue' = 'nuggt';
      let content: ParsedElement | undefined = undefined;

      if (item.raw === 'space') {
        cellType = 'space';
      } else if (item.raw === 'continue') {
        cellType = 'continue';
      } else {
        const parsed = parseNuggt(item.raw, `grid-item-${rowIndex}-${i}`);
        if (parsed) {
          content = parsed;
        } else {
          content = {
            id: `grid-md-${rowIndex}-${i}`,
            type: 'markdown',
            props: {},
            markdown: item.raw
          };
        }
      }

      currentRowCells.push({
        id: `cell-${rowIndex}-${i}`,
        type: cellType,
        colSpan: span,
        rowSpan: 1,
        content
      });
    });

    matrix.push(currentRowCells);
  });

  const gridSlots: (GridCell | null)[][] = Array(block.rows.length).fill(null).map(() => Array(totalCols).fill(null));

  matrix.forEach((row, r) => {
    let currentCol = 0;
    row.forEach(cell => {
      for (let c = 0; c < cell.colSpan; c++) {
        if (currentCol + c < totalCols) {
          gridSlots[r][currentCol + c] = cell;
        }
      }
      currentCol += cell.colSpan;
    });
  });

  matrix.forEach((row, r) => {
    row.forEach(cell => {
      if (cell.type === 'continue') {
        let colIndex = -1;
        let tempCol = 0;
        for(let i=0; i<row.length; i++) {
            if(row[i] === cell) {
                colIndex = tempCol;
                break;
            }
            tempCol += row[i].colSpan;
        }

        if (r > 0 && colIndex !== -1) {
          const cellAbove = gridSlots[r - 1][colIndex];
          if (cellAbove && cellAbove.colSpan === cell.colSpan && cellAbove.type !== 'space') {
             cellAbove.rowSpan += 1;
             cell.merged = true; 
             for(let k=0; k<cell.colSpan; k++) {
                 gridSlots[r][colIndex+k] = cellAbove;
             }
          }
        }
      }
    });
  });

  const finalCells: GridCell[] = [];
  matrix.forEach(row => {
    row.forEach(cell => {
      if (!cell.merged && cell.type !== 'continue') {
        finalCells.push(cell);
      } else if (cell.type === 'space') {
          finalCells.push(cell);
      }
    });
  });

  return {
    id: `grid-${Math.random()}`,
    type: 'grid',
    columns: totalCols,
    cells: finalCells
  };
};
