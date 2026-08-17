/**
 * @name BetterDoubleClickToEdit
 * @author Atamol
 * @version 1.2.0
 * @description Double click your own message to quickly edit it.
 * @source https://github.com/Atamol/BetterDiscordPlugins
 */

const { Webpack, Webpack: { Filters }, Data, Utils, ReactUtils, UI, React } = BdApi,

	config = {},

	ignore = [
		"video",
		"emoji",
		"content",
		"reactionInner"
	],
	walkable = [
		"child",
		"memoizedProps",
		"sibling"
	];


module.exports = class BetterDoubleClickToEdit {

	constructor(meta) { config.info = meta; }

	// An in-progress multi-click edit gesture: { messageDiv, message, timer }.
	_gesture = null;

	// After the mouse is released we wait briefly to see whether another click
	// is coming (2 clicks -> word, 3 -> paragraph, ...). A new mousedown cancels
	// this and re-arms, so the wait never interrupts a drag (button held = no
	// mouseup yet). Only used to distinguish "gesture finished" from "more clicks".
	static SETTLE_DELAY = 250;

	// The edit we most recently opened, so Ctrl+C right after can close it.
	_recentEdit = null;

	// Default copy-cancel window (ms). Configurable via copyCancelWindow setting;
	// 0 = no timeout (track until the user acts).
	static DEFAULT_COPY_CANCEL_WINDOW = 5000;

	start() {
		try {
			this.selectedClass = Webpack.getModule(Filters.byKeys("message", "selected"))?.selected;

			this.MessageActions = Webpack.getModule(Filters.byKeys("receiveMessage", "editMessage"));
			const messageStore = Webpack.getModule(Filters.byKeys("getMessage", "getMessages"));
			this.getMessage = messageStore?.getMessage?.bind(messageStore);
			this.CurrentUserStore = Webpack.getModule(Filters.byKeys("getCurrentUser"));

			if (!this.MessageActions?.startEditMessage || !this.CurrentUserStore?.getCurrentUser) {
				UI.showToast?.(`${config.info.name}: a Discord module changed, plugin needs an update`, { type: "error" });
				return;
			}

			this.doubleClickToEditModifier = Data.load(config.info.slug, "doubleClickToEditModifier") ?? false;
			this.editModifier = Data.load(config.info.slug, "editModifier") ?? "shift";
			this.preserveSelection = Data.load(config.info.slug, "preserveSelection") ?? true;
			this.tripleClickParagraph = Data.load(config.info.slug, "tripleClickParagraph") ?? false;
			this.cancelEditOnCopy = Data.load(config.info.slug, "cancelEditOnCopy") ?? false;
			this.copyCancelWindow = Data.load(config.info.slug, "copyCancelWindow") ?? BetterDoubleClickToEdit.DEFAULT_COPY_CANCEL_WINDOW;
			this.debug = Data.load(config.info.slug, "debug") ?? false;

			global.document.addEventListener('mousedown', this.mouseDownFunc, true);
			global.document.addEventListener('mouseup', this.mouseUpFunc, true);
			global.document.addEventListener('click', this.altClickSuppressor, true);
			global.document.addEventListener('keydown', this.copyKeyFunc, true);
		}
		catch (err) {
			console.error(config.info?.name, "failed to start", err);
			try { this.stop(); }
			catch (e) { console.error(config.info?.name, "stop after error", e); }
		}
	}

	log(...args) {
		if (this.debug) console.log(`[${config.info?.name}]`, ...args);
	}

	// Render a string with visible markers for whitespace so offsets are readable.
	vis(s) {
		return String(s).replace(/\n/g, "↵").replace(/\t/g, "→");
	}

	// Arm the gesture on the 2nd+ click of a multi-click (e.detail counts clicks:
	// 2 = double = word, 3 = triple = paragraph). We do NOT edit yet — the user
	// may still drag to extend the selection while the button is held.
	mouseDownFunc = (e) => {
		if (e.button !== 0) return; // left button only
		// A new press cancels any pending commit: the gesture is continuing
		// (another click) or a fresh one is starting.
		if (this._gesture?.timer) clearTimeout(this._gesture.timer);

		if (e.detail < 2) { this._gesture = null; return; }

		const target = this.resolveEditTarget(e);
		this._gesture = target ? { ...target, timer: null } : null;
	};

	// The button was released. If a gesture is armed, the selection (word,
	// paragraph, or a drag-extended range) is now final. Commit — but when
	// triple-click is enabled, wait briefly first: another click may still be
	// coming to widen the selection, and a new mousedown cancels this timer.
	mouseUpFunc = (e) => {
		const g = this._gesture;
		if (!g || e.button !== 0) return;

		// Capture the browser selection before the settle delay. Discord can clear
		// it while the delayed triple-click decision is still pending.
		if (this.preserveSelection) {
			const contentEl = g.messageDiv.querySelector('[id^="message-content"]') || g.messageDiv;
			g.selection = this.getSelectionOffsets(contentEl);
			g.selectionRoot = contentEl;
			if (!g.selection && contentEl !== g.messageDiv) {
				g.selectionRoot = g.messageDiv;
				g.selection = this.getSelectionOffsets(g.messageDiv);
			}
			g.selectionText = g.selectionRoot.textContent ?? "";
		}

		const commit = () => { this._gesture = null; this.commitEdit(g.messageDiv, g.message, g.selection, g.selectionText); };
		if (this.tripleClickParagraph && this.preserveSelection)
			g.timer = setTimeout(commit, BetterDoubleClickToEdit.SETTLE_DELAY);
		else
			commit();
	};

	// Alt+double-click would otherwise fire Discord's own alt action on the message
	altClickSuppressor = (e) => {
		if (!e.altKey) return;
		if (!(this.doubleClickToEditModifier && this.editModifier === "alt")) return;
		if (!e.target?.closest?.('[data-list-item-id^="chat-messages"]')) return;
		e.stopImmediatePropagation();
		e.preventDefault();
	};

	stop = () => {
		if (this._gesture?.timer) clearTimeout(this._gesture.timer);
		this._gesture = null;
		this._recentEdit = null;
		document.removeEventListener('mousedown', this.mouseDownFunc, true);
		document.removeEventListener('mouseup', this.mouseUpFunc, true);
		document.removeEventListener('click', this.altClickSuppressor, true);
		document.removeEventListener('keydown', this.copyKeyFunc, true);
	};

	// Build the settings list for the current state. Child settings only appear
	// when their gating switch is on, so the panel stays uncluttered.
	buildSettingsList() {
		const settings = [];

		// --- Selection group ---
		settings.push({
			type: "switch",
			id: "preserveSelection",
			name: "Preserve Text Selection",
			note: "Carry the text you selected into the edit box instead of losing it",
			value: this.preserveSelection
		});
		if (this.preserveSelection) {
			settings.push({
				type: "switch",
				id: "tripleClickParagraph",
				name: "Triple-Click & Drag Selection",
				note: "Start editing only when you release the mouse, so you can double/triple-click and drag to extend the selection first",
				value: this.tripleClickParagraph
			});
			settings.push({
				type: "switch",
				id: "cancelEditOnCopy",
				name: "Close Edit on Ctrl+C",
				note: "If you press Ctrl+C to copy right after editing starts, close the editor instead of staying in edit mode",
				value: this.cancelEditOnCopy
			});
			if (this.cancelEditOnCopy) {
				settings.push({
					type: "number",
					id: "copyCancelWindow",
					name: "Ctrl+C Window (ms)",
					note: "How long after editing starts a Ctrl+C still closes the editor. 0 = no limit (until you press any other key).",
					value: this.copyCancelWindow
				});
			}
			settings.push({
				type: "switch",
				id: "debug",
				name: "Debug Logging",
				note: "Log selection mapping details to the console (Ctrl+Shift+I)",
				value: this.debug
			});
		}

		// --- Modifier group ---
		settings.push({
			type: "switch",
			id: "doubleClickToEditModifier",
			name: "Enable Edit Modifier",
			note: "Require holding a modifier key while double clicking to edit",
			value: this.doubleClickToEditModifier
		});
		if (this.doubleClickToEditModifier) {
			settings.push({
				type: "radio",
				id: "editModifier",
				name: "Modifier to hold to edit a message",
				value: this.editModifier,
				options: [
					{ name: "Ctrl", value: "ctrl" },
					{ name: "Shift", value: "shift" },
					{ name: "Alt", value: "alt" }
				]
			});
		}

		return settings;
	}

	getSettingsPanel() {
		// buildSettingsPanel returns a React element and its `settings` are fixed
		// at build time. Gating switches change which children exist, so host the
		// panel in a component and force a re-render when a gate flips.
		const gates = new Set(["preserveSelection", "doubleClickToEditModifier", "cancelEditOnCopy"]);
		const self = this;

		return React.createElement(function SettingsHost() {
			const [, forceUpdate] = React.useReducer(x => x + 1, 0);
			return UI.buildSettingsPanel({
				settings: self.buildSettingsList(),
				onChange: (_category, id, value) => {
					self[id] = value;
					Data.save(config.info.slug, id, value);
					if (gates.has(id)) forceUpdate();
				}
			});
		});
	}

	// Validate a click event and return { messageDiv, message } if it targets an
	// editable message of the current user, else null. Does not start editing.
	resolveEditTarget(e) {
		if (e.target?.closest?.('textarea, input, [contenteditable="true"]'))
			return null;

		if (typeof (e?.target?.className) !== typeof ("") ||
			ignore.some(name => e?.target?.className?.indexOf?.(name) > -1))
			return null;

		const messageDiv = e.target.closest(
			'[data-list-item-id^="chat-messages"], ' +
			'article[class*="message"], ' +
			'div[class*="messageContainer"], ' +
			'li > div[class*="message"], ' +
			'li[class*="message"]'
		);
		if (!messageDiv)
			return null;
		if (this.selectedClass && messageDiv.classList.contains(this.selectedClass))
			return null;

		if (this.doubleClickToEditModifier && !this.checkModifier(this.editModifier, e))
			return null;

		const message = this.resolveMessage(messageDiv);
		if (!message || message.author.id !== this.CurrentUserStore.getCurrentUser().id)
			return null;

		return { messageDiv, message };
	}

	commitEdit(messageDiv, message, capturedSelection = null, capturedSelectionText = null) {
		// Capture the selection BEFORE the edit box replaces the message. The edit
		// box holds raw markdown (message.content) while the view shows rendered
		// text, so we align the two character-by-character to translate offsets.
		let rawRange = null;
		if (this.preserveSelection) {
			const contentEl = messageDiv.querySelector('[id^="message-content"]') || messageDiv;
			let rendered = capturedSelection || this.getSelectionOffsets(contentEl);
			if (rendered) {
				const renderedText = capturedSelectionText ?? contentEl.textContent ?? "";
				const raw = message.content ?? "";
				// A double-click often grabs the trailing space after a word; drop
				// leading/trailing whitespace so it isn't carried into the edit box.
				rendered = this.trimOffsets(renderedText, rendered);
				// Strip line-level prefixes (-#, #, >, ...) so the inline aligner
				// never stalls on syntax it doesn't recognize, then compose maps
				// back to real raw offsets.
				const { text: cleaned, map: cleanedMap } = this.stripLinePrefixes(raw);
				const rMap = this.buildOffsetMap(renderedText, cleaned);
				const toRaw = (i) => cleanedMap[Math.min(rMap[i], cleaned.length)];
				// End: anchor to the LAST selected char (+1), not the next char.
				// Mapping the next char swallows any gap between them (newline +
				// next list-item prefix), bleeding the selection into the next item.
				const toRawEnd = (endExcl) => endExcl > rendered.start
					? cleanedMap[Math.min(rMap[endExcl - 1], cleaned.length - 1)] + 1
					: toRaw(endExcl);
				const mapped = { start: toRaw(rendered.start), end: toRawEnd(rendered.end) };
				rawRange = this.refineRawRange(raw, mapped.start, mapped.end);

				this.log("selection captured", {
					renderedText: this.vis(renderedText),
					raw: this.vis(raw),
					renderedSel: this.vis(renderedText.slice(rendered.start, rendered.end)),
					renderedOffsets: rendered,
					mappedOffsets: mapped,
					mappedSlice: this.vis(raw.slice(mapped.start, mapped.end)),
					refinedRange: rawRange,
					refinedSlice: this.vis(raw.slice(rawRange.start, rawRange.end))
				});
			}
			else {
				this.log("no usable selection to preserve");
			}
		}

		this.MessageActions.startEditMessage(message.channel_id, message.id, message.content);
		this._recentEdit = { channelId: message.channel_id, messageId: message.id, at: Date.now() };

		if (rawRange && rawRange.end > rawRange.start)
			this.transferSelection(messageDiv, rawRange);
	}

	// First key after an edit opens decides its fate: Ctrl/Cmd+C (copy) with a
	// selection means "I only wanted to copy" -> close the editor. Any other
	// meaningful key (incl. Ctrl+X / Ctrl+V) means the user is really editing ->
	// stop tracking. Pure modifier presses are ignored so a real Ctrl+C still
	// registers. copyCancelWindow (ms) bounds how long we watch; 0 = no limit.
	copyKeyFunc = (e) => {
		// Ignore standalone modifier keydowns — they precede the actual shortcut.
		if (["Control", "Meta", "Shift", "Alt", "AltGraph"].includes(e.key)) return;

		// While waiting to distinguish a double click from a triple click, Ctrl+C
		// means the user wants to copy the selection, not open the editor.
		const isCopy = e.code === "KeyC" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
		if (isCopy && this.tripleClickParagraph && this.preserveSelection && this._gesture?.timer) {
			const selection = String(global.getSelection?.() ?? "");
			if (selection !== "") {
				clearTimeout(this._gesture.timer);
				this._gesture = null;
				this.log("pending edit cancelled after copy");
				return;
			}
		}

		if (!this.cancelEditOnCopy || !this._recentEdit) return;

		// Expired window: drop tracking, act on nothing.
		const window = this.copyCancelWindow;
		if (window > 0 && Date.now() - this._recentEdit.at > window) {
			this._recentEdit = null;
			this.log("copy tracking expired");
			return;
		}

		// Use e.code (physical key), not e.key: on a non-Latin layout (e.g.
		// Russian) Ctrl+C reports e.key as "с" (Cyrillic), not "c".
		if (!isCopy) {
			// Any other real action means the user is editing — stop tracking.
			this._recentEdit = null;
			this.log("copy tracking stopped: other key", { code: e.code });
			return;
		}

		const selection = String(global.getSelection?.() ?? "");
		this.log("copy key detected", {
			hasSelection: selection !== "",
			selectionSample: this.vis(selection.slice(0, 40)),
			endEditType: typeof this.MessageActions?.endEditMessage
		});

		// Copy with nothing selected copies nothing — leave the editor open.
		if (selection === "") { this.log("copy ignored: no selection"); return; }
		if (typeof this.MessageActions?.endEditMessage !== "function") {
			this.log("copy ignored: endEditMessage unavailable");
			return;
		}

		const { channelId, messageId } = this._recentEdit;
		this._recentEdit = null;
		// Defer so the browser's native copy completes before the DOM changes.
		setTimeout(() => {
			try {
				this.MessageActions.endEditMessage(channelId, messageId);
				this.log("edit closed after copy", { channelId, messageId });
			}
			catch (err) { console.error(config.info?.name, "endEditMessage failed", err); }
		}, 0);
	};

	// Length of `text` ignoring zero-width placeholders Slate inserts on empty
	// lines (U+FEFF byte-order mark, U+200B zero-width space).
	visibleLength(text) {
		let n = 0;
		for (const ch of text) {
			const c = ch.charCodeAt(0);
			if (c !== 0xFEFF && c !== 0x200B) n++;
		}
		return n;
	}

	// Shrink [start, end) inward past leading/trailing whitespace in `text`.
	trimOffsets(text, { start, end }) {
		while (start < end && /\s/.test(text[start])) start++;
		while (end > start && /\s/.test(text[end - 1])) end--;
		return { start, end };
	}

	// Absolute char offsets of the current selection within contentEl's text.
	getSelectionOffsets(contentEl) {
		const selection = global.getSelection?.();
		if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
		const range = selection.getRangeAt(0);
		if (!contentEl.contains(range.startContainer) || !contentEl.contains(range.endContainer))
			return null;

		const start = this.offsetOfPoint(contentEl, range.startContainer, range.startOffset);
		const end = this.offsetOfPoint(contentEl, range.endContainer, range.endOffset);
		if (start == null || end == null) return null;
		return { start, end };
	}

	// Absolute textContent offset of a DOM point (container, offset) within root.
	// Works whether the point sits in a text node (word/char selection) or an
	// element node (a triple-click selecting a whole list item / paragraph, where
	// the boundary lies between child nodes, not inside text).
	offsetOfPoint(root, container, offset) {
		const measure = document.createRange();
		measure.selectNodeContents(root);
		try { measure.setEnd(container, offset); }
		catch { return null; }

		let total = 0, node;
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		while ((node = walker.nextNode())) {
			if (measure.comparePoint(node, 0) === 1) break; // node starts after point
			if (measure.comparePoint(node, node.length) === 1) {
				// The point falls inside this text node (only when it's the endpoint).
				total += (measure.endContainer === node) ? measure.endOffset : 0;
				break;
			}
			total += node.textContent.length; // node fully before the point
		}
		return total;
	}

	// Remove line-level markdown prefixes the renderer drops entirely:
	//   "-# " subtext, "# ".."### " headers, "> "/">>> " quotes, and list items
	//   (optionally indented): "- ", "* ", "1. ". Order matters: "-# " before "- ".
	// Returns the cleaned text plus map[cleanedIndex] = rawIndex (length + 1),
	// so cleaned offsets can be composed back to real raw offsets.
	stripLinePrefixes(raw) {
		const prefix = /^(>>> |> |#{1,3} |-# | *(?:[-*] |\d+\. ))/;
		let text = "";
		const map = [];
		let atLineStart = true;
		let i = 0;
		while (i < raw.length) {
			if (atLineStart) {
				const m = raw.slice(i).match(prefix);
				if (m) { i += m[0].length; continue; } // drop prefix, emit nothing
				atLineStart = false;
			}
			map.push(i);       // cleaned index -> raw index
			text += raw[i];
			if (raw[i] === "\n") atLineStart = true;
			i++;
		}
		map.push(raw.length);  // trailing position for end offsets
		return { text, map };
	}

	// Map every rendered-text index to a raw-markdown index by greedy character
	// alignment: walk both strings in lock-step, skipping raw markdown syntax
	// (chars the renderer dropped) until the current rendered char matches.
	// Returns an array `map` of length renderedText.length + 1.
	buildOffsetMap(rendered, raw) {
		const map = new Array(rendered.length + 1);
		// Only skip over characters markdown actually uses as syntax. This stops
		// the aligner from leaping across ordinary text when a char is missing
		// (e.g. an expanded @mention) — in that case we don't advance in raw.
		const syntax = new Set(["*", "_", "~", "|", "`", "[", "]", "(", ")", "\\", ">", "#"]);
		// Rendered textContent drops raw newlines and collapses runs of
		// whitespace, so a whitespace mismatch in raw must also be skippable.
		const skippable = (c) => syntax.has(c) || /\s/.test(c);
		let j = 0;
		for (let i = 0; i < rendered.length; i++) {
			const ch = rendered[i];
			let k = j;
			while (k < raw.length && raw[k] !== ch && skippable(raw[k])) k++;
			if (k < raw.length && raw[k] === ch) {
				map[i] = k;
				j = k + 1;
			}
			else {
				// No aligned match at this position (char absent from raw, e.g. a
				// mention/emoji expansion). Anchor to current raw pos, keep j.
				map[i] = j;
			}
		}
		map[rendered.length] = j;
		return map;
	}

	// Formatting markers (**, __, ~~, ||, *, _, `). Longest first so a greedy
	// scan treats "**" as one token, not two "*".
	static MARKERS = ["***", "**", "__", "~~", "||", "*", "_", "`"];

	// Greedy left-to-right tokenization of every marker occurrence in `raw`.
	tokenizeMarkers(raw) {
		const tokens = [];
		for (let i = 0; i < raw.length;) {
			let matched = null;
			for (const m of BetterDoubleClickToEdit.MARKERS) {
				if (raw.startsWith(m, i)) { matched = m; break; }
			}
			if (matched) { tokens.push({ pos: i, len: matched.length, m: matched }); i += matched.length; }
			else i++;
		}
		return tokens;
	}

	// Two goals, matching the user's rule "either both marker sides, or only the
	// innards":
	//   1. Trim markers hugging the edges  -> "**word**" selected -> "word".
	//   2. Balance markers the selection cut in half. When the boundary splits a
	//      pair (e.g. "**" opens outside-left but closes inside), expand the edge
	//      to swallow the partner so the pair stays whole and formatting survives
	//      typing over it -> "untick** the" becomes "**untick** the".
	refineRawRange(raw, start, end) {
		const markers = BetterDoubleClickToEdit.MARKERS;
		start = Math.max(0, Math.min(start, raw.length));
		end = Math.max(start, Math.min(end, raw.length));

		// 1. Trim whole markers sitting flush against either edge.
		let changed = true;
		while (changed && start < end) {
			changed = false;
			for (const m of markers) {
				if (raw.startsWith(m, start) && start + m.length <= end) { start += m.length; changed = true; break; }
			}
			for (const m of markers) {
				if (end - m.length >= start && raw.startsWith(m, end - m.length)) { end -= m.length; changed = true; break; }
			}
		}

		// 2. Balance markers left unpaired inside the range by absorbing the
		//    partner just outside the boundary.
		const tokens = this.tokenizeMarkers(raw);
		changed = true;
		while (changed) {
			changed = false;
			const inside = tokens.filter(t => t.pos >= start && t.pos + t.len <= end);
			for (const m of markers) {
				const count = inside.filter(t => t.m === m).length;
				if (count % 2 === 0) continue; // balanced (or absent)

				// Prefer expanding left to include an opener sitting flush before start.
				const opener = tokens.find(t => t.m === m && t.pos + t.len === start);
				if (opener) { start = opener.pos; changed = true; break; }
				// Otherwise expand right to include a closer flush after end.
				const closer = tokens.find(t => t.m === m && t.pos === end);
				if (closer) { end = closer.pos + closer.len; changed = true; break; }
			}
		}

		return { start, end };
	}

	// data-list-item-id is "chat-messages_<channel>_<message>"
	resolveMessage(messageDiv) {
		const dataIdEl = messageDiv.matches('[data-list-item-id^="chat-messages"]')
			? messageDiv
			: messageDiv.closest('[data-list-item-id^="chat-messages"]');
		const idMatch = dataIdEl?.getAttribute('data-list-item-id')?.match(/chat-messages[_-](\d+)[_-](\d+)/);
		if (idMatch && this.getMessage) {
			const message = this.getMessage(idMatch[1], idMatch[2]);
			if (message) return message;
		}

		const instance = ReactUtils.getInternalInstance(messageDiv);
		if (!instance) return null;
		return Utils.findInTree(instance, m => m?.baseMessage, { walkable })?.baseMessage ??
			Utils.findInTree(instance, m => m?.message, { walkable })?.message;
	}

	// Wait for the inline edit box to mount, then re-apply the raw-offset range.
	transferSelection(messageDiv, rawRange) {
		const container = messageDiv.closest('li') || messageDiv;
		const deadline = Date.now() + 1500;
		const tick = () => {
			const editable = container.querySelector('[role="textbox"], textarea');
			if (editable) {
				// Apply once, then again once Slate has placed its own caret.
				this.applySelectionByOffsets(editable, rawRange.start, rawRange.end);
				setTimeout(() => this.applySelectionByOffsets(editable, rawRange.start, rawRange.end), 60);
				return;
			}
			if (Date.now() < deadline)
				requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	}

	// Select [startOffset, endOffset) of the editor's raw text by walking its
	// text nodes and summing lengths until each offset is reached.
	applySelectionByOffsets(editable, startOffset, endOffset) {
		try {
			if (editable.tagName === "TEXTAREA") {
				const len = editable.value.length;
				editable.focus();
				editable.setSelectionRange(Math.min(startOffset, len), Math.min(endOffset, len));
				return;
			}

			// Slate renders each line as a separate block with no "\n" text node,
			// but raw offsets count one "\n" per line break. Add 1 at each line
			// boundary so the walked position stays aligned with the raw text.
			const lineOf = (n) => n.parentElement?.closest('[data-slate-node="element"]') ?? null;
			const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
			let seen = 0, startNode = null, startNodeOffset = 0, endNode = null, endNodeOffset = 0, node;
			let prevLine;
			while ((node = walker.nextNode())) {
				const line = lineOf(node);
				if (prevLine !== undefined && line !== prevLine)
					seen += 1; // implicit newline between Slate lines
				prevLine = line;

				// Slate fills empty lines with a zero-width placeholder (U+FEFF /
				// U+200B). It has no counterpart in the raw text, so exclude it from
				// the length or every offset past an empty line drifts by one.
				const nodeLength = this.visibleLength(node.textContent);
				if (startNode === null && seen + nodeLength >= startOffset) {
					startNode = node;
					startNodeOffset = Math.max(0, startOffset - seen);
				}
				if (endNode === null && seen + nodeLength >= endOffset) {
					endNode = node;
					endNodeOffset = Math.max(0, endOffset - seen);
					break;
				}
				seen += nodeLength;
			}
			if (!startNode || !endNode) {
				this.log("applySelectionByOffsets: could not locate nodes", {
					startOffset, endOffset, editorText: this.vis(editable.textContent)
				});
				return;
			}

			editable.focus();
			const range = document.createRange();
			range.setStart(startNode, startNodeOffset);
			range.setEnd(endNode, endNodeOffset);
			const sel = global.getSelection();
			sel.removeAllRanges();
			sel.addRange(range);

			// A tall message opens the editor scrolled to the caret/end, leaving an
			// early selection off-screen. Scroll the selection start into view.
			(startNode.parentElement ?? startNode).scrollIntoView?.({ block: "center", inline: "nearest" });

			this.log("applied selection", {
				requestedOffsets: { start: startOffset, end: endOffset },
				editorText: this.vis(editable.textContent),
				resultingSelection: this.vis(String(sel))
			});
		}
		catch (err) {
			console.error(config.info?.name, "applySelectionByOffsets failed", err);
		}
	}

	checkModifier(modifier, event) {
		switch (modifier) {
			case "shift": return event.shiftKey;
			case "ctrl": return event.ctrlKey;
			case "alt": return event.altKey;
			default: return false;
		}
	}
}
