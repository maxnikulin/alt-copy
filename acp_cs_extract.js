/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
/* Copyright (C) 2023 Max Nikulin */

"use strict";

function acpContentScriptExtract(targetElementId) {
	/* `acpContentScriptCopy` contains a copy of `acpErrorToObject`.
	 * Content script functions must be self-contained,
	 * so code duplication is unavoidable.
	 *
	 * Convert `Error` to plain `Object`
	 *
	 * <https://bugzilla.mozilla.org/1835058>
	 * Firefox-113 `scripting.executeScript` throws
	 *
	 *     Error {
	 *         name: "Error",
	 *         message: "Script '<anonymous code>' result is non-structured-clonable data"
	 *     }
	 *
	 * in the case of ex
	 *
	 *     DOMException {
	 *         name: "NotAllowedError",
	 *         message: "Clipboard write was blocked due to lack of user activation.",
	 *     }
	 *
	 * when context menu is invoked using `[Shift+F10]` shortcut instead of mouse click.
	 *
	 * Firefox-102 can not pass to background script even `Error` objects.
	 */
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

	// `value` field is queried to support various non-text elements
	// such as `<meter>`, `<progress>`, and inputs which content
	// is not directly selectable: date and time, color. file, range
	// https://developer.mozilla.org/en-US/docs/Learn/Forms/Other_form_controls#other_form_features

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
	}

	function acpScriptExtract(targetElementId) {
		return acpGetText(targetElementId) || acpGetSelection() || "";
	}

	try {
		return { result: acpScriptExtract(targetElementId) };
	} catch (ex) {
		return { error: acpErrorToObject(ex) };
	}
}
