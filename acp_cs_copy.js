/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
/* Copyright (C) 2023 Max Nikulin */

"use strict";

async function acpContentScriptCopy(ctxParams, text) {
	// See `acpContentScriptExtract` for details.
	// Content script functions must be self-contained,
	// so code duplication is unavoidable.
	function acpErrorToObject(error) {
		try {
			if (error == null || typeof error === "string") {
				return error;
			} else if (typeof error.message !== "string") {
				return {
					string: String(error),
					objectToString: Object.prototype.toString.call(error),
				};
			}
			const { name, message, fileName, lineNumber, columnNumber } = error;
			return {
				name, message, fileName, lineNumber, columnNumber,
				constructorName: error.constructor?.name
			};
		} catch (ex) {
			console.error(ex);
			return String(ex);
		}
	}

	/* `document.execCommand("copy")` may be cancelled
	 * by a `window` `copy` event listener added by a web page
	 * with `{capture: true}` option. Since `clipboardchange` event
	 * <https://w3c.github.io/clipboard-apis/#clipboard-event-clipboardchange>
	 * has not implemented by browsers, `navigator.clipboard.writeText`
	 * should be more reliable and thus should be tried first.
	 *
	 * While `browser.permissions.request` requires no `await` expression
	 * before its call due to https://bugzilla.mozilla.org/1398833
	 * clipboard permission is granted for ~5 seconds in response to user action.
	 * The timeout counts from opening content menu
	 * in Firefox-102 ESR and from selection menu item in Firefox-113.
	 * `[Menu]` or `[Shift + F10]` keyboard shortcuts is considered
	 * as user activation in Firefox-113, but not in Firefox-102 ESR.
	 * Both copy command and `clipboard.writeEvent` methods are affected
	 * by user action context timeout.
	 *
	 * So there is no reason to prefer synchronous
	 * `document.execCommand("copy")` (that may cause arbitrary delay
	 * in the case of an event listener added by the page)
	 * to `async` `navigator.clipboard`. Use Editing API as a fallback
	 * for insecure pages where Clipboard API is unavailable.
	 *
	 * The statement above is not true in Chrome
	 * where a permission request popup may appear, see
	 * https://crbug.com/1382608 (WontFix)
	 * "WebExtension Content Script: navigator.clipboard triggers permission dialog"
	 * So `offscreen` API should be used till `navigator.clipboard` API
	 * will be made available for extension service worker.
	 */
	async function acpCopyNavigator (text) {
		const log = [];
		const method = "navigator.clipboard.writeText";
		try {
			if (navigator.clipboard != null) {
				await navigator.clipboard.writeText(text);
				log.push({ result: true, method });
			} else {
				log.push({
					method,
					error: "Undefined navigator.clipboard, likely insecure context",
				});
			}
		} catch (ex) {
			log.push({ method, error: acpErrorToObject(ex) });
		}
		return log;
	}

	function acpMakeRestoreSelection(log) {
		const ranges = [];
		try {
			const selection = window.getSelection();
			const { rangeCount } = selection;
			for (let i = 0; i < rangeCount; ++i) {
				ranges.push(selection.getRangeAt(i).cloneRange());
			}
		} catch(ex) {
			Promise.reject(ex);
			log?.push?.({ method: "saveSelection", error: acpErrorToObject(ex) });
		}
		return function acpRestoreSelection(ranges, log) {
			try {
				const selection = window.getSelection();
				selection.removeAllRanges();
				for (const r of ranges) {
					selection.addRange(r);
				}
			} catch(ex) {
				Promise.reject(ex);
				log?.push?.({ method: "saveSelection", error: acpErrorToObject(ex) });
			}
		}.bind(undefined, ranges, log);
	}

	function acpMakeTempInput(log) {
		try {
			const input = document.createElement("textarea");
			input.style.position = "absolute";
			input.style.left = "-9999px";
			input.style.top = "-9999px";
			input.style.height = "1px";
			input.style.zIndex = "-1";
			return input;
		} catch (ex) {
			Promise.reject(ex);
			log?.push({ method: "acpMakeTempInput", error: acpErrorToObject(ex) });
		}
	}

	// `async` just to satisfy `AbortableContext.abortable` requiring a promise argument.
	async function acpCopyUsingEvent(text) {
		const log = [];
		const entry = { method: 'document.execCommand("copy")' };
		/* If a frame is focused then the `copy` event is fired in that frame,
		 * not in the current `window`. Use fallback to a temporary input field
		 * that causes lost of the active element in the subframe.
		 */
		let active, tempInput;
		try {
			active = document.activeElement;
			const node = active?.nodeName?.toUpperCase?.();
			// It seems, `<video>` is not affected.
			tempInput = [ "FRAME", "IFRAME", "EMBED", "OBJECT" ].indexOf(node) >= 0;
		} catch (ex) {
			log.push({ ...entry, error: acpErrorToObject(ex) });
		}

		let listenerInvoked;
		let listenerCompleted;
		function acpOnCopy(evt) {
			listenerInvoked = true;
			try {
				evt.stopImmediatePropagation();
				evt.preventDefault();
				evt.clipboardData.clearData();
				evt.clipboardData.setData("text/plain", text);
				listenerCompleted = true;
			} catch (ex) {
				console.error("acpOnCopy: %o", ex);
				log.push({ ...entry, error: acpErrorToObject(ex) });
			}
		}

		try {
			const listenerOptions = { capture: true };
			let commandResult;
			let input, restoreSelection;
			try {
				if (tempInput) {
					restoreSelection = acpMakeRestoreSelection(log);
					input = acpMakeTempInput(log);
					if (input != null) {
						input.value = text;
						document.body.appendChild(input);
						// input.focus(); // It seems it is not necessary
						input.select();
					}
				}
				window.addEventListener("copy", acpOnCopy, listenerOptions);
				commandResult = document.execCommand("copy");
			} finally {
				window.removeEventListener("copy", acpOnCopy, listenerOptions);
				// Frame becomes focused, but its active element is lost.
				active?.focus();
				restoreSelection?.();
				if (input !== undefined) {
					document.body.removeChild(input);
				}
			}

			if (!commandResult) {
				console.log("acp: Copy command failed");
				log.push({ ...entry, error: "Copy command failed" });
			} else if (!listenerInvoked) {
				console.log("acp: Page overrides copy handler");
				log.push({ ...entry, error: "Copy event blocked" });
			} else if (!listenerCompleted) {
				console.log("acp: copy event listener has not completed");
				log.push({ ...entry, error: "Listener of copy event has not completed" });
			} else {
				log.push({ ...entry, result: true });
			}
		} catch (ex) {
			console.warn("acp: copy using command: %o", ex);
			log.push({ ...entry, error: acpErrorToObject(ex) });
		}
		return log;
	}

	const retval = { result: false, log: [] };
	async function acpCsCopy(ctx, text) {
		for (const func of [ acpCopyNavigator, acpCopyUsingEvent ]) {
			try {
				const entries = await ctx.abortable(func(text));
				if (!(Array.isArray(entries) && entries.length > 0)) {
					throw new TypeError("Unexpected return value from " + func.name);
				}
				retval.log.push(...entries);
				if (entries[entries.length - 1]?.result === true) {
					retval.result = true;
					break;
				}
			} catch (ex) {
				// Firefox-102 does not allow to get `stack` in the case of `Promise.reject`.
				console.warn("acpContentScriptCopy: %o: %o", func?.name, ex);
				retval.log.push({ error: acpErrorToObject(ex) });
			}
		}
	}
	return {
		...await mwel.csAbortableRun(ctxParams, ctx => acpCsCopy(ctx, text)),
		...retval,
	};
	//# sourceURL=acp_cs_copy_func.js
}
