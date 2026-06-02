/**
 * @name DoubleClickToReply
 * @author Atamol
 * @version 1.0.0
 * @description Double click someone else's message to quickly start replying to it.
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


module.exports = class DoubleClickToReply {

	constructor(meta) { config.info = meta; }

	start() {
		try {
			this.selectedClass = Webpack.getModule(Filters.byKeys("message", "selected"))?.selected;

			const messageStore = Webpack.getModule(Filters.byKeys("getMessage", "getMessages"));
			this.getMessage = messageStore?.getMessage?.bind(messageStore);
			this.CurrentUserStore = Webpack.getModule(Filters.byKeys("getCurrentUser"));
			this.ChannelStore = Webpack.getModule(Filters.byKeys("getChannel", "getDMFromUserId"));
			// Keep module + key, not the function value, so NoReplyPing's patch on the key is seen
			const reply = this.getModuleAndKey(Filters.byStrings('type:"CREATE_PENDING_REPLY"'));
			this.replyModule = reply?.[0];
			this.replyKey = reply?.[1];

			if (!this.replyModule || !this.replyKey || !this.ChannelStore?.getChannel) {
				UI.showToast?.(`${config.info.name}: a Discord module changed, plugin needs an update`, { type: "error" });
				return;
			}

			this.doubleClickToReplyModifier = Data.load(config.info.slug, "doubleClickToReplyModifier") ?? false;
			this.replyModifier = Data.load(config.info.slug, "replyModifier") ?? "shift";

			global.document.addEventListener('dblclick', this.doubleclickFunc);
			global.document.addEventListener('click', this.altClickSuppressor, true);
		}
		catch (err) {
			console.error(config.info?.name, "failed to start", err);
			try { this.stop(); }
			catch (e) { console.error(config.info?.name, "stop after error", e); }
		}
	}

	getModuleAndKey(filter) {
		let mod;
		const value = Webpack.getModule((e, m) => (filter(e) ? (mod = m) : false), { searchExports: true });
		if (!mod) return null;
		const key = Object.keys(mod.exports).find(k => mod.exports[k] === value);
		return key ? [mod.exports, key] : null;
	}

	doubleclickFunc = (e) => this.handler(e);

	// Alt+double-click would otherwise fire Discord's own alt action on the message
	altClickSuppressor = (e) => {
		if (!e.altKey) return;
		if (!(this.doubleClickToReplyModifier && this.replyModifier === "alt")) return;
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
					id: "doubleClickToReplyModifier",
					name: "Enable Reply Modifier",
					note: "Require holding a modifier key while double clicking to reply",
					value: this.doubleClickToReplyModifier
				},
				{
					type: "radio",
					id: "replyModifier",
					name: "Modifier to hold to reply to a message",
					value: this.replyModifier,
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

		if (this.doubleClickToReplyModifier && !this.checkModifier(this.replyModifier, e))
			return;

		const message = this.resolveMessage(messageDiv);
		if (!message)
			return;
		// Skip own messages so this doesn't double-fire with BetterDoubleClickToEdit
		if (message.author?.id === this.CurrentUserStore?.getCurrentUser?.()?.id)
			return;

		const channel = this.ChannelStore.getChannel(message.channel_id);
		if (!channel)
			return;

		this.replyModule[this.replyKey]({
			channel,
			message,
			shouldMention: true,
			showMentionToggle: channel.guild_id != null
		});
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
