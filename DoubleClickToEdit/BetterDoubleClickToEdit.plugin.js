/**
 * @name BetterDoubleClickToEdit
 * @author Atamol
 * @version 1.0.0
 * @description Double click your own message to quickly edit it.
 * @source https://github.com/Atamol/BetterDiscordPlugins
 */

const { Webpack, Webpack: { Filters }, Data, Utils, ReactUtils, UI } = BdApi,

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

			global.document.addEventListener('dblclick', this.doubleclickFunc);
			global.document.addEventListener('click', this.altClickSuppressor, true);
		}
		catch (err) {
			console.error(config.info?.name, "failed to start", err);
			try { this.stop(); }
			catch (e) { console.error(config.info?.name, "stop after error", e); }
		}
	}

	doubleclickFunc = (e) => this.handler(e);

	// Alt+double-click would otherwise fire Discord's own alt action on the message
	altClickSuppressor = (e) => {
		if (!e.altKey) return;
		if (!(this.doubleClickToEditModifier && this.editModifier === "alt")) return;
		if (!e.target?.closest?.('[data-list-item-id^="chat-messages"]')) return;
		e.stopImmediatePropagation();
		e.preventDefault();
	};

	stop = () => {
		document.removeEventListener('dblclick', this.doubleclickFunc);
		document.removeEventListener('click', this.altClickSuppressor, true);
	};

	getSettingsPanel() {
		return UI.buildSettingsPanel({
			settings: [
				{
					type: "switch",
					id: "doubleClickToEditModifier",
					name: "Enable Edit Modifier",
					note: "Require holding a modifier key while double clicking to edit",
					value: this.doubleClickToEditModifier
				},
				{
					type: "radio",
					id: "editModifier",
					name: "Modifier to hold to edit a message",
					value: this.editModifier,
					options: [
						{ name: "Ctrl", value: "ctrl" },
						{ name: "Shift", value: "shift" },
						{ name: "Alt", value: "alt" }
					]
				}
			],
			onChange: (_category, id, value) => {
				this[id] = value;
				Data.save(config.info.slug, id, value);
			}
		});
	}

	handler(e) {
		if (e.target?.closest?.('textarea, input, [contenteditable="true"]'))
			return;

		if (typeof (e?.target?.className) !== typeof ("") ||
			ignore.some(name => e?.target?.className?.indexOf?.(name) > -1))
			return;

		const messageDiv = e.target.closest(
			'[data-list-item-id^="chat-messages"], ' +
			'article[class*="message"], ' +
			'div[class*="messageContainer"], ' +
			'li > div[class*="message"], ' +
			'li[class*="message"]'
		);
		if (!messageDiv)
			return;
		if (this.selectedClass && messageDiv.classList.contains(this.selectedClass))
			return;

		if (this.doubleClickToEditModifier && !this.checkModifier(this.editModifier, e))
			return;

		const message = this.resolveMessage(messageDiv);
		if (!message || message.author.id !== this.CurrentUserStore.getCurrentUser().id)
			return;

		this.MessageActions.startEditMessage(message.channel_id, message.id, message.content);
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

	checkModifier(modifier, event) {
		switch (modifier) {
			case "shift": return event.shiftKey;
			case "ctrl": return event.ctrlKey;
			case "alt": return event.altKey;
			default: return false;
		}
	}
}
