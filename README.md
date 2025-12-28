<div align="center">

# ✨ Nuggt

### Rethinking AI Interfaces: Beyond the Chatbot

[![Discord](https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/BZWqtbM2)
[![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)

</div>

---

https://github.com/user-attachments/assets/7a5363d2-5a04-493d-967c-afefaff676eb

## 💭 The Problem with Chatbots

Let's be honest: **the chatbot interface for LLMs is kind of dull.**

We've taken the most powerful AI technology ever created and squeezed it into a text box. The result? Walls of text, endless scrolling, and information buried in paragraphs that you have to read, re-read, and mentally parse.

**This seems like the wrong direction.**

Humans don't think in walls of text. We think in:
- 📊 **Charts** that reveal trends at a glance
- 📋 **Tables** that organize data we can scan
- 🎴 **Cards** that highlight key metrics
- 🎛️ **Interactive forms** that guide our decisions
- 🖼️ **Visuals** that tell stories words can't

**Nuggt flips the paradigm.** Instead of AI generating text for you to read, AI generates **rich, interactive UI** that surfaces information visually. Less reading, more understanding. Less text, more insight.

---

## 🎯 What is Nuggt?

Nuggt is an AI-powered UI generator that converts natural language requests into **interactive, data-rich interfaces** using a custom DSL (Domain Specific Language).

You describe what you want to see. The AI doesn't just tell you—it **shows you**.

```
You: "Show me our sales performance this quarter"

Traditional Chatbot:
"Based on the data, your Q3 sales were $45,000 in January, $52,000 in February, 
and $61,000 in March, showing a 35% growth trend. The top performing product 
was Widget A with 234 units sold, followed by Widget B with 189 units..."

Nuggt:
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ 📈 Q3 Revenue   │  │ 🏆 Top Product  │  │ 📊 Growth       │
│    $158,000     │  │    Widget A     │  │    +35%         │
└─────────────────┘  └─────────────────┘  └─────────────────┘

        📈 Sales Trend
    $61k ─────────────────────●
    $52k ───────────●
    $45k ●
         Jan    Feb    Mar
```

---

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ 
- npm or yarn
- An Anthropic API key (Claude)

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/nuggt.git
cd nuggt

# Install dependencies
npm install

# Set up environment variables
cp template.env .env
```

### Configuration

Edit your `.env` file with your API key:

```env
# Required: Anthropic API Key for Claude Sonnet 4
# Get your key at: https://console.anthropic.com/
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxx

# Optional: Server port (defaults to 3001)
PORT=3001
```

### Running the Application

```bash
# Start both frontend and backend
npm run dev:all

# Or run them separately:
npm run server  # Backend on port 3001
npm run dev     # Frontend on port 3000
```

Visit `http://localhost:3000` and start describing your UI!

---

## 🧩 The Nuggt DSL

Nuggt uses a custom Domain Specific Language (DSL) that the AI generates to create UI components. Understanding the DSL helps you understand what Nuggt can create.

### Philosophy

The DSL is designed around three principles:

1. **Declarative**: Describe *what* you want, not *how* to build it
2. **Composable**: Components can be arranged in flexible grid layouts
3. **Interactive**: Components can collect user input and trigger actions

### Component Categories

#### 📊 Display Components
*Auto-render to a persistent canvas*

| Component | Syntax | Purpose |
|-----------|--------|---------|
| **Card** | `card: (title: "Title", content: "Content", highlight: "Why")` | Display metrics, stats, or info blocks |
| **Alert** | `alert: (title: "Title", description: "Message", highlight: "Why")` | Important notices or warnings |
| **Accordion** | `accordion: (trigger: "Click me", content: "Details", highlight: "Why")` | Collapsible content sections |
| **Text** | `text: (content: "Markdown content", highlight: "Why")` | Rich text with full Markdown support |
| **Table** | `table: (columns: ["A","B"], data: [...], highlight: "Why")` | Structured data in rows/columns |
| **Image** | `image: (src: "URL", alt: "Description", highlight: "Why")` | Images with captions |

#### 📈 Visual Components
*Data visualization*

| Component | Syntax | Purpose |
|-----------|--------|---------|
| **Line Chart** | `line-chart: [(data: [...], x-data: key, y-data: key, colour: #hex, title: "Title"), chartId]` | Trend visualization |

#### 🎛️ Input Components
*Collect user data*

| Component | Syntax | Purpose |
|-----------|--------|---------|
| **Input** | `input: [(label: "Label", type: text), inputId]` | Text, email, password fields |
| **Select** | `select: [(label: "Label", options: "a,b,c"), selectId]` | Dropdown selection |
| **Calendar** | `calendar: [(mode: single), calId]` | Date selection |
| **Date Picker** | `date-picker: [(label: "Label"), dateId]` | Compact date picker |
| **Time Picker** | `time-picker: [(label: "Label"), timeId]` | Time selection |

#### ⚡ Action Components
*Trigger AI responses*

| Component | Syntax | Purpose |
|-----------|--------|---------|
| **Button** | `button: [(label: "Click", variant: default), prompt: Do something with <inputId>]` | Trigger actions with collected inputs |
| **Alert Dialog** | `alert-dialog: [(trigger: "Delete", title: "Sure?", description: "Cannot undo"), prompt: Delete item]` | Confirmation dialogs |

### Layout System

Nuggt uses a powerful grid-based layout system:

```
# Two equal columns
[2]: { card: (...), card: (...) }

# Three columns with different spans
[3]: { [2]: card: (...), [1]: button: (...) }

# Leave empty space
[3]: { [1]: space, [2]: card: (...) }
```

### Real-World Examples

**Dashboard with metrics and chart:**
```
[3]: { card: (title: "Revenue", content: "$45,000"), card: (title: "Users", content: "1,234"), card: (title: "Growth", content: "+15%") }
line-chart: [(data: [{"m":"Jan","v":30},{"m":"Feb","v":45},{"m":"Mar","v":52}], x-data: m, y-data: v, colour: #2563eb, title: "Monthly Trend"), revenueChart]
```

**Interactive form:**
```
[2]: { input: [(label: "Campaign Name", type: text), campaignName], select: [(label: "Target Audience", options: "B2B,B2C,Both"), audience] }
input: [(label: "Budget", placeholder: "$5,000", type: text), budget]
button: [(label: "Launch Campaign", variant: default), prompt: Create a marketing campaign called <campaignName> targeting <audience> with budget <budget>]
```

**Data table with context:**
```
alert: (title: "Data Loaded", description: "Found 156 records from last 30 days")
table: (columns: ["Date","Visitors","Conversions","Revenue"], data: [...], caption: "Website Analytics")
```

---

## 🔌 MCP Integration

Nuggt supports the **Model Context Protocol (MCP)** for connecting to external data sources and tools. This allows the AI to:

- Query databases
- Fetch analytics data
- Call external APIs
- Access file systems

### Adding New MCP Tools

MCP tools are configured in `mcp-config.json` at the project root. Here's how to add new tools:

#### Configuration Structure

```json
{
  "mcpServers": {
    "your-mcp-name": {
      "command": "npx or pipx or node",
      "args": ["arguments", "here"],
      "env": {
        "API_KEY": "your-key",
        "OTHER_VAR": "value"
      }
    }
  }
}
```

#### Example: Adding a Local MCP Server (Python/pipx)

```json
{
  "mcpServers": {
    "analytics-mcp": {
      "command": "pipx",
      "args": ["run", "analytics-mcp"],
      "env": {
        "GOOGLE_APPLICATION_CREDENTIALS": "/path/to/credentials.json",
        "GOOGLE_PROJECT_ID": "your-project-id"
      }
    }
  }
}
```

#### Example: Adding a Remote MCP Server (HTTP)

```json
{
  "mcpServers": {
    "coingecko-mcp": {
      "command": "npx",
      "args": ["mcp-remote", "https://mcp.api.coingecko.com/mcp"]
    }
  }
}
```

#### Example: Adding an NPM-based MCP Server

```json
{
  "mcpServers": {
    "filesystem-mcp": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/directory"]
    }
  }
}
```

#### Example: Adding a GitHub MCP Server

```json
{
  "mcpServers": {
    "github-mcp": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxxxxxxxxxxx"
      }
    }
  }
}
```

### Popular MCP Servers

| MCP Server | Description | Install |
|------------|-------------|---------|
| `@modelcontextprotocol/server-filesystem` | Read/write local files | `npx -y @modelcontextprotocol/server-filesystem /path` |
| `@modelcontextprotocol/server-github` | GitHub repository access | `npx -y @modelcontextprotocol/server-github` |
| `@modelcontextprotocol/server-postgres` | PostgreSQL database queries | `npx -y @modelcontextprotocol/server-postgres` |
| `@modelcontextprotocol/server-sqlite` | SQLite database access | `npx -y @modelcontextprotocol/server-sqlite` |
| `mcp-remote` | Connect to any HTTP MCP endpoint | `npx mcp-remote <url>` |

### After Adding MCP Tools

1. **Restart the server** - MCP connections are established on startup
2. **Check the console** - You'll see "Loaded X tools from your-mcp-name"
3. **Use the "Learn MCP" feature** - This helps the AI understand your tools better

### MCP Learning (Optional)

Nuggt includes a "Learn MCP" feature that analyzes your MCP tools and creates optimized prompts for the AI. This improves the AI's ability to use your tools effectively.

Click the **Learn MCPs** button in the UI to:
- See all available tools from connected MCPs
- Generate optimized tool descriptions
- Create reusable "sub-tools" for common workflows

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Frontend (React)                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │  Chat UI    │  │   Canvas    │  │  DSL Parser │     │
│  │             │  │ (Rendered   │  │  (Converts  │     │
│  │ User Input  │  │ Components) │  │  DSL → UI)  │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
└────────────────────────┬────────────────────────────────┘
                         │ SSE Stream
┌────────────────────────┴────────────────────────────────┐
│                    Backend (Express)                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │  Claude     │  │    MCP      │  │   Nuggt     │     │
│  │  Sonnet 4   │  │   Manager   │  │   Prompts   │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
└─────────────────────────────────────────────────────────┘
```

---

## 📁 Project Structure

```
nuggt/
├── App.tsx              # Main React application
├── server/
│   ├── index.ts         # Express server & Claude integration
│   └── nuggt-prompts.ts # Component-specific AI prompts
├── components/          # React UI components
├── pages/               # Additional pages (Learn MCP, etc.)
├── mcp-config.json      # MCP server configuration
├── mcp-learnings/       # Learned MCP tool optimizations
└── template.env         # Environment template
```

---

## 🤝 Community

Have questions? Want to share what you've built? Join our community!

[![Discord](https://img.shields.io/badge/Join%20our%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/BZWqtbM2)

We'd love to see:
- 🎨 Creative UI patterns you've discovered
- 🔧 MCP integrations you've built
- 💡 Ideas for new components
- 🐛 Bug reports and feature requests

---

## 📝 License

MIT License - feel free to use this in your own projects!

---

## 🙏 Acknowledgments

- Built with [Claude Sonnet 4](https://anthropic.com) by Anthropic
- UI components styled with [shadcn/ui](https://ui.shadcn.com)
- Charts powered by [Recharts](https://recharts.org)

---

<div align="center">

**Stop reading AI responses. Start seeing them.**

[Get Started](#-quick-start) · [Join Discord](https://discord.gg/BZWqtbM2) · [View DSL Reference](#-the-nuggt-dsl)

</div>
