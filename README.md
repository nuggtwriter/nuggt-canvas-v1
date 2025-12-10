# ShadCN Shortcode Builder

A real-time playground that converts custom shortcode DSL ("Nuggts") into interactive ShadCN/UI-styled components.

## Overview

This project allows you to type shortcodes in a chatbot interface to instantly render UI components.

## Nuggt DSL

### Type 1: Display
*   **Accordion**: `accordion: (trigger: <Text>, content: <Text>, highlight: <Text>)`
*   **Card**: `card: (title: <Text>, content: <Text>, highlight: <Text>)`
*   **Alert**: `alert: (title: <Text>, description: <Text>, highlight: <Text>)`
*   **Text**: `text: (content: <Markdown>, highlight: <Text>)`
*   **Table**: `table: (columns: ["Col1","Col2"], data: [...], caption: <Text>, highlight: <Text>)`
*   **Image**: `image: (src: <URL>, alt: <Text>, caption: <Text>, rounded: none|sm|md|lg|xl|full, object-fit: cover|contain|fill|none, highlight: <Text>)`

### Type 2: User Input
*   **Input**: `input: [(label: Email), emailId]`
*   **Calendar**: `calendar: [(mode: single), myDate]`
*   **Range Calendar**: `range-calendar: [(), myRange]`
*   **Date Picker**: `date-picker: [(label: Text), myDateId]`
*   **Time Picker**: `time-picker: [(label: Text), myTimeId]`

### Type 3: Action
*   **Button**: `button: [(label: Text, variant: default), prompt: Searching for <queryId>]`
*   **Alert Dialog**: `alert-dialog: [(trigger: Text, title: Text), prompt: Confirmed action]`

### Type 4: Visual
*   **Line Chart**: `line-chart: [(data: <JSON_Array>, x-data: key, y-data: key|key2, colour: #hex|#hex2, title: "Title"), chartId]`

### Layout System
*   `[N]: { ... }` defines an N-column grid
*   Examples:
    *   2 equal columns: `[2]: { card: (...), card: (...) }`
    *   Spanning columns: `[3]: { [2]: card: (...), [1]: button: (...) }`
    *   Empty space: `[3]: { [1]: space, [2]: card: (...) }`

## How to Run
1. Clone the repository.
2. Install dependencies: `npm install`
3. Copy `template.env` to `.env` and add your API keys
4. Run the development server: `npm run dev:all`