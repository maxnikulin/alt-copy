/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
/* Copyright (C) 2023 Max Nikulin */

"use strict";

async function acpContentScript(targetElementId) {
	// `value` field is queried to support various non-text elements
	// such as `<meter>`, `<progress>`, and inputs which content
	// is not directly selectable: date and time, color. file, range
	// https://developer.mozilla.org/en-US/docs/Learn/Forms/Other_form_controls#other_form_features

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

	function acpGetValue(element) {
		const value = element && element.value;
		if (value !== null && value !== undefined && value !== "") {
			return String(value);
		}
		return element && element.getAttribute && element.getAttribute("value") || "";
	}

	function acpGetText(elementId) {
		if (elementId == null) {
			console.warn("acp: no element ID specified");
			return;
		}
		const element = browser.menus.getTargetElement(elementId);
		if (element == null) {
			console.warn("acp: no element found");
			return;
		}
		const nodeName = element.nodeName.toUpperCase();
		let text;
		if (nodeName === "OPTGROUP") {
			text = element.getAttribute("label");
		}
		if (text) {
			return text;
		}
		const withInnerText = ["OPTION", "PROGRESS", "METER", "BUTTON"];
		if (
			withInnerText.indexOf(nodeName) >= 0 ||
			(nodeName === "INPUT" && (element.type || "").toUpperCase() === "RANGE")
		) {
			// consider all selected options since "OPTION" likely means <select multiple>
			const mainValue = [];
			const inner = element.innerText;
			if (inner) {
				mainValue.push(inner);
			}
			const value = acpGetValue(element);
			if (value && value !== inner) {
				mainValue.push(value)
			}
			text = mainValue.join(": ");
			if (nodeName !== "INPUT") {
				// Suitable for range or meter, likely just noise for inputs.
				const min = element.getAttribute("min") || "";
				const max = element.getAttribute("max") || "";
				if (min || max) {
					text = (text || "-") + "/" + min + "…" + max;
				}
			}
		}
		if (text) {
			return text;
		}
		if (nodeName === "SELECT") {
			// Likely loop is not necessary since <option> is selected for "multiple",
			// so it is enough to inspect element.selectedIndex.
			const selected = [];
			for (const opt of element.options) {
				if (!opt.selected) {
					continue;
				}
				const value = acpGetValue(opt);
				// opt.textContent may preserve excessive spaces
				const label = opt.innerText;
				selected.push(value && value !== label ? value + ":" + label : label);
			}
			text = selected.join(", ");
		}
		if (text) {
			return text;
		}
		for (const attr of ["title", "alt", "placeholder"]) {
			if ((text = element.getAttribute(attr))) {
				return text;
			}
		};
		const valuable = ["INPUT", "DATA", "TIME"];
		if (valuable.indexOf(nodeName) >= 0) {
			text = acpGetValue(element);
			if (text) {
				return text;
			}
		}

		// <time> and https://github.com/github/time-elements extensions
		const timeElements = [ "time", "relative-time", "local-time", "time-until", "time-ago" ];
		if (timeElements.indexOf(nodeName.toLowerCase()) >= 0) {
			text = element.getAttribute("datetime");
		}
		if (text) {
			return text;
		}

		const cssUserSelect = window.getComputedStyle(element).userSelect;
		if (cssUserSelect && cssUserSelect.toLowerCase && cssUserSelect.toLowerCase() === "none") {
			text = element.innerText;
		}
		if (text) {
			return text;
		}
		console.warn("acp: no text attributes in %o", element);
		return undefined;
	}

	function acpGetSelection() {
		const selection = window.getSelection();
		return selection && !selection.isCollapsed && selection.toString() || undefined;
		return undefined;
	}

	// It is better to avoid control characters since they
	// could be accidentally pasted into terminal without proper protection.
	// https://flask.palletsprojects.com/en/2.0.x/security/#copy-paste-to-terminal
	// Copy/Paste to Terminal (in Security Considerations)
	// https://security.stackexchange.com/questions/39118/how-can-i-protect-myself-from-this-kind-of-clipboard-abuse
	// How can I protect myself from this kind of clipboard abuse?
	//
	// 1. Replace TAB with 8 spaces to avoid accidental activation of completion
	//    if pasted to bash (dubious).
	// 2. Other control characters should be replaced.
	//    U+FFFD REPLACEMENT CHARACTER
	//    used to replace an unknown, unrecognized or unrepresentable character
	// 3. U+FEFF BYTE ORDER MARK that is likely trash in HTML files
	//    been a space character it may not occupy space in applications.
	//    Maybe there are more similar characters.
	//
	// Unsure whether newlines \r and \n should be normalized. 
	// Hope new macs uses "\n", not "\r". `runtime.getPlatformInfo()` `os`
	// field may be used as a hint.
	function acpReplaceSpecial(text) {
		return text.replace(/\t/g, '        ').
			replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F-\x9F\uFEFF]/g, "\uFFFD");
	}

	async function acpAction(targetElementId) {
		let text = acpGetText(targetElementId) || acpGetSelection();
		if (!text) {
			// Suppress retry with granted permissions.
			return "NO_TEXT_FOUND";
		}
		text = acpReplaceSpecial(text);
		// console.log("acp: copy %o", JSON.stringify(text)); // debug

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
			// Firefox-113 `scripting.executeScript` throws
			//
			//     Error {
			//         name: "Error",
			//         message: "Script '<anonymous code>' result is non-structured-clonable data"
			//     }
			//
			// in the case of ex
			//
			//     DOMException {
			//         name: "NotAllowedError",
			//         message: "Clipboard write was blocked due to lack of user activation.",
			//     }
			//
			// when context menu is invoked using `[Shift+F10]` shortcut instead of mouse click.
			const error = new Error(ex.message);
			error.stack = ex.stack;
			// ignored
			error.name = ex.constructor?.name ?? ex.name;
			throw error;
		};
	}

	return await acpAction(targetElementId);
}
