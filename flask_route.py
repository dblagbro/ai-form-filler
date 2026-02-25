"""
ai_form_filler — Flask route for POST /api/ai-form/parse

Drop this file into any Flask project, register the blueprint (or copy the
route into your app), and point AIFormFiller at /api/ai-form/parse.

Requires:
  - flask
  - openai  (if using OpenAI provider)
  - anthropic  (if using Anthropic provider)

Minimal wiring example:
    from flask import Flask
    from ai_form_filler.flask_route import ai_form_filler_bp
    app = Flask(__name__)
    app.register_blueprint(ai_form_filler_bp)

Or copy the route function directly into your existing Flask app.

Environment variables (simple mode — no project config):
    AFF_PROVIDER    "openai" | "anthropic"   (default: openai)
    AFF_API_KEY     your API key
    AFF_MODEL       model name               (default: gpt-4o-mini / claude-haiku-4-5-20251001)

If you have a get_project_ai_config() function in your app, replace the
_resolve_llm() helper below with a call to it (see paperless-ai-analyzer for
an example of the full project-config pattern).
"""

import json
import logging
import os

from flask import Blueprint, jsonify, request, session

logger = logging.getLogger(__name__)

ai_form_filler_bp = Blueprint('ai_form_filler', __name__)


def _resolve_llm():
    """
    Return (provider, api_key, model) from environment variables.

    Replace this with your project's AI config lookup if you have one
    (e.g. get_project_ai_config(project_slug, 'chat')).
    """
    provider = os.environ.get('AFF_PROVIDER', 'openai').lower()
    api_key  = os.environ.get('AFF_API_KEY', '').strip()
    defaults = {
        'openai':    'gpt-4o-mini',
        'anthropic': 'claude-haiku-4-5-20251001',
    }
    model = os.environ.get('AFF_MODEL', defaults.get(provider, 'gpt-4o-mini'))
    return provider, api_key, model


@ai_form_filler_bp.route('/api/ai-form/parse', methods=['POST'])
def ai_form_parse():
    """
    Generic AI form-field extractor.

    Request JSON:
        schema       list   [{name, label, description, secret, required}]
        conversation list   [{role, content}, ...] full history including
                            the latest user message to send
        project_slug str    optional

    Response JSON:
        fields       {fieldName: value|null, ...}
        summary      str
        follow_up    str|null
        complete     bool
        notes        str|null
    """
    data         = request.get_json(force=True) or {}
    schema       = data.get('schema') or []
    conversation = data.get('conversation') or []

    if not conversation:
        return jsonify({'error': 'conversation required'}), 400
    if not schema:
        return jsonify({'error': 'schema required'}), 400

    # ── Build system prompt from schema ──────────────────────────────────────
    field_lines = []
    field_names = []
    for f in schema:
        name   = f.get('name', '')
        label  = f.get('label', name)
        desc   = f.get('description', '')
        req    = f.get('required', False)
        secret = f.get('secret', False)
        line   = f'  - "{name}" ({label})'
        if desc:   line += f': {desc}'
        if req:    line += ' [REQUIRED]'
        if secret: line += ' [sensitive]'
        field_lines.append(line)
        field_names.append(name)

    fields_template   = ', '.join(f'"{n}": null' for n in field_names)
    response_template = (
        '{"fields": {' + fields_template + '}, '
        '"summary": "plain English of what was found", '
        '"follow_up": "single clarifying question or null", '
        '"complete": false, '
        '"notes": "any other important observations or null"}'
    )

    system_prompt = (
        "You are an expert at extracting structured data from unstructured text "
        "(emails, Slack messages, notes, etc.).\n\n"
        "Fields to extract:\n"
        + '\n'.join(field_lines) + "\n\n"
        "RULES:\n"
        "  - Extract as many fields as possible from the provided text.\n"
        "  - If a required field is missing or ambiguous, ask ONE clarifying question.\n"
        "  - Ask follow-up questions ONE AT A TIME — never ask multiple at once.\n"
        "  - Set complete:true when you have enough information to fill the form "
        "(all required fields are present or can be reasonably inferred).\n"
        "  - Leave optional fields as null if not found.\n\n"
        "Respond with ONLY valid JSON — no markdown fences, no extra text:\n"
        + response_template
    )

    # ── Resolve LLM ──────────────────────────────────────────────────────────
    provider, api_key, model = _resolve_llm()

    if not api_key:
        return jsonify({
            'error': 'No AI API key configured. Set AFF_API_KEY environment variable.'
        }), 503

    try:
        raw_response = ''

        if provider == 'openai':
            import openai as _oai
            client = _oai.OpenAI(api_key=api_key)
            resp = client.chat.completions.create(
                model=model,
                messages=[{'role': 'system', 'content': system_prompt}] + conversation,
                temperature=0,
                max_tokens=800,
            )
            raw_response = resp.choices[0].message.content or ''

        elif provider == 'anthropic':
            import anthropic as _ant
            client = _ant.Anthropic(api_key=api_key)
            resp = client.messages.create(
                model=model,
                max_tokens=800,
                system=system_prompt,
                messages=conversation,
            )
            raw_response = resp.content[0].text if resp.content else ''

        else:
            return jsonify({'error': f'Unsupported AI provider: {provider}'}), 400

        # Strip markdown fences if model wraps its response anyway
        stripped = raw_response.strip()
        if stripped.startswith('```'):
            stripped = stripped.split('\n', 1)[1]
            stripped = stripped.rsplit('```', 1)[0]

        parsed = json.loads(stripped)
        return jsonify(parsed)

    except Exception as e:
        logger.error(f'ai_form_parse error: {e}')
        return jsonify({'error': str(e)}), 500
