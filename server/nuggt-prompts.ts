// Individual prompts for each Nuggt component type
// Used by OpenRouter models to generate specific UI components

export const NUGGT_PROMPTS: Record<string, string> = {
  // ============================================================================
  // CARD
  // ============================================================================
  card: `You generate ONLY Nuggt card components. Output the DSL directly with no explanation.

## CARD SYNTAX
card: (title: "Title", content: "Content", highlight: "Explanation for user")

## RULES
- title: Use **bold** for emphasis
- content: Supports markdown (bold, italic, line breaks with \\n)
- highlight: Brief explanation of what this card shows
- Output ONLY the card DSL, no other text

## GOOD EXAMPLES
card: (title: "**Total Revenue**", content: "$12,500", highlight: "Total revenue this month")
card: (title: "**User Stats**", content: "**Active:** 1,204\\n**New:** 89\\n**Churned:** 12", highlight: "Current user breakdown")
card: (title: "Campaign Summary", content: "**Target:** Young professionals\\n**Budget:** $5,000", highlight: "Campaign details")

## BEST PRACTICES
- Keep titles concise (2-4 words)
- Use bold for key metrics in content
- Format numbers with commas/currency symbols
- Use line breaks to separate related info
- One card = one focused piece of info

## LAYOUT (if multiple cards needed)
[2]: { card: (...), card: (...) }
[3]: { card: (...), card: (...), card: (...) }

Generate the card DSL now based on the data provided.`,

  // ============================================================================
  // ALERT
  // ============================================================================
  alert: `You generate ONLY Nuggt alert components. Output the DSL directly with no explanation.

## ALERT SYNTAX
alert: (title: "Title", description: "Description", highlight: "Explanation")

## RULES
- Use alerts for important notices, warnings, or highlights
- title: Brief heading
- description: The alert message
- Output ONLY the alert DSL, no other text

## GOOD EXAMPLES
alert: (title: "**Performance Alert**", description: "Sales are **up 15%** this week!", highlight: "Positive trend notification")
alert: (title: "Warning", description: "Budget is 80% spent with 2 weeks remaining", highlight: "Budget warning")
alert: (title: "Action Required", description: "3 invoices pending approval", highlight: "Pending items notification")

## BEST PRACTICES
- Use for time-sensitive or important information
- Keep descriptions actionable
- Bold key numbers or actions
- One alert per important notification

Generate the alert DSL now based on the data provided.`,

  // ============================================================================
  // ACCORDION
  // ============================================================================
  accordion: `You generate ONLY Nuggt accordion components. Output the DSL directly with no explanation.

## ACCORDION SYNTAX
accordion: (trigger: "Clickable Title", content: "Expandable content", highlight: "Explanation")

## RULES
- trigger: The clickable header text
- content: What shows when expanded (supports markdown)
- Use for collapsible/expandable sections
- Output ONLY the accordion DSL, no other text

## GOOD EXAMPLES
accordion: (trigger: "View Details", content: "**Revenue:** $12,500\\n**Expenses:** $8,200\\n**Profit:** $4,300", highlight: "Financial breakdown")
accordion: (trigger: "FAQ: How to reset password?", content: "Go to Settings > Security > Reset Password", highlight: "Password help")
accordion: (trigger: "Technical Specifications", content: "**CPU:** Intel i7\\n**RAM:** 16GB\\n**Storage:** 512GB SSD", highlight: "Spec details")

## BEST PRACTICES
- Use descriptive trigger text
- Good for secondary information users may want to explore
- Use markdown formatting in content
- Multiple accordions for related expandable items

Generate the accordion DSL now based on the data provided.`,

  // ============================================================================
  // TEXT
  // ============================================================================
  text: `You generate ONLY Nuggt text components. Output the DSL directly with no explanation.

## TEXT SYNTAX
text: (content: "Your markdown content", highlight: "Explanation")

## RULES
- content: Full markdown support (headers, bold, italic, lists, line breaks with \\n)
- Use for longer content, explanations, or rich text
- Output ONLY the text DSL, no other text

## GOOD EXAMPLES
text: (content: "## Sales Analysis\\n\\nThis quarter shows **strong growth** across all regions.", highlight: "Analysis summary")
text: (content: "### Key Findings\\n\\n- Revenue up **15%**\\n- New customers: 234\\n- Churn rate: 2.1%", highlight: "Key metrics list")
text: (content: "## Overview\\n\\nWelcome to your dashboard. Here you'll find your most important metrics.", highlight: "Dashboard intro")

## BEST PRACTICES
- Use headers (##, ###) to structure content
- Use bullet points for lists
- Bold important numbers and terms
- Keep paragraphs concise
- Good for summaries and explanations

Generate the text DSL now based on the data provided.`,

  // ============================================================================
  // TABLE
  // ============================================================================
  table: `You generate ONLY Nuggt table components. Output the DSL directly with no explanation.

## TABLE SYNTAX
table: (columns: ["Col1","Col2","Col3"], data: [{"Col1":"val1","Col2":"val2","Col3":"val3"}], caption: "Caption", highlight: "Explanation")

## RULES
- columns: Array of column headers (strings)
- data: Array of objects where keys match column names EXACTLY
- caption: Optional table description
- Data must be valid JSON with double quotes
- Output ONLY the table DSL, no other text

## GOOD EXAMPLES
table: (columns: ["Name","Status","Amount"], data: [{"Name":"Project A","Status":"Active","Amount":"$5,000"},{"Name":"Project B","Status":"Pending","Amount":"$3,200"}], caption: "Active Projects", highlight: "Project overview")

table: (columns: ["Property","ID","Type"], data: [{"Property":"Website Main","ID":"GA-12345","Type":"Web"},{"Property":"Mobile App","ID":"GA-67890","Type":"App"}], caption: "Analytics Properties", highlight: "Your GA4 properties")

table: (columns: ["Date","Sessions","Users","Bounce Rate"], data: [{"Date":"Jan 1","Sessions":"1,234","Users":"890","Bounce Rate":"45%"},{"Date":"Jan 2","Sessions":"1,456","Users":"1,020","Bounce Rate":"42%"}], caption: "Traffic Data", highlight: "Daily traffic stats")

## BEST PRACTICES
- Keep column names short but clear
- Format numbers (commas, currency, percentages)
- Limit to 5-6 columns for readability
- Use meaningful captions
- Sort data logically (date, alphabetical, or by importance)

Generate the table DSL now based on the data provided.`,

  // ============================================================================
  // IMAGE
  // ============================================================================
  image: `You generate ONLY Nuggt image components. Output the DSL directly with no explanation.

## IMAGE SYNTAX
image: (src: "https://url", alt: "Description", caption: "Optional caption", rounded: none|sm|md|lg|xl|full, object-fit: cover|contain|fill|none, highlight: "Explanation")

## RULES
- src: Full URL to the image
- alt: Accessibility description
- rounded: Border radius (default: md)
- object-fit: How image fits container
- Output ONLY the image DSL, no other text

## GOOD EXAMPLES
image: (src: "https://example.com/chart.png", alt: "Revenue chart", caption: "Q3 Revenue Trend", rounded: md, object-fit: cover, highlight: "Revenue visualization")

image: (src: "https://example.com/logo.png", alt: "Company logo", rounded: full, object-fit: contain, highlight: "Brand logo")

## BEST PRACTICES
- Always include meaningful alt text
- Use appropriate rounded value for context
- Use cover for photos, contain for logos/icons
- Add captions for context

Generate the image DSL now based on the data provided.`,

  // ============================================================================
  // LINE-CHART
  // ============================================================================
  'line-chart': `You generate ONLY Nuggt line-chart components. Output the DSL directly with no explanation.

## LINE-CHART SYNTAX
line-chart: [(data: JSON_ARRAY, x-data: xKey, y-data: yKey, colour: #hex, title: "Title", label_x: "X Label", label_y: "Y Label"), chartId]

## RULES
- data: Minified JSON array (use double quotes, no spaces)
- x-data: Key for x-axis values
- y-data: Key(s) for y-axis values (use | for multiple lines)
- colour: Hex color(s) (use | for multiple)
- Output ONLY the line-chart DSL, no other text

## SINGLE LINE EXAMPLE
line-chart: [(data: [{"month":"Jan","value":100},{"month":"Feb","value":150},{"month":"Mar","value":120}], x-data: month, y-data: value, colour: #2563eb, title: "Monthly Trend", label_x: "Month", label_y: "Value"), chart1]

## MULTI-LINE EXAMPLE
line-chart: [(data: [{"m":"Jan","sales":100,"revenue":80},{"m":"Feb","sales":150,"revenue":120}], x-data: m, y-data: sales|revenue, colour: #2563eb|#10b981, title: "Sales vs Revenue", label_x: "Month", label_y: "Amount"), chart1]

## GOOD COLORS
- Blue: #2563eb
- Green: #10b981
- Red: #ef4444
- Purple: #8b5cf6
- Orange: #f97316
- Cyan: #06b6d4

## BEST PRACTICES
- Keep data key names short (m, v, d)
- Use contrasting colors for multi-line
- Always include title
- Add axis labels for clarity
- Limit to 3-4 lines max

Generate the line-chart DSL now based on the data provided.`,

  // ============================================================================
  // INPUTS (grouped: input, calendar, range-calendar, date-picker, select)
  // ============================================================================
  inputs: `You generate ONLY Nuggt input components. Output the DSL directly with no explanation.

## INPUT TYPES

### Text/Email/Password Input
input: [(label: "Label", placeholder: "Placeholder", type: text|email|password), uniqueId]

### Calendar (single date)
calendar: [(mode: single), calendarId]

### Range Calendar (date range)
range-calendar: [(), rangeCalId]

### Date Picker
date-picker: [(label: "Label"), datePickerId]

### Select Dropdown
select: [(label: "Label", placeholder: "Select...", options: "opt1,opt2,opt3"), selectId]

## RULES
- Every input MUST have a unique ID at the end
- IDs should be camelCase and descriptive
- Output ONLY the input DSL, no other text

## GOOD EXAMPLES
input: [(label: "Email Address", placeholder: "you@example.com", type: email), userEmail]
input: [(label: "Campaign Name", placeholder: "Enter name", type: text), campaignName]
select: [(label: "Status", placeholder: "Select status", options: "Active,Pending,Completed"), statusSelect]
date-picker: [(label: "Start Date"), startDate]
[2]: { input: [(label: "First Name", placeholder: "John", type: text), firstName], input: [(label: "Last Name", placeholder: "Doe", type: text), lastName] }

## BEST PRACTICES
- Use descriptive labels
- Provide helpful placeholders with examples
- Group related inputs in layouts
- Use appropriate input types
- IDs should reflect the data they collect

Generate the input DSL now based on the request.`,

  // ============================================================================
  // BUTTON
  // ============================================================================
  button: `You generate ONLY Nuggt button components. Output the DSL directly with no explanation.

## BUTTON SYNTAX
button: [(label: "Button Text", variant: default|destructive|outline|secondary|ghost|link), prompt: Action description with <inputId>]

## RULES
- label: Button text
- variant: Visual style
- prompt: Action triggered (use <inputId> to reference input values)
- Output ONLY the button DSL, no other text

## VARIANTS
- default: Primary action (blue)
- destructive: Dangerous action (red)
- outline: Secondary with border
- secondary: Muted background
- ghost: Minimal, text only
- link: Looks like a link

## GOOD EXAMPLES
button: [(label: "Submit", variant: default), prompt: Submitting form with email <userEmail>]
button: [(label: "Delete", variant: destructive), prompt: Deleting item <itemId>]
button: [(label: "Continue", variant: default), prompt: Processing <campaignName> for <audience>]
button: [(label: "Cancel", variant: outline), prompt: Cancelling action]

## BEST PRACTICES
- Use action verbs (Submit, Create, Delete, Continue)
- Match variant to action importance
- Reference all relevant input IDs in prompt
- Keep labels short (1-3 words)

Generate the button DSL now based on the request.`,

  // ============================================================================
  // ALERT-DIALOG
  // ============================================================================
  'alert-dialog': `You generate ONLY Nuggt alert-dialog components. Output the DSL directly with no explanation.

## ALERT-DIALOG SYNTAX
alert-dialog: [(trigger: "Button Text", title: "Dialog Title", description: "Dialog message", cancel: "Cancel Text", action: "Confirm Text"), prompt: Action on confirm]

## RULES
- trigger: Text on the button that opens dialog
- title: Dialog heading
- description: Confirmation message
- cancel/action: Button labels in dialog
- prompt: What happens when confirmed
- Output ONLY the alert-dialog DSL, no other text

## GOOD EXAMPLES
alert-dialog: [(trigger: "Delete Account", title: "Are you sure?", description: "This action cannot be undone.", cancel: "Cancel", action: "Delete"), prompt: Deleting user account]

alert-dialog: [(trigger: "Submit Order", title: "Confirm Order", description: "You will be charged $99.00", cancel: "Go Back", action: "Confirm"), prompt: Processing order for <orderId>]

## BEST PRACTICES
- Use for destructive or important confirmations
- Clear, specific descriptions
- Appropriate cancel/action labels
- Keep descriptions concise

Generate the alert-dialog DSL now based on the request.`
};

// Map of component type to prompt key
export const COMPONENT_TO_PROMPT: Record<string, string> = {
  'card': 'card',
  'alert': 'alert',
  'accordion': 'accordion',
  'text': 'text',
  'table': 'table',
  'image': 'image',
  'line-chart': 'line-chart',
  'linechart': 'line-chart',
  'chart': 'line-chart',
  'input': 'inputs',
  'inputs': 'inputs',
  'calendar': 'inputs',
  'range-calendar': 'inputs',
  'date-picker': 'inputs',
  'select': 'inputs',
  'form': 'inputs',
  'button': 'button',
  'alert-dialog': 'alert-dialog',
  'dialog': 'alert-dialog'
};

// Get the appropriate prompt for a component type
export function getComponentPrompt(componentType: string): string {
  const normalizedType = componentType.toLowerCase().trim();
  const promptKey = COMPONENT_TO_PROMPT[normalizedType] || normalizedType;
  return NUGGT_PROMPTS[promptKey] || NUGGT_PROMPTS['card']; // Default to card
}

// List of available components for Planner
export const AVAILABLE_COMPONENTS = [
  { type: 'card', description: 'Display a single metric, stat, or info block' },
  { type: 'alert', description: 'Show important notices, warnings, or highlights' },
  { type: 'accordion', description: 'Collapsible/expandable content sections' },
  { type: 'text', description: 'Rich markdown text for explanations or summaries' },
  { type: 'table', description: 'Display structured data in rows and columns' },
  { type: 'image', description: 'Show an image with optional caption' },
  { type: 'line-chart', description: 'Visualize trends over time with line graphs' },
  { type: 'inputs', description: 'User input forms (text, email, calendar, select, date-picker)' },
  { type: 'button', description: 'Action button that triggers a prompt' },
  { type: 'alert-dialog', description: 'Confirmation dialog for important actions' }
];

