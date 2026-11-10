'use strict';
/**
 * The editor's block inserter (stage B1). Progressive enhancement only: the form is a plain textarea
 * that saves without this file. Here it gets
 *
 *   - a "/" menu: type "/" at the start of a line, or press the toolbar button;
 *   - a form per block, with a live preview rendered by the server's own renderer (/write/preview);
 *   - drag to reorder the top-level blocks in the outline;
 *   - picture search through the shared image task (Commons and Openverse, stored in Media);
 *   - "Make an image", the image task through OpenVibe.AI (/write/make-image).
 *
 * Blocks are the Markdown directives openvibe-publishing/blocks parses; the textarea stays the source
 * of truth, so a reader without script (or another editor) still sees the text.
 */
(function () {
    var root = document.querySelector('[data-ov-editor]');
    if (!root) return;
    var ta = root.querySelector('textarea');
    var panel = root.querySelector('[data-ov-panel]');
    var outlinePanel = root.querySelector('[data-ov-outline-panel]');
    var insertBtn = root.querySelector('[data-ov-insert]');
    var outlineBtn = root.querySelector('[data-ov-outline]');
    if (!ta || !panel) return;

    var CSRF = root.getAttribute('data-csrf') || '';
    var POST = root.getAttribute('data-post') || '';
    var PREVIEW = root.getAttribute('data-preview') || '/write/preview';
    var IMAGE = root.getAttribute('data-image') || '/write/make-image';
    var FIND = root.getAttribute('data-find') || '/write/find-images';

    var BLOCKS = [
        { type: 'hero', label: 'Hero banner', hint: 'The post’s title art, kicker and teaser, as a banner at the top.', body: true, bodyDefault: '# Name of the update\nOne or two sentences that say what this is, and why it matters.', fields: [{ n: 'art', l: 'Art (Media id med_…)', ph: 'med_…' }, { n: 'kicker', l: 'Kicker', ph: 'Devblog' }, { n: 'date', l: 'Date', type: 'date' }] },
        { type: 'section', label: 'Section', hint: 'A big heading, an optional "by <person>", and reactions if you want them.', body: true, bodyDefault: '## Heading\nWrite the section.', fields: [{ n: 'id', l: 'Id (a slug)', ph: 'channel-stage' }, { n: 'by', l: 'By (person usr_…)', ph: 'usr_…' }, { n: 'react', l: 'Let readers react (👍/👎)', type: 'checkbox' }] },
        { type: 'figure', label: 'Picture', hint: 'A Media object, with alt text and a caption.', fields: [{ n: 'src', l: 'Media id', ph: 'med_…' }, { n: 'alt', l: 'Alt text' }, { n: 'caption', l: 'Caption' }, { n: 'credit', l: 'Credit (optional)' }, { n: 'width', l: 'Width (px)', type: 'number' }, { n: 'height', l: 'Height (px)', type: 'number' }] },
        { type: 'compare', label: 'Before / after', fields: [{ n: 'before', l: 'Before (Media id)', ph: 'med_…' }, { n: 'after', l: 'After (Media id)', ph: 'med_…' }, { n: 'caption', l: 'Caption' }] },
        { type: 'gallery', label: 'Gallery', fields: [{ n: 'items', l: 'Media ids, comma-separated', ph: 'med_…, med_…' }, { n: 'caption', l: 'Caption' }] },
        { type: 'clip', label: 'Clip', fields: [{ n: 'id', l: 'Clip or video id', ph: 'clp_…' }] },
        { type: 'video', label: 'Video', fields: [{ n: 'id', l: 'Clip or video id', ph: 'vod_…' }] },
        { type: 'pic', label: 'Picture (from Pics)', fields: [{ n: 'id', l: 'Media id', ph: 'med_…' }, { n: 'alt', l: 'Alt text' }, { n: 'caption', l: 'Caption' }] },
        { type: 'embed', label: 'Link embed', fields: [{ n: 'url', l: 'Address (https://…)', ph: 'https://openvibe.live/…' }] },
        { type: 'callout', label: 'Callout', body: true, bodyDefault: 'What the reader should not miss.', fields: [{ n: 'tone', l: 'Tone', type: 'select', options: ['info', 'warn', 'tip'] }, { n: 'title', l: 'Title (optional)' }] },
        { type: 'stat', label: 'Stat', fields: [{ n: 'value', l: 'The number', ph: '43' }, { n: 'label', l: 'What it counts', ph: 'sites updated' }] },
        { type: 'patchnotes', label: 'Patch notes', hint: 'The full list, folded, grouped by site, every commit linked.', fields: [{ n: 'from', l: 'From (YYYY-MM-DD)', type: 'date' }, { n: 'to', l: 'To (YYYY-MM-DD)', type: 'date' }] },
        { type: 'infobox', label: 'Infobox', hint: 'One row per line, as "key: value".', body: true, bodyDefault: 'First appearance: October 2026\nCreated by: the OpenVibe team', fields: [{ n: 'title', l: 'Title (optional)' }] },
        { type: 'timeline', label: 'Timeline', hint: 'One moment per line, as "when: what happened".', body: true, bodyDefault: '2026-10-01: The first release.\n2026-11-09: The devblog.', fields: [{ n: 'title', l: 'Title (optional)' }] },
        { type: 'quote', label: 'Quote', body: true, bodyDefault: 'The words.', fields: [{ n: 'by', l: 'Said by' }] },
    ];

    var esc = function (s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };

    // ── The textarea ────────────────────────────────────────
    function replaceSelection(text) {
        var s = ta.selectionStart;
        var e = ta.selectionEnd;
        if (typeof ta.setRangeText === 'function') ta.setRangeText(text, s, e, 'end');
        else {
            ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
            ta.selectionStart = ta.selectionEnd = s + text.length;
        }
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function insertBlock(text) {
        var s = ta.selectionStart;
        var e = ta.selectionEnd;
        var before = ta.value.slice(0, s);
        var after = ta.value.slice(e);
        var lead = before && !/\n$/.test(before) ? '\n' : '';
        var tail = after && !/^\n/.test(after) ? '\n' : '';
        replaceSelection(lead + text + tail);
        ta.focus();
    }

    // ── Building a directive ────────────────────────────────
    function build(spec, values) {
        var attrs = '';
        spec.fields.forEach(function (f) {
            var v = values[f.n];
            if (f.type === 'checkbox') { if (v) attrs += ' ' + f.n; return; }
            if (v == null || String(v).trim() === '') return;
            attrs += ' ' + f.n + '="' + String(v).trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
        });
        var open = ':::' + spec.type + (attrs ? '{' + attrs + '}' : '');
        if (!spec.body) return open + ':::';
        var text = String(values._body == null ? (spec.bodyDefault || '') : values._body).replace(/\s+$/, '');
        return open + '\n' + text + '\n:::';
    }

    // ── The panel ───────────────────────────────────────────
    function openPanel(html) {
        panel.hidden = false;
        panel.innerHTML = html;
        if (insertBtn) insertBtn.setAttribute('aria-expanded', 'true');
    }
    function closePanel() {
        panel.hidden = true;
        panel.innerHTML = '';
        if (insertBtn) insertBtn.setAttribute('aria-expanded', 'false');
        menuOpen = false;
    }

    function previewInto(el, markdown) {
        clearTimeout(el._timer);
        el._timer = setTimeout(function () {
            var body = new URLSearchParams({ _csrf: CSRF, markdown: markdown, ...(POST ? { post_id: POST } : {}) });
            fetch(PREVIEW, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() })
                .then(function (r) { return r.json(); })
                .then(function (d) { el.innerHTML = d && typeof d.html === 'string' ? d.html : '<p class="meta">No preview.</p>'; })
                .catch(function () { el.innerHTML = '<p class="meta">The preview could not be rendered.</p>'; });
        }, 350);
    }

    function showMenu(query) {
        menuOpen = true;
        menuQuery = query || '';
        menuIndex = 0;
        var q = menuQuery.toLowerCase();
        menuItems = BLOCKS.filter(function (b) { return !q || b.label.toLowerCase().indexOf(q) !== -1 || b.type.indexOf(q) !== -1; });
        openPanel('<div class="ov-editor-menu" role="listbox" aria-label="Insert a block">'
            + (menuItems.length ? menuItems.map(function (b, i) {
                return '<button type="button" role="option" data-ov-choice="' + i + '"' + (i === menuIndex ? ' aria-selected="true"' : '') + '><b>:::' + esc(b.type) + '</b><span>' + esc(b.label) + '</span></button>';
            }).join('') : '<p class="meta">No block matches “' + esc(menuQuery) + '”.</p>')
            + '</div>');
        panel.querySelectorAll('[data-ov-choice]').forEach(function (b) {
            b.addEventListener('click', function () { choose(Number(b.getAttribute('data-ov-choice'))); });
        });
    }
    var menuOpen = false;
    var menuQuery = '';
    var menuIndex = 0;
    var menuItems = [];

    function choose(i) {
        var spec = menuItems[i];
        if (!spec) return;
        var m = slashMatch();
        if (m) { ta.setSelectionRange(m.start, m.start + m.length); replaceSelection(''); }
        showForm(spec);
    }

    function showForm(spec) {
        menuOpen = false;
        var fields = spec.fields.map(function (f) {
            if (f.type === 'checkbox') return '<label class="ov-chk"><input type="checkbox" name="' + f.n + '"> ' + esc(f.l) + '</label>';
            if (f.type === 'select') return '<label>' + esc(f.l) + '<select name="' + f.n + '">' + (f.options || []).map(function (o) { return '<option>' + esc(o) + '</option>'; }).join('') + '</select></label>';
            return '<label>' + esc(f.l) + '<input name="' + f.n + '" type="' + esc(f.type || 'text') + '" placeholder="' + esc(f.ph || '') + '"></label>';
        }).join('');
        if (spec.body) fields += '<label>Text<textarea name="_body" rows="5">' + esc(spec.bodyDefault || '') + '</textarea></label>';
        openPanel('<div class="ov-editor-card"><div class="ov-editor-cardhead"><h3>' + esc(spec.label) + '</h3><button type="button" class="ov-editor-x" data-ov-close aria-label="Close">×</button></div>'
            + (spec.hint ? '<p class="meta">' + esc(spec.hint) + '</p>' : '')
            + '<div class="ov-editor-form" data-ov-form>' + fields
            + '<div class="ov-editor-actions"><button type="button" data-ov-insertbtn>Insert</button>'
            + (spec.type === 'figure' || spec.type === 'hero' || spec.type === 'pic' ? '<button type="button" class="ov-editor-alt" data-ov-search>Find a picture</button><button type="button" class="ov-editor-alt" data-ov-make>Make an image</button>' : '')
            + '</div></div><h4 class="ov-editor-ph">Preview</h4><div class="ov-editor-preview post-body" data-ov-preview aria-live="polite"></div></div>');
        panel.querySelector('[data-ov-close]').addEventListener('click', closePanel);
        // The editor page is itself one big form, so the inserter's form is a div: a nested <form>
        // would be dropped by the parser and its fields would never be read.
        var form = panel.querySelector('[data-ov-form]');
        var preview = panel.querySelector('[data-ov-preview]');
        var read = function () {
            var values = {};
            form.querySelectorAll('[name]').forEach(function (el) {
                values[el.name] = el.type === 'checkbox' ? el.checked : el.value;
            });
            return values;
        };
        var redraw = function () { previewInto(preview, build(spec, read())); };
        form.addEventListener('input', redraw);
        form.addEventListener('change', redraw);
        form.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); insertBlock(build(spec, read())); closePanel(); }
        });
        panel.querySelector('[data-ov-insertbtn]').addEventListener('click', function () {
            insertBlock(build(spec, read()));
            closePanel();
        });
        var find = panel.querySelector('[data-ov-search]');
        if (find) find.addEventListener('click', showSearch);
        var make = panel.querySelector('[data-ov-make]');
        if (make) make.addEventListener('click', showImage);
        redraw();
    }

    // ── Picture search: the shared image task, through Blog and OpenVibe.AI ──
    function showSearch() {
        openPanel('<div class="ov-editor-card"><div class="ov-editor-cardhead"><h3>Find a picture</h3><button type="button" class="ov-editor-x" data-ov-close aria-label="Close">×</button></div>'
            + '<p class="meta">Wikimedia Commons and Openverse, found through OpenVibe.AI and stored in OpenVibe.Media with their licence and author. A picture found here is inserted as a figure that names its Media object.</p>'
            + '<div class="ov-editor-form ov-editor-search" data-ov-searchform><label>Search<input type="search" name="q" placeholder="a channel, a workbench, a town…"></label><div class="ov-editor-actions"><button type="button" data-ov-searchgo>Search</button></div></div>'
            + '<p class="meta" data-ov-status aria-live="polite"></p><ul class="ov-editor-results" data-ov-results></ul></div>');
        panel.querySelector('[data-ov-close]').addEventListener('click', closePanel);
        var form = panel.querySelector('[data-ov-searchform]');
        var status = panel.querySelector('[data-ov-status]');
        var results = panel.querySelector('[data-ov-results]');
        var search = function () {
            var q = form.querySelector('input[name=q]').value;
            if (!q) return;
            status.textContent = 'Searching Commons and Openverse…';
            results.innerHTML = '';
            var body = new URLSearchParams({ _csrf: CSRF, q: q });
            fetch(FIND, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() })
                .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
                .then(function (x) {
                    if (!x.ok) { status.textContent = x.d && (x.d.detail || x.d.message) || 'The image task is not available here.'; return; }
                    var items = (x.d && x.d.items) || [];
                    status.textContent = items.length ? items.length + ' pictures' : (x.d && x.d.note) || 'No pictures found.';
                    results.innerHTML = items.map(function (p, i) {
                        return '<li><img src="' + esc(p.url) + '" alt="" loading="lazy" decoding="async"><div><b>' + esc(p.title || 'Untitled') + '</b><span class="meta">' + esc([p.author, p.license].filter(Boolean).join(' · ')) + '</span></div><button type="button" data-ov-pick="' + i + '">Insert</button></li>';
                    }).join('');
                    results.querySelectorAll('[data-ov-pick]').forEach(function (b) {
                        b.addEventListener('click', function () {
                            var p = items[Number(b.getAttribute('data-ov-pick'))];
                            var alt = (p.alt || p.title || 'Picture').replace(/\s+/g, ' ').slice(0, 200);
                            var credit = p.credit || [p.author, p.license].filter(Boolean).join(', ');
                            if (p.mediaId) {
                                insertBlock(':::figure{src="' + p.mediaId + '" alt="' + alt.replace(/"/g, '\\"') + '"' + (p.caption ? ' caption="' + String(p.caption).replace(/"/g, '\\"') + '"' : '') + (credit ? ' credit="' + credit.replace(/"/g, '\\"') + '"' : '') + '}:::');
                            } else {
                                insertBlock('![' + alt.replace(/[[\]]/g, '') + '](' + p.url + ')\n*Picture: ' + credit + '*');
                            }
                            closePanel();
                        });
                    });
                })
                .catch(function () { status.textContent = 'The image task could not be reached.'; });
        };
        panel.querySelector('[data-ov-searchgo]').addEventListener('click', search);
        form.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); search(); } });
    }

    // ── Make an image ───────────────────────────────────────
    function showImage() {
        openPanel('<div class="ov-editor-card"><div class="ov-editor-cardhead"><h3>Make an image</h3><button type="button" class="ov-editor-x" data-ov-close aria-label="Close">×</button></div>'
            + '<p class="meta">The image task through OpenVibe.AI, with the model the network chooses. The picture is stored in OpenVibe.Media; its credit says which model made it.</p>'
            + '<div class="ov-editor-form" data-ov-imageform><label>What should it show?<textarea name="prompt" rows="3" maxlength="1000"></textarea></label><label>Alt text<input name="alt" maxlength="300"></label>'
            + '<div class="ov-editor-actions"><button type="button" data-ov-imagego>Make the image</button></div></div>'
            + '<p class="meta" data-ov-status aria-live="polite"></p><div class="ov-editor-preview" data-ov-made></div></div>');
        panel.querySelector('[data-ov-close]').addEventListener('click', closePanel);
        var form = panel.querySelector('[data-ov-imageform]');
        var status = panel.querySelector('[data-ov-status]');
        var made = panel.querySelector('[data-ov-made]');
        panel.querySelector('[data-ov-imagego]').addEventListener('click', function () {
            var prompt = form.querySelector('[name=prompt]').value;
            var alt = form.querySelector('[name=alt]').value;
            if (!prompt.trim()) { status.textContent = 'Say what the image should show.'; return; }
            status.textContent = 'Making the image…';
            var body = new URLSearchParams({ _csrf: CSRF, prompt: prompt, alt: alt });
            fetch(IMAGE, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() })
                .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
                .then(function (x) {
                    if (!x.ok) { status.textContent = x.d && (x.d.detail || x.d.message) || 'The image task is not available here.'; return; }
                    var alt = (x.d.alt || 'Illustration').replace(/\s+/g, ' ').slice(0, 200);
                    if (x.d.dryRun) { status.textContent = 'This would make ' + (x.d.estimate ? x.d.estimate.images : 1) + ' image with ' + (x.d.estimate ? x.d.estimate.model : 'the model') + ', about $' + (x.d.estimate ? x.d.estimate.price_usd : '?') + '.'; return; }
                    if (x.d.mediaId) {
                        var credit = String(x.d.credit || ('Made with AI (' + String(x.d.model || 'AI') + ')')).replace(/"/g, '');
                        var caption = String(x.d.caption || '').replace(/"/g, '\\"');
                        insertBlock(':::figure{src="' + x.d.mediaId + '" alt="' + alt.replace(/"/g, '\\"') + '"' + (caption ? ' caption="' + caption + '"' : '') + ' credit="' + credit + '"}:::');
                        status.textContent = 'Inserted as a figure, made in OpenVibe.Media.';
                        closePanel();
                    } else if (x.d.url) {
                        made.innerHTML = '<img src="' + esc(x.d.url) + '" alt="">';
                        status.textContent = 'Inserting the picture as a linked image…';
                        insertBlock('![' + alt.replace(/[[\]]/g, '') + '](' + x.d.url + ')\n*' + String(x.d.credit || 'Made with AI') + '*');
                        closePanel();
                    } else {
                        status.textContent = 'The run answered without a picture.';
                    }
                })
                .catch(function () { status.textContent = 'The image task could not be reached.'; });
        });
    }

    // ── The outline: the top-level blocks, dragged into another order ──
    var dragFrom = null;
    function chunksOf(text) {
        var lines = String(text).split('\n');
        var chunks = [];
        var depth = 0;
        var start = 0;
        var current = null;
        var pushProse = function (end) {
            if (end <= start) return;
            var body = lines.slice(start, end).join('\n');
            if (body.trim()) chunks.push({ type: 'text', label: 'Prose', start: start, end: end, body: body });
        };
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            var leaf = /^:::([a-z][a-z0-9_]*)(\{.*\})?:::\s*$/.exec(line);
            var open = /^:::([a-z][a-z0-9_]*)/.exec(line);
            if (leaf) {
                if (depth === 0) {
                    pushProse(i);
                    chunks.push({ type: leaf[1], label: labelOf(leaf[1], lines.slice(i + 1, i + 2)), start: i, end: i + 1, body: line });
                    start = i + 1;
                }
                continue;
            }
            if (open) {
                if (depth === 0) { pushProse(i); current = { type: open[1], start: i }; }
                depth++;
                continue;
            }
            if (/^:::\s*$/.test(line)) {
                depth = Math.max(0, depth - 1);
                if (depth === 0 && current) {
                    current.end = i + 1;
                    current.label = labelOf(current.type, lines.slice(current.start + 1, i).slice(0, 6));
                    current.body = lines.slice(current.start, i + 1).join('\n');
                    chunks.push(current);
                    current = null;
                    start = i + 1;
                }
            }
        }
        pushProse(lines.length);
        return chunks;
    }
    var LABELS = { hero: 'Hero', section: 'Section', text: 'Prose', figure: 'Picture', gallery: 'Gallery', compare: 'Before / after', callout: 'Callout', stat: 'Stat', quote: 'Quote', infobox: 'Infobox', timeline: 'Timeline', patchnotes: 'Patch notes' };
    function labelOf(type, lines) {
        var name = LABELS[type] || type;
        for (var i = 0; i < (lines || []).length; i++) {
            var m = /^#{1,3}\s+(.+)$/.exec(lines[i] || '');
            if (m) return name + ': ' + m[1].trim().slice(0, 70);
        }
        return name;
    }
    function renderOutline() {
        var chunks = chunksOf(ta.value);
        if (!chunks.length) { outlinePanel.innerHTML = '<p class="meta">Nothing to outline yet.</p>'; return; }
        outlinePanel.innerHTML = '<p class="meta">Drag a block to move it. Prose moves with its own lines.</p><ol class="ov-editor-outline-list">'
            + chunks.map(function (c, i) {
                return '<li draggable="true" data-ov-chunk="' + i + '"><span class="ov-editor-grip" aria-hidden="true">⠿</span><b>' + esc(c.label) + '</b><span class="meta">' + esc(':::' + (c.type === 'text' ? 'prose' : c.type)) + '</span></li>';
            }).join('') + '</ol>';
        outlinePanel._chunks = chunks;
        outlinePanel.querySelectorAll('[data-ov-chunk]').forEach(function (li) {
            li.addEventListener('dragstart', function (e) {
                dragFrom = Number(li.getAttribute('data-ov-chunk'));
                if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(dragFrom)); }
                li.classList.add('is-dragging');
            });
            li.addEventListener('dragend', function () { li.classList.remove('is-dragging'); dragFrom = null; });
            li.addEventListener('dragover', function (e) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; });
            li.addEventListener('drop', function (e) {
                e.preventDefault();
                var to = Number(li.getAttribute('data-ov-chunk'));
                if (dragFrom == null || dragFrom === to) return;
                var list = outlinePanel._chunks.slice();
                var moved = list.splice(dragFrom, 1)[0];
                list.splice(to, 0, moved);
                ta.value = list.map(function (c) { return c.body; }).join('\n');
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                renderOutline();
            });
        });
    }
    if (outlineBtn) {
        outlineBtn.addEventListener('click', function () {
            var open = outlinePanel.hidden;
            outlinePanel.hidden = !open;
            outlineBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
            if (open) renderOutline();
        });
    }
    ta.addEventListener('input', function () {
        maybeMenu();
        if (outlinePanel && !outlinePanel.hidden) renderOutline();
    });

    // ── The "/" menu ────────────────────────────────────────
    function slashMatch() {
        var s = ta.selectionStart;
        var lineStart = ta.value.lastIndexOf('\n', s - 1) + 1;
        var before = ta.value.slice(lineStart, s);
        var m = /^\/([a-z0-9 _-]*)$/i.exec(before);
        return m ? { start: lineStart, length: before.length, q: m[1] } : null;
    }
    var menuTimer = null;
    function maybeMenu() {
        clearTimeout(menuTimer);
        menuTimer = setTimeout(function () {
            var m = slashMatch();
            if (m) { if (!menuOpen || m.q !== menuQuery) showMenu(m.q); }
            else if (menuOpen) closePanel();
        }, 120);
    }
    if (insertBtn) insertBtn.addEventListener('click', function () { if (menuOpen) closePanel(); else showMenu(''); });
    ta.addEventListener('keydown', function (e) {
        if (!menuOpen) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!menuItems.length) return;
            menuIndex = (menuIndex + (e.key === 'ArrowDown' ? 1 : -1) + menuItems.length) % menuItems.length;
            panel.querySelectorAll('[data-ov-choice]').forEach(function (b, i) { b.setAttribute('aria-selected', i === menuIndex ? 'true' : 'false'); });
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            if (!menuItems.length) return;
            e.preventDefault();
            choose(menuIndex);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closePanel();
        }
    });
})();
