/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
/* Copyright (C) 2021-2023 Max Nikulin */

"use strict";

function acpMenusCreate() {
	browser.menus.create(
		{
			// TODO consider explicit list "page", "video", etc.
			contexts: [ "all" ],
			enabled: true,
			id: "ACP_COPY",
			title: "Copy alt te&xt",
		},
		function acpMenusCreateCallback() {
			if (browser.runtime.lastError) {
				console.error("acpCreateMenu: %o", browser.runtime.lastError);
			}
		}
	);
}

async function acpExecuteContentScript(injectionTarget) {
	try {
		const resultArray
			= await browser.scripting.executeScript(injectionTarget);
		if (!Array.isArray(resultArray) || resultArray.length !== 1) {
			console.warn(
				"acp: scripting.executeScript(%): returned not an Array(1): %o",
				injectionTarget, resultArray);
			return { error: new TypeError("Unexpected executeScript return value") };
		}
		const injectionResult = resultArray?.[0];
		if (injectionResult === undefined) {
			// https://bugzilla.mozilla.org/1824901
			// "WebExtensions scripting.executeScript() returns [undefined] array for about:debugging page"
			return { error: new Error("Content script injection failed: privileged content") };
		}
		const error = injectionResult?.error;
		if (error !== undefined) {
			return { error };
		}
		const scriptResult = injectionResult?.result;
		if (
			scriptResult != null
			&& ("result" in scriptResult) || ("error" in scriptResult)
		) {
			return scriptResult;
		} else {
			console.warn("acp: content script return value is not result/error object: %o", scriptResult);
			return { result: scriptResult };
		}
	} catch (ex) {
		return { error: ex };
	}
}

async function acpExtractAndCopy(clickData, tab) {
	const { targetElementId, frameId } = clickData;
	const target = { tabId: tab.id, frameIds: [ frameId ] };
	let selection;
	try {
		const extractRetval = await acpExecuteContentScript({
			target,
			func: acpContentScriptExtract,
			args: [ targetElementId ?? null ],
		});
		selection = extractRetval.result;
		if (selection == null) {
			console.log("acpContentScriptExtract: %o", extractRetval);
		}
	} catch (ex) {
		console.error("acp: error while trying content script: %o", ex);
	}
	if (!selection) {
		console.log("acp: fallback to selection text");
		selection = clickData.selectionText || clickData.linkText ||
			clickData.linkUrl || clickData.srcUrl;
	}
	if (!selection) {
		console.log("acp: Nothing extracted");
		return;
	}
	selection = acpReplaceSpecial(selection);
	try {
		const copyRetval = await acpExecuteContentScript({
			target,
			func: acpContentScriptCopy,
			args: [ selection ],
		});
		const copyResult = copyRetval.result;
		if (copyResult) {
			return "CONTENT_SCRIPT";
		} else {
			console.log("acpContentScriptCopy: %o", copyRetval);
		}
	} catch (ex) {
		console.error("acp: error while trying content script: %o", ex);
	}
	try {
		// https://bugzilla.mozilla.org/show_bug.cgi?id=1670252
		// Bug 1670252 navigator.clipboard.writeText rejects with undefined as rejection value
		// Fixed in Firefox-85
		await navigator.clipboard.writeText(selection);
		return "BACKGROUND_NAVIGATOR_CLIPBOARD";
	} catch (ex) {
		console.warn("acp: navigator.clipboard.writeText failed: %o", ex);
	}
}

async function acpCopy(clickData, tab) {
	let permissionsPromise;
	try {
		if (tab.url && clickData.frameId) {
			permissionsPromise = browser.permissions.request({
				permissions: [ "clipboardWrite" ],
				origins: [ tab.url ],
			});
		}
	} catch (ex) {
		console.error("acp: attExecuteContentScript: ignore error: %o", ex);
	}
	if (await acpExtractAndCopy(clickData, tab)) {
		return;
	}
	
	// Try once more if permissions are granted and early attempt failed.
	if (permissionsPromise) {
		if (!(await permissionsPromise)) {
			console.log("acp: permission request declined");
			return;
		}
		console.log("acp: retrying content script with granted permissions");
		if (await acpExtractAndCopy(clickData, tab)) {
			return;
		}
	}
	throw new Error("Failed to copy");
}

function acpReplaceSpecial(text) {
	return text.replace(/\t/g, '        ').
		replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F-\x9F\uFEFF]/g, "\uFFFD");
}

function acpMenusListener(clickData, tab) {
	/* Call async function through a synchronous wrapper to get error
	 * in extension developer tools in Firefox that otherwise reported
	 * to browser console only. Is a workaround for:
	 * https://bugzilla.mozilla.org/1398672
	 * "1398672 - Add test for better logging of exceptions/rejections from async event"
	 */
	switch (clickData.menuItemId) {
		case "ACP_COPY":
			acpCopy(clickData, tab).catch(ex => {
				console.log(
					"acpExecuteContentScript(%o, %o): exception",
					clickData, tab);
				throw ex;
			});
			break;
		default:
			console.error(
				"acpMenusListener: unknown menu item: %o %o",
				clickData.menuItemId, clickData);
	}
}

function acpMain() {
	// Do not use
	//
	//     browser.runtime.onInstalled.addListener(acpMenusCreate);
	//
	// recommended in Chromium docs. It requires
	//
	//     { "background": { "persistent": false } }
	//
	// in `manifest.json`, however Firefox does not support event pages,
	// so menu entries should be created each time when add-on is loading.
	acpMenusCreate();
	browser.menus.onClicked.addListener(acpMenusListener);
}

acpMain();
