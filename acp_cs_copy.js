/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
/* Copyright (C) 2023 Max Nikulin */

"use strict";

async function acpContentScriptCopy(text) {
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

	function acpCopyUsingEvent(text) {
		// A page might install a handler earlier
		let handlerInvoked = false;

		function acpOnCopy(evt) {
			try {
				evt.stopImmediatePropagation();
				evt.preventDefault();
				evt.clipboardData.clearData();
				evt.clipboardData.setData("text/plain", text);
			} catch (ex) {
				console.error("acpOnCopy: %o", ex);
			}
			handlerInvoked = true;
		}

		let result;
		const listenerOptions = { capture: true };
		try {
			window.addEventListener("copy", acpOnCopy, listenerOptions);
			result = document.execCommand("copy");
		} finally {
			window.removeEventListener("copy", acpOnCopy, listenerOptions);
		}

		if (!result) {
			console.log("acp: Copy using command and event listener failed");
		} else if (!handlerInvoked) {
			console.log("acp: Page overrides copy handler");
		}
		return result && handlerInvoked;
	}

	async function acpScriptCopy(text) {
		// Setting `document.oncopy` can not overwrite `copy` event listener installed
		// earlier by the web page. `navigator.clipboard.writeText` is not succeptible
		// to this problem but it is an asynchronous function, so if it is tried
		// at first then copy using `copy` event runs out of user action context.
		if (acpCopyUsingEvent(text)) {
			return "COPY_EVENT_SUCCESS";
		}
		if (!navigator.clipboard) {
			return false;
		}
		try {
			await navigator.clipboard.writeText(text)
			return "NAVIGATOR_CLIPBOARD_SUCCESS";
		} catch(ex) {
			console.error(
				"acp: navigator.clipboard.writeText failed: %o",
				ex || "navigator.clipboard.writeText failed");
			throw error;
		};
	}
	try {
		return { result: await acpScriptCopy(text) };
	} catch (ex) {
		return { error: acpErrorToObject(ex) };
	}
}
