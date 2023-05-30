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

async function acpExecuteContentScript({tabId, frameId, targetElementId}) {
	try {
		const injectionResult = await browser.scripting.executeScript({
			target: { tabId, frameIds: [ frameId ] },
			func: acpContentScript,
			args: [ targetElementId ],
		});
		if (!Array.isArray(injectionResult) || injectionResult.length !== 1) {
			console.warn(
				"acp: scripting.executeScript returned not an Array(1): %o",
				injectionResult);
			return;
		}
		const scriptResult = injectionResult?.[0];
		const error = scriptResult?.error;
		if (error !== undefined) {
			throw error;
		}
		return scriptResult?.result;
	} catch (ex) {
		console.error("acp: content script error: %o", ex);
	}
}

async function acpCopy(clickData, tab) {
	const { targetElementId, frameId } = clickData;
	let permissionsPromise;
	try {
		if (tab.url && frameId) {
			permissionsPromise = browser.permissions.request({
				permissions: [ "clipboardWrite" ],
				origins: [ tab.url ],
			});
		}
	} catch (ex) {
		console.error("acp: attExecuteContentScript: ignore error: %o", ex);
	}
	// No await should be before `document.execCommand("copy")` otherwise
	// user context action will be lost. That is why the only way to
	// synchronously pass target element ID is to put into the script.
	// So the code can not be run from a content script file.
	
	try {
		let scriptResult = await acpExecuteContentScript(
			{ tabId: tab.id, frameId, targetElementId });
		if (scriptResult) {
			return;
		}
		// Try once more if permissions are granted and early attempt failed.
		if (permissionsPromise && await permissionsPromise) {
			console.error("acp: retrying content script with granted permissions");
			let scriptResult = await acpExecuteContentScript(
				{ tabId: tab.id, frameId, targetElementId });
		}
		if (scriptResult) {
			return;
		}
	} catch (ex) {
		console.error("acp: error while trying content script: %o", ex);
	}
	console.log("acp: fallback to selection text");
	const selection = clickData.selectionText || clickData.linkText ||
		clickData.linkUrl || clickData.srcUrl;
	if (!selection) {
		return;
	}
	try {
		// https://bugzilla.mozilla.org/show_bug.cgi?id=1670252
		// Bug 1670252 navigator.clipboard.writeText rejects with undefined as rejection value
		// Fixed in Firefox-85
		await navigator.clipboard.writeText(acpReplaceSpecial(selection));
	} catch (ex) {
		if (ex === undefined) {
			throw new Error("navigator.clipboard.writeText failed");
		}
		throw ex;
	}
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
