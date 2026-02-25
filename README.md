# AIFormFiller

A reusable "Complete with AI" widget that auto-fills any HTML form from free-form pasted text (emails, Slack messages, attorney notes, etc.).

Two files are all you need:

| File | Purpose |
|------|---------|
| `ai_form_filler.js` | Drop-in JS class — renders a paste panel, manages multi-turn AI chat, auto-fills inputs |
| `flask_route.py` | Flask Blueprint with a single `POST /api/ai-form/parse` endpoint |

## How it works

1. User clicks "📋 Paste credentials" (or whatever trigger you add)
2. Widget renders a textarea + "Parse with AI" button inside a container element
3. User pastes any unstructured text
4. JS POSTs the text + your field schema to `/api/ai-form/parse`
5. AI extracts field values and returns structured JSON
6. If fields are missing, AI asks one follow-up question; user answers; repeat
7. When `complete: true`, `autofill()` fills the mapped inputs and calls `onComplete()`

## Quick start

### 1. Register the Flask route

```python
from flask import Flask
from flask_route import ai_form_filler_bp

app = Flask(__name__)
app.register_blueprint(ai_form_filler_bp)
```

Set environment variables:
```bash
AFF_PROVIDER=openai          # or "anthropic"
AFF_API_KEY=sk-...
AFF_MODEL=gpt-4o-mini        # optional, has sensible defaults
```

### 2. Wire up the JS widget

```html
<!-- Add a container element where the paste panel will render -->
<div id="my-ai-panel"></div>

<script src="ai_form_filler.js"></script>
<script>
  const filler = new AIFormFiller({
    schema: [
      { name: 'username', label: 'Username', required: true },
      { name: 'password', label: 'Password', secret: true },
      { name: 'api_token', label: 'API Token', description: 'Optional token for higher rate limits' },
    ],
    fields: {
      username:  '#my-username-input',
      password:  '#my-password-input',
      api_token: '#my-token-input',
    },
    container:   '#my-ai-panel',
    endpoint:    '/api/ai-form/parse',
    projectSlug: 'default',
    onComplete(fields) {
      console.log('Filled fields:', fields);
    },
  });

  filler.render();   // call once when the container is in the DOM
  // filler.reset(); // call when re-opening a modal to clear state
</script>
```

## Schema fields

Each entry in the `schema` array can have:

| Property | Type | Description |
|----------|------|-------------|
| `name` | string | Key in the AI response `fields` object |
| `label` | string | Human-readable name shown in the system prompt |
| `description` | string | Extra context for the AI |
| `required` | boolean | If true, AI will ask follow-up if missing |
| `secret` | boolean | Tells the AI this is sensitive (e.g. password) |

## `fields` map

Maps field names from the AI response to CSS selectors for the input elements to fill:

```js
fields: {
  username: '#my-form input[name="user"]',
  password: '#my-form input[name="pass"]',
}
```

Fields not in the map are still available in `onComplete(fields)` — use that callback for complex routing logic (e.g. choosing between two sets of inputs based on a detected type).

## `onComplete` callback

Called after `autofill()` runs. Receives the full `fields` object from the AI response. Use it for:
- Setting radio buttons or dropdowns based on extracted values
- Routing ambiguous fields (e.g. `username` → federal or NYSCEF input depending on `court_system`)
- Switching tabs, showing toasts, etc.

## `projectSlug`

Pass a string or a function `() => string`. Useful when your app has per-project AI configuration:

```js
projectSlug: () => document.getElementById('project-select').value
```

## Dependencies

**JS:** None. Uses `fetch()` natively. If your app has `apiFetch()`, `apiUrl()`, `escapeHtml()`, and `showToast()` globals, the widget uses them automatically — otherwise it falls back gracefully.

**Python:** `flask`, `openai` and/or `anthropic` (whichever you use).

## Using with a project-level AI config (advanced)

The standalone `flask_route.py` resolves the LLM from environment variables.
In the [paperless-ai-analyzer](https://github.com/dblagbro/paperless-ai-analyzer) project,
the route is integrated directly into `web_ui.py` and uses `get_project_ai_config()` for
per-project model selection and provider fallback.

To replicate that: replace the `_resolve_llm()` call in `flask_route.py` with your own config lookup.

## License

MIT
