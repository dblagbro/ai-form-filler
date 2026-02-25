/**
 * AIFormFiller — reusable "Complete with AI" widget
 *
 * Accepts free-form pasted text (email, Slack, notes), sends it to a backend
 * endpoint with a field schema, and auto-fills form inputs from the AI response.
 * Supports multi-turn follow-up questions when the AI needs clarification.
 *
 * Usage:
 *   const filler = new AIFormFiller({
 *     schema: [
 *       { name: 'username', label: 'Username', description: 'Login username', required: true },
 *       { name: 'password', label: 'Password', description: 'Login password', secret: true },
 *     ],
 *     fields: {
 *       username: '#my-username-input',
 *       password: '#my-password-input',
 *     },
 *     container: '#ai-paste-panel',   // element or CSS selector — widget renders inside this
 *     endpoint:  '/api/ai-form/parse', // see flask_route.py
 *     projectSlug: 'default',          // string OR function returning a string
 *     onComplete(extractedFields) {    // called after autofill; use for custom post-processing
 *       console.log('Done', extractedFields);
 *     },
 *   });
 *
 *   filler.render();   // inject UI into container
 *   filler.reset();    // clear state + UI (call before re-opening a modal)
 *
 * The `fields` map keys must match field names returned in the `fields` object
 * of the API response.  Fields not in the map are ignored by autofill() but
 * are still available in the onComplete() callback.
 *
 * Dependencies: none beyond fetch().  Uses escapeHtml(), showToast(), apiUrl(),
 * and apiFetch() if they exist as globals — falls back gracefully without them.
 */

class AIFormFiller {
  static _count = 0;

  constructor({
    schema       = [],
    fields       = {},
    container,
    endpoint,
    onComplete   = null,
    projectSlug  = 'default',
  } = {}) {
    this._id         = 'aff' + (++AIFormFiller._count);
    this._schema     = schema;
    this._fields     = fields;
    this._container  = typeof container === 'string'
                       ? document.querySelector(container) : container;
    this._endpoint   = endpoint;
    this._onComplete = onComplete;
    this._slug       = projectSlug;   // string or () => string
    this._conversation = [];
    this._els        = {};
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _pfx(s) { return `${this._id}-${s}`; }

  _currentSlug() {
    if (typeof this._slug === 'function') return this._slug();
    return this._slug || 'default';
  }

  _escape(str) {
    if (typeof escapeHtml === 'function') return escapeHtml(str);
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  _toast(msg, type) {
    if (typeof showToast === 'function') { showToast(msg, type); return; }
    console.warn('[AIFormFiller]', msg);
  }

  async _fetch(url, opts) {
    const fn = typeof apiFetch === 'function' ? apiFetch : fetch;
    const resolvedUrl = typeof apiUrl === 'function' ? apiUrl(url) : url;
    return fn(resolvedUrl, opts);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Inject the paste UI into this._container.
   * Safe to call multiple times — re-renders in place.
   */
  render() {
    if (!this._container) return;

    this._container.innerHTML = `
      <p style="color:#6b7280; margin-bottom:10px; font-size:13px;">
        Paste an email, Slack message, or any notes that contain the information.
        AI will extract the fields and ask follow-up questions if needed.
      </p>
      <textarea id="${this._pfx('paste')}"
                placeholder="Paste text here\u2026"
                style="width:100%; box-sizing:border-box; height:90px; padding:8px 10px;
                       border:1px solid #d1d5db; border-radius:6px; font-size:13px;
                       resize:vertical; margin-bottom:8px;"></textarea>
      <button id="${this._pfx('parse-btn')}"
              style="padding:7px 14px; background:#2563eb; color:#fff; border:none;
                     border-radius:5px; cursor:pointer; font-size:13px; margin-bottom:10px;">
        \uD83E\uDD16 Parse with AI
      </button>
      <div id="${this._pfx('chat')}"
           style="display:none; max-height:240px; overflow-y:auto; margin-bottom:8px; padding:2px;">
        <div id="${this._pfx('msgs')}"></div>
      </div>
      <div id="${this._pfx('reply-row')}"
           style="display:none; gap:6px; align-items:center; margin-bottom:4px;">
        <input type="text" id="${this._pfx('reply')}"
               placeholder="Type your answer\u2026"
               style="flex:1; padding:7px 10px; border:1px solid #d1d5db;
                      border-radius:5px; font-size:13px;">
        <button id="${this._pfx('send-btn')}"
                style="padding:7px 12px; background:#2563eb; color:#fff; border:none;
                       border-radius:5px; cursor:pointer; font-size:13px; white-space:nowrap;">
          Send \u2192
        </button>
      </div>
    `;

    this._els = {
      paste:    document.getElementById(this._pfx('paste')),
      parseBtn: document.getElementById(this._pfx('parse-btn')),
      chat:     document.getElementById(this._pfx('chat')),
      msgs:     document.getElementById(this._pfx('msgs')),
      replyRow: document.getElementById(this._pfx('reply-row')),
      reply:    document.getElementById(this._pfx('reply')),
      sendBtn:  document.getElementById(this._pfx('send-btn')),
    };

    this._els.parseBtn.addEventListener('click', () => this._parse());
    this._els.sendBtn.addEventListener('click',  () => this._sendReply());
    this._els.reply.addEventListener('keydown',  e => { if (e.key === 'Enter') this._sendReply(); });
  }

  /** Clear conversation state and reset UI to initial empty state. */
  reset() {
    this._conversation = [];
    if (!this._els.paste) return;
    this._els.paste.value            = '';
    this._els.chat.style.display     = 'none';
    this._els.msgs.innerHTML         = '';
    this._els.replyRow.style.display = 'none';
    this._els.reply.value            = '';
  }

  /**
   * Populate form inputs from a pre-parsed fields object.
   * Iterates this._fields map ({apiFieldName: '#css-selector'}),
   * then calls onComplete(extractedFields) if provided.
   */
  autofill(extractedFields) {
    if (!extractedFields) return;
    Object.entries(this._fields).forEach(([fieldName, selector]) => {
      const val = extractedFields[fieldName];
      if (val == null) return;
      const el = document.querySelector(selector);
      if (el) el.value = String(val);
    });
    if (this._onComplete) this._onComplete(extractedFields);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  async _parse() {
    const rawText = (this._els.paste?.value || '').trim();
    if (!rawText) { this._toast('Paste some text first', 'error'); return; }
    this._conversation = [{
      role:    'user',
      content: `Please extract the required fields from this text:\n\n${rawText}`,
    }];
    this._renderBubbles();
    this._els.replyRow.style.display = 'none';
    await this._call();
  }

  async _sendReply() {
    const text = (this._els.reply?.value || '').trim();
    if (!text) return;
    this._conversation.push({ role: 'user', content: text });
    this._els.reply.value            = '';
    this._els.replyRow.style.display = 'none';
    this._renderBubbles();
    await this._call();
  }

  async _call() {
    this._els.chat.style.display = 'block';
    const thinking = document.createElement('div');
    thinking.id = this._pfx('thinking');
    thinking.innerHTML = '<em style="font-size:12px; color:#9ca3af;">\uD83E\uDD16 Thinking\u2026</em>';
    this._els.msgs.appendChild(thinking);

    try {
      const r = await this._fetch(this._endpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          schema:       this._schema,
          conversation: this._conversation,
          project_slug: this._currentSlug(),
        }),
      });
      const d = await r.json();
      document.getElementById(this._pfx('thinking'))?.remove();

      if (d.error) { this._toast('AI: ' + d.error, 'error'); return; }

      this._conversation.push({ role: 'assistant', content: JSON.stringify(d) });
      this._renderBubbles();

      if (d.complete) {
        this.autofill(d.fields || d);
      } else if (d.follow_up) {
        this._els.replyRow.style.display = 'flex';
        this._els.reply.focus();
      }
    } catch (e) {
      document.getElementById(this._pfx('thinking'))?.remove();
      this._toast('Parse error: ' + e.message, 'error');
    }
  }

  _renderBubbles() {
    const el = this._els.msgs;
    if (!el) return;
    el.innerHTML = '';
    const PREFIX = 'Please extract the required fields from this text:\n\n';

    this._conversation.forEach(turn => {
      const div = document.createElement('div');
      div.style.cssText = 'margin-bottom:8px;';

      if (turn.role === 'user') {
        let preview = turn.content;
        if (preview.startsWith(PREFIX)) {
          preview = '\uD83D\uDCCB ' + preview.replace(PREFIX, '').slice(0, 80) +
                    (preview.length > 130 ? '\u2026' : '');
        } else {
          preview = '\uD83D\uDC64 ' + preview;
        }
        div.innerHTML = `<div style="background:#f3f4f6; padding:7px 10px; border-radius:6px;
                                     font-size:12px; color:#374151;">${this._escape(preview)}</div>`;
      } else {
        try {
          const p = JSON.parse(turn.content);
          let html = `<div style="background:#eff6ff; border:1px solid #bfdbfe; padding:9px 11px;
                                  border-radius:6px; font-size:12px; color:#1e40af;">`;
          html += `<div style="font-weight:600; margin-bottom:4px;">\uD83E\uDD16 ${this._escape(p.summary || 'Parsed')}</div>`;
          if (p.notes)    html += `<div style="color:#3b82f6; margin-bottom:4px;">${this._escape(p.notes)}</div>`;
          if (p.complete) {
            html += `<div style="color:#16a34a; font-weight:600;">\u2713 Fields ready \u2014 review the form below.</div>`;
          } else if (p.follow_up) {
            html += `<div style="margin-top:4px; font-style:italic;">${this._escape(p.follow_up)}</div>`;
          }
          html += '</div>';
          div.innerHTML = html;
        } catch {
          div.innerHTML = `<div style="font-size:12px; color:#6b7280;">${this._escape(turn.content)}</div>`;
        }
      }
      el.appendChild(div);
    });

    el.scrollTop = el.scrollHeight;
  }
}
